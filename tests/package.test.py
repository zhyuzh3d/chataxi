"""Packaging regressions run against an isolated temporary runtime."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("chataxi_package", pathlib.Path(__file__).parents[1] / "tools/package.py")
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)

# 声明清单是**夹具**，刻意不用真正的品牌名与 happId：release_info() / build_record() /
# check_declared() 里只要有一处把产品名或 happId 写死，下面那几条断言就会当场变红。
DECLARED = {
    "schema": 2,
    "happId": "life.airen.fixture",
    "name": "Fixture",
    "author": "fixture",
    "version": {"code": 7, "name": "test"},
}


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_root = PACKAGE.ROOT
        PACKAGE.ROOT = pathlib.Path(self.temp.name)
        for folder in ("app", "styles", "docs"):
            (PACKAGE.ROOT / folder).mkdir()
        (PACKAGE.ROOT / "index.html").write_text("<!doctype html><title>fixture</title>")
        (PACKAGE.ROOT / "haminn.json").write_text(json.dumps(DECLARED))
        (PACKAGE.ROOT / "guid.md").write_text("# guid fixture\n")
        (PACKAGE.ROOT / "app/app.js").write_text("'use strict';")
        (PACKAGE.ROOT / "app/assets").mkdir()
        (PACKAGE.ROOT / "app/assets/icon.webp").write_bytes(b"RIFFfixtureWEBP")
        (PACKAGE.ROOT / "styles/app.css").write_text("body { margin: 0; }")
        (PACKAGE.ROOT / "docs/private.txt").write_text("not runtime")
        self.relative, self.output = PACKAGE.release_info(DECLARED)
        self.record = PACKAGE.build_record(DECLARED, "fixture", None, self.output)
        digest = PACKAGE.build(self.output, {PACKAGE.BUILD_NAME: PACKAGE.encode_record(self.record)})
        PACKAGE.write_install_manifest(self.relative, digest)

    def tearDown(self):
        PACKAGE.ROOT = self.previous_root
        self.temp.cleanup()

    def entries(self):
        with PACKAGE.zipfile.ZipFile(self.output) as archive:
            return archive.namelist()

    def repack(self, extra=None):
        """用另一份自述（或根本没有自述）重新封口。

        build() 拒绝覆盖"同名但内容不同"的包 —— 那是它防止版本号没升就重打的护栏，
        所以这里先删掉旧包；封口之后安装清单里的指纹也跟着变了，必须一起重写，
        否则 verify 会先撞上"清单与包对不上"，永远走不到 check_declared 那几条。
        """
        self.output.unlink()
        digest = PACKAGE.build(self.output, extra)
        PACKAGE.write_install_manifest(self.relative, digest)

    def test_archive_matches_sources_and_excludes_docs(self):
        PACKAGE.verify(self.relative, self.output, DECLARED)
        with PACKAGE.zipfile.ZipFile(self.output) as archive:
            self.assertNotIn("docs/private.txt", archive.namelist())
            self.assertIn("guid.md", archive.namelist())
            self.assertEqual(archive.read("app/assets/icon.webp"), b"RIFFfixtureWEBP")

    def test_check_detects_modified_source_content(self):
        (PACKAGE.ROOT / "app/app.js").write_text("'changed';")
        with self.assertRaisesRegex(SystemExit, "content mismatch"):
            PACKAGE.verify(self.relative, self.output, DECLARED)

    def test_existing_version_cannot_be_replaced(self):
        digest = PACKAGE.sha256(self.output)
        (PACKAGE.ROOT / "app/app.js").write_text("'changed';")
        with self.assertRaisesRegex(SystemExit, "bump the version"):
            PACKAGE.build(self.output)
        self.assertEqual(PACKAGE.sha256(self.output), digest)

    def test_release_name_is_derived_from_the_manifest_name(self):
        # The fixture deliberately does not use the real brand, so a hardcoded
        # product name in release_info() would show up here.
        self.assertEqual(self.relative, "release/Fixture-vtest.zip")

    # --- 包的自述文件（haminn-build.json） ---------------------------------------------------
    # 它进包但**不进运行白名单**：安装方拿到它的唯一用途是在问用户"怎么办"时说出这是谁做的，
    # 而它自称的一切都不被核实（也没法核实）。所以这里一条条钉住"它说了什么"与"它不许说什么"。

    def test_build_record_rides_along_without_joining_the_runtime_allowlist(self):
        self.assertIn(PACKAGE.BUILD_NAME, self.entries(), "自述文件要进包")
        self.assertEqual(self.record["happId"], DECLARED["happId"])
        self.assertEqual(self.record["name"], "Fixture")
        self.assertEqual(self.record["versionName"], "test")
        self.assertEqual(self.record["versionCode"], 7)
        self.assertEqual(self.record["maintainer"], "fixture")
        self.assertNotIn(PACKAGE.BUILD_NAME, [path.relative_to(PACKAGE.ROOT).as_posix() for path in PACKAGE.runtime_files()], "自述文件不是运行时文件：它不能出现在白名单里，否则会被当成该部署的东西")
        PACKAGE.verify(self.relative, self.output, DECLARED)

    def test_repackaging_the_same_version_stays_byte_identical(self):
        # 同一个版本重打一次必须逐字节相同，否则"没改版本就重打"这件事会凭空造出一个新指纹，
        # 而接收方是按指纹认包的。时间戳因此必须沿用旧包里的那个。
        digest = PACKAGE.sha256(self.output)
        again = PACKAGE.build_record(DECLARED, "fixture", None, self.output)
        self.assertEqual(again["packagedAt"], self.record["packagedAt"], "重打要沿用旧包的时间戳")
        PACKAGE.build(self.output, {PACKAGE.BUILD_NAME: PACKAGE.encode_record(again)})
        self.assertEqual(PACKAGE.sha256(self.output), digest)

    def test_a_package_without_a_build_record_still_verifies(self):
        # 自述文件是可选的：它出现之前打好的包依然有效，安装方遇到缺失只是少显示一栏。
        self.repack(None)
        self.assertNotIn(PACKAGE.BUILD_NAME, self.entries())
        PACKAGE.verify(self.relative, self.output, DECLARED)

    def test_record_that_describes_another_package_is_refused(self):
        wrong = dict(self.record, happId="life.airen.other")
        self.repack({PACKAGE.BUILD_NAME: PACKAGE.encode_record(wrong)})
        with self.assertRaisesRegex(SystemExit, "does not describe this package"):
            PACKAGE.verify(self.relative, self.output, DECLARED)

    def test_record_may_not_declare_a_content_fingerprint(self):
        # 父包的指纹只能在父包封口之后才算得出来，对接收方毫无价值 —— 它出现在自述里
        # 只会让一份"自称"看起来像一份"结论"。
        with_fingerprint = dict(self.record, treeHash="deadbeef")
        self.repack({PACKAGE.BUILD_NAME: PACKAGE.encode_record(with_fingerprint)})
        with self.assertRaisesRegex(SystemExit, "must not declare a content fingerprint"):
            PACKAGE.verify(self.relative, self.output, DECLARED)

    def test_record_without_a_usable_maintainer_is_refused(self):
        for name in ("", "   ", "root"):
            with self.subTest(maintainer=name):
                self.repack({PACKAGE.BUILD_NAME: PACKAGE.encode_record(dict(self.record, maintainer=name))})
                with self.assertRaisesRegex(SystemExit, "has no usable maintainer"):
                    PACKAGE.verify(self.relative, self.output, DECLARED)


if __name__ == "__main__":
    unittest.main()
