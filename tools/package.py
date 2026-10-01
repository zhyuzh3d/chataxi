#!/usr/bin/env python3
"""Create or verify the deterministic Chataxi happ release ZIP."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import pathlib
import sys
import time
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME_ROOTS = ("index.html", "haminn.json", "guid.md", "app", "styles")
FIXED_TIMESTAMP = (2026, 9, 13, 0, 0, 0)

# What the package says about who built it. Every field here is a claim by the packager: the
# receiving side decides what to do from the content hash it computes itself, and reads this file
# only to show a human who made the thing when asking what to do about it. It is optional — a
# package without it installs and develops normally.
BUILD_NAME = "haminn-build.json"
BUILD_SCHEMA = 1
UNUSABLE_USER_NAMES = frozenset({"root", "unknown", "none", "nobody", "administrator"})
# How far back the "which package was this based on" chain may reach. Truncated, not merged:
# a package must not be able to carry an unbounded ancestry.
BASED_ON_DEPTH = 8
BASED_ON_FIELDS = ("name", "happId", "versionName", "versionCode", "author", "maintainer", "packagedAt")
FINGERPRINT_KEYS = frozenset({"treeHash", "sha256", "hash", "digest", "fingerprint"})

# Editor and operating-system droppings must never reach a shipped archive.
# `.DS_Store` shows up from merely browsing `app/` in Finder, and an unfiltered
# walk would bake it into the release (and into the website copy, which re-uses
# these entry names).
JUNK_NAMES = frozenset({".DS_Store", "Thumbs.db", "desktop.ini"})
JUNK_DIRS = frozenset({"__pycache__", ".vscode", ".idea"})


def is_runtime_file(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    if path.name in JUNK_NAMES or path.name.startswith("._"):
        return False
    return not JUNK_DIRS.intersection(path.relative_to(ROOT).parts)


def runtime_files() -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for relative in RUNTIME_ROOTS:
        target = ROOT / relative
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            files.extend(path for path in target.rglob("*") if is_runtime_file(path))
        else:
            raise SystemExit(f"missing runtime path: {relative}")
    return sorted(files, key=lambda path: path.relative_to(ROOT).as_posix())


def manifest() -> dict:
    return json.loads((ROOT / "haminn.json").read_text(encoding="utf-8"))


def release_info(declared: dict) -> tuple[str, pathlib.Path]:
    relative = f"release/{declared['name']}-v{declared['version']['name']}.zip"
    return relative, ROOT / relative


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- who is making this package -------------------------------------------------------------


def usable_name(name: object) -> bool:
    return (
        isinstance(name, str)
        and bool(name.strip())
        and name.strip().lower() not in UNUSABLE_USER_NAMES
    )


def system_user_name() -> str:
    """The name this machine signs things with, or an empty string when it has none."""
    for candidate in (os.environ.get("USER"), os.environ.get("LOGNAME"), os.environ.get("USERNAME")):
        if candidate and candidate.strip():
            return candidate.strip()
    try:
        return (getpass.getuser() or "").strip()
    except Exception:
        return ""


def ask_for_maintainer() -> str:
    """Nothing usable anywhere: stop and ask, rather than sign the package with a guess.

    A blank or invented name is worse than none at all, because it looks like information.
    """
    if not sys.stdin.isatty():
        raise SystemExit(
            "无法确定更新者姓名：请用 --maintainer 指定，或在 haminn.json 里写 maintainer"
        )
    print("这台机器上拿不到可用的用户名（拿不到登录名，或它只是 root 一类无意义值）。")
    for _ in range(3):
        try:
            answer = input("请写明这次打包的更新者姓名: ")
        except EOFError:
            break
        if usable_name(answer):
            return answer.strip()
        print("这个名字不能用（空、或 root/unknown 一类无意义值），请换一个。")
    raise SystemExit("没有拿到更新者姓名，打包中止")


def resolve_maintainer(declared: dict, override: str | None = None) -> str:
    for candidate in (override, declared.get("maintainer"), system_user_name()):
        if usable_name(candidate):
            return candidate.strip()
    return ask_for_maintainer()


# --- what this package says about where it came from ----------------------------------------


def previous_build_record(output: pathlib.Path) -> dict:
    """What the already-built archive for this very version declares, if anything.

    Reusing it is what keeps repackaging an unchanged version byte-identical: the archive
    determinism check compares hashes, and a fresh timestamp would break it.
    """
    if not output.is_file():
        return {}
    try:
        with zipfile.ZipFile(output) as archive:
            record = json.loads(archive.read(BUILD_NAME).decode("utf-8"))
    except (OSError, KeyError, UnicodeError, json.JSONDecodeError, zipfile.BadZipFile):
        return {}
    return record if isinstance(record, dict) else {}


def trim_chain(record: dict, depth: int) -> dict:
    """Keep only the declared fields, at most `depth` generations back.

    Whitelisting fields is also what keeps content fingerprints out of the package: a parent's
    fingerprint would have to be computed after the parent container was closed, and would be
    worth nothing on the receiving side anyway.
    """
    kept = {name: record[name] for name in BASED_ON_FIELDS if name in record}
    parent = record.get("basedOn")
    if depth > 1 and isinstance(parent, dict):
        kept["basedOn"] = trim_chain(parent, depth - 1)
    return kept


def load_based_on(source: str | None) -> dict | None:
    """The package this work started from, as told by the packager's own record file.

    An explicit `--based-on` that points nowhere is an error; the default location simply
    being absent means the work did not start from somebody else's package.
    """
    if source:
        path = pathlib.Path(source).expanduser()
        if not path.is_file():
            raise SystemExit(f"base package record not found: {path}")
    else:
        path = ROOT / BUILD_NAME
        if not path.is_file():
            return None
    try:
        parent = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(f"cannot read the base package record: {path}")
    if not isinstance(parent, dict):
        raise SystemExit(f"base package record is not an object: {path}")
    return trim_chain(parent, BASED_ON_DEPTH)


def build_record(declared: dict, maintainer: str, based_on: dict | None, output: pathlib.Path) -> dict:
    previous = previous_build_record(output)
    packaged_at = previous.get("packagedAt")
    if not isinstance(packaged_at, str) or not packaged_at:
        packaged_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record = {
        "schema": BUILD_SCHEMA,
        "happId": declared["happId"],
        "name": declared["name"],
        "versionName": declared["version"]["name"],
        "versionCode": declared["version"]["code"],
        "author": declared.get("author"),
        "maintainer": maintainer,
        "packagedAt": packaged_at,
    }
    if based_on:
        record["basedOn"] = based_on
    return record


def encode_record(record: dict) -> bytes:
    return (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


# --- archive --------------------------------------------------------------------------------


def build(output: pathlib.Path, extra: dict[str, bytes] | None = None) -> str:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in runtime_files():
            relative = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
        for name, payload in sorted((extra or {}).items()):
            info = zipfile.ZipInfo(name, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, payload)
    if output.exists():
        if sha256(temporary) != sha256(output):
            temporary.unlink()
            raise SystemExit("versioned archive already exists with different content; bump the version before packaging")
        temporary.unlink()
    else:
        temporary.replace(output)
    return sha256(output)


def write_install_manifest(package_path: str, digest: str) -> None:
    content = {"schema": 1, "package": package_path, "sha256": digest}
    (ROOT / "haminn-install.json").write_text(
        json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def declared_fingerprints(value: object) -> list[str]:
    if isinstance(value, dict):
        found = [key for key in value if key in FINGERPRINT_KEYS]
        return found + [name for item in value.values() for name in declared_fingerprints(item)]
    if isinstance(value, list):
        return [name for item in value for name in declared_fingerprints(item)]
    return []


def check_declared(payload: bytes, declared: dict) -> None:
    """The package's own account must at least be about this package, and must be parseable.

    Nothing here is verified against reality — it cannot be. The point is to keep the file
    honest-looking rather than authoritative.
    """
    try:
        record = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise SystemExit(f"{BUILD_NAME} is not valid JSON")
    if not isinstance(record, dict) or record.get("schema") != BUILD_SCHEMA:
        raise SystemExit(f"{BUILD_NAME} is not a schema-{BUILD_SCHEMA} record")
    if record.get("happId") != declared["happId"] or record.get("versionName") != declared["version"]["name"]:
        raise SystemExit(f"{BUILD_NAME} does not describe this package")
    if not usable_name(record.get("maintainer")):
        raise SystemExit(f"{BUILD_NAME} has no usable maintainer")
    fingerprints = declared_fingerprints(record)
    if fingerprints:
        raise SystemExit(f"{BUILD_NAME} must not declare a content fingerprint: {sorted(set(fingerprints))}")


def verify(package_path: str, output: pathlib.Path, declared: dict) -> None:
    if not output.is_file():
        raise SystemExit(f"release archive missing: {output}")
    install = json.loads((ROOT / "haminn-install.json").read_text(encoding="utf-8"))
    expected = sha256(output)
    if install != {"schema": 1, "package": package_path, "sha256": expected}:
        raise SystemExit("haminn-install.json does not match the release archive")
    if package_path.startswith("/") or any(part in {"", ".", ".."} for part in package_path.split("/")):
        raise SystemExit("install package must be a safe same-origin relative path")
    expected_files = {path.relative_to(ROOT).as_posix() for path in runtime_files()}
    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        if len(names) != len(archive.namelist()):
            raise SystemExit("release archive has duplicate entries")
        # The build record is optional: archives cut before it existed stay valid, and the
        # installer skips it when missing.
        if names - {BUILD_NAME} != expected_files:
            missing = sorted(expected_files - names)
            extra = sorted(names - expected_files - {BUILD_NAME})
            raise SystemExit(f"release file mismatch; missing={missing}, extra={extra}")
        changed = sorted(
            path.relative_to(ROOT).as_posix()
            for path in runtime_files()
            if archive.read(path.relative_to(ROOT).as_posix()) != path.read_bytes()
        )
        if changed:
            raise SystemExit(f"release content mismatch: {', '.join(changed)}")
        if "index.html" not in names or "haminn.json" not in names:
            raise SystemExit("release archive lacks required root files")
        if BUILD_NAME in names:
            check_declared(archive.read(BUILD_NAME), declared)
    print(f"verified {output.relative_to(ROOT)} sha256={expected}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify existing release without changing files")
    parser.add_argument("--maintainer", help="本次打包的更新者姓名，覆盖 haminn.json 与系统用户名")
    parser.add_argument("--based-on", dest="based_on", help=f"本包所基于的包内 {BUILD_NAME} 路径")
    args = parser.parse_args()
    declared = manifest()
    package_path, output = release_info(declared)
    if not args.check:
        record = build_record(
            declared, resolve_maintainer(declared, args.maintainer), load_based_on(args.based_on), output
        )
        digest = build(output, {BUILD_NAME: encode_record(record)})
        write_install_manifest(package_path, digest)
        print(f"created {output.relative_to(ROOT)} sha256={digest} maintainer={record['maintainer']}")
    verify(package_path, output, declared)


if __name__ == "__main__":
    main()
