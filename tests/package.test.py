"""Packaging regressions run against an isolated temporary runtime."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("chataxi_package", pathlib.Path(__file__).parents[1] / "tools/package.py")
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_root = PACKAGE.ROOT
        PACKAGE.ROOT = pathlib.Path(self.temp.name)
        for folder in ("app", "styles", "docs"):
            (PACKAGE.ROOT / folder).mkdir()
        (PACKAGE.ROOT / "index.html").write_text("<!doctype html><title>fixture</title>")
        (PACKAGE.ROOT / "haminn.json").write_text(json.dumps({"name": "Fixture", "version": {"name": "test"}}))
        (PACKAGE.ROOT / "guid.md").write_text("# guid fixture\n")
        (PACKAGE.ROOT / "app/app.js").write_text("'use strict';")
        (PACKAGE.ROOT / "app/assets").mkdir()
        (PACKAGE.ROOT / "app/assets/icon.webp").write_bytes(b"RIFFfixtureWEBP")
        (PACKAGE.ROOT / "styles/app.css").write_text("body { margin: 0; }")
        (PACKAGE.ROOT / "docs/private.txt").write_text("not runtime")
        self.relative, self.output = PACKAGE.release_info()
        digest = PACKAGE.build(self.output)
        PACKAGE.write_install_manifest(self.relative, digest)

    def tearDown(self):
        PACKAGE.ROOT = self.previous_root
        self.temp.cleanup()

    def test_archive_matches_sources_and_excludes_docs(self):
        PACKAGE.verify(self.relative, self.output)
        with PACKAGE.zipfile.ZipFile(self.output) as archive:
            self.assertNotIn("docs/private.txt", archive.namelist())
            self.assertIn("guid.md", archive.namelist())
            self.assertEqual(archive.read("app/assets/icon.webp"), b"RIFFfixtureWEBP")

    def test_check_detects_modified_source_content(self):
        (PACKAGE.ROOT / "app/app.js").write_text("'changed';")
        with self.assertRaisesRegex(SystemExit, "content mismatch"):
            PACKAGE.verify(self.relative, self.output)

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


if __name__ == "__main__":
    unittest.main()
