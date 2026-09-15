#!/usr/bin/env python3
"""Reject credentials in chataxi source, Git snapshots, and release archives."""

from __future__ import annotations

import argparse
import io
import re
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {".git", ".server-state"}
SAFE_MARKERS = (
    "demo",
    "example",
    "fixture",
    "placeholder",
    "redacted",
    "test-only",
    "your-",
    "your_",
    "xxxx",
    "••",
)
HASH_CONTEXT = ("sha-256", "sha256", "checksum", "digest", "integrity", "assetsha256")

PATTERNS = (
    ("private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("provider API key", re.compile(r"\b(?:sk[-_]|xai-|AIza|gh[pousr]_)[A-Za-z0-9_-]{20,}\b")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("GLM-style API key", re.compile(r"\b[0-9a-fA-F]{32}\.[A-Za-z0-9_-]{12,}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("Bearer token", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{24,}")),
)
ASSIGNMENT = re.compile(
    r"(?i)\b(?:api[_ -]?key|access[_ -]?token|secret(?:[_ -]?key)?|password|passwd)\b"
    r"\s*[:=]\s*[\"']([^\"'\r\n]{12,})[\"']"
)
LONG_HEX = re.compile(r"(?<![0-9a-fA-F])[0-9a-fA-F]{48,128}(?![0-9a-fA-F])")


def git(*args: str, input_bytes: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=ROOT, input=input_bytes, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True,
    ).stdout


def is_safe(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in SAFE_MARKERS)


def scan_text(label: str, raw: bytes) -> list[str]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return []
    findings: list[str] = []
    for line_number, line in enumerate(text.splitlines(), 1):
        lowered = line.lower()
        for kind, pattern in PATTERNS:
            for match in pattern.finditer(line):
                if not is_safe(match.group(0)):
                    findings.append(f"{label}:{line_number}: {kind}")
        for match in ASSIGNMENT.finditer(line):
            if not is_safe(match.group(1)):
                findings.append(f"{label}:{line_number}: literal credential assignment")
        if not any(marker in lowered for marker in HASH_CONTEXT):
            for match in LONG_HEX.finditer(line):
                if not is_safe(match.group(0)):
                    findings.append(f"{label}:{line_number}: opaque hexadecimal secret")
    return findings


def scan_blob(label: str, raw: bytes) -> list[str]:
    findings = scan_text(label, raw)
    if label.lower().endswith(".zip") or raw.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                for item in archive.infolist():
                    if not item.is_dir():
                        findings.extend(scan_text(f"{label}!{item.filename}", archive.read(item)))
        except zipfile.BadZipFile:
            findings.append(f"{label}: invalid ZIP archive")
    return findings


def worktree_blobs() -> list[tuple[str, bytes]]:
    blobs = []
    for path in sorted(ROOT.rglob("*")):
        if path.is_file() and not any(part in SKIP_PARTS for part in path.relative_to(ROOT).parts):
            blobs.append((str(path.relative_to(ROOT)), path.read_bytes()))
    return blobs


def staged_blobs() -> list[tuple[str, bytes]]:
    names = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split(b"\0")
    blobs = []
    for name in names:
        if not name:
            continue
        label = name.decode("utf-8", "surrogateescape")
        blobs.append((label, git("show", f":{label}")))
    return blobs


def history_blobs() -> list[tuple[str, bytes]]:
    objects = git("rev-list", "--objects", "--all").decode("utf-8", "replace").splitlines()
    blobs = []
    for row in objects:
        object_id, separator, label = row.partition(" ")
        if not separator or not label:
            continue
        if git("cat-file", "-t", object_id).strip() != b"blob":
            continue
        blobs.append((f"git:{object_id[:12]}:{label}", git("cat-file", "blob", object_id)))
    return blobs


def main() -> int:
    parser = argparse.ArgumentParser()
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--staged", action="store_true")
    scope.add_argument("--all-history", action="store_true")
    args = parser.parse_args()

    blobs = history_blobs() if args.all_history else staged_blobs() if args.staged else worktree_blobs()
    findings: list[str] = []
    for label, raw in blobs:
        findings.extend(scan_blob(label, raw))
    findings = sorted(set(findings))
    if findings:
        print("Secret scan blocked the operation. Review these locations; values are intentionally hidden:", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print(f"Secret scan passed ({len(blobs)} blobs checked).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
