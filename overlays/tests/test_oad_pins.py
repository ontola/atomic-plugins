"""Guard the revision layout and reject catalog/OAD mismatches."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from validate_oad_pins import OAD_BASE, PAGES_BASE, overlay_pin, validate, published_errors


class OADPinTests(unittest.TestCase):
    def write_overlay(self, root, sha="a" * 40, source="APIs/example.com/v1/openapi.yaml", name=None):
        path = root / "APIs/example.com/v1" / (name or f"pagination-{sha}-overlay.yaml")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"overlay: 1.0.0\nextends: {OAD_BASE}{sha}/{source}\ninfo:\n  title: Test\n  version: 1.0.0\nactions:\n- target: $\n  update: {{}}\n")
        return path

    def test_checked_in_catalog_and_paths(self):
        self.assertEqual(validate(), [])

    def test_multiple_revisions_coexist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for sha in ("a" * 40, "b" * 40):
                self.assertEqual(overlay_pin(self.write_overlay(root, sha), root)[1], sha)

    def test_wrong_folder_and_filename_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "folder must match"):
                overlay_pin(self.write_overlay(root, source="APIs/other.com/v1/openapi.yaml"), root)
            with self.assertRaisesRegex(ValueError, "filename must include"):
                overlay_pin(self.write_overlay(root, name="pagination-overlay.yaml"), root)

    def test_unpinned_url_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_overlay(root)
            path.write_text(path.read_text().replace("a" * 40, "main"))
            with self.assertRaisesRegex(ValueError, "full SHA"):
                overlay_pin(path, root)

    def test_catalog_must_select_matching_oad(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_overlay(root)
            (root / "catalog.json").write_text(json.dumps({"platforms": [{"name": "test", "openapi": OAD_BASE + "b" * 40 + "/APIs/example.com/v1/openapi.yaml", "overlays": [PAGES_BASE + path.relative_to(root).as_posix()]}]}))
            self.assertTrue(any("differs from catalog OAD" in error for error in validate(root)))

    def test_published_revision_is_immutable_and_new_revision_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            repository = Path(tmp)
            def git(*args):
                return subprocess.check_output(["git", "-C", str(repository), *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.com")
            root = repository / "overlays"
            old = self.write_overlay(root)
            git("add", ".")
            git("commit", "-qm", "Publish first revision")
            self.write_overlay(root, "b" * 40)
            self.assertEqual(published_errors(root, "HEAD"), [])
            original = old.read_text()
            old.write_text(original + "# changed\n")
            self.assertTrue(published_errors(root, "HEAD"))
            old.unlink()
            self.assertTrue(published_errors(root, "HEAD"))

    def test_published_dated_catalog_is_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            repository = Path(tmp)
            def git(*args):
                return subprocess.check_output(["git", "-C", str(repository), *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.com")
            root = repository / "overlays"
            catalog = root / "catalog/2026-10-02.json"
            catalog.parent.mkdir(parents=True)
            catalog.write_text('{"platforms": []}')
            git("add", ".")
            git("commit", "-qm", "Publish dated catalog")
            (catalog.parent / "2026-10-03.json").write_text('{"platforms": []}')
            self.assertEqual(published_errors(root, "HEAD"), [])
            catalog.write_text('{"platforms": [], "changed": true}')
            self.assertTrue(published_errors(root, "HEAD"))

    def test_history_rejects_unrelated_commit_but_accepts_old_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "overlays"
            directory = Path(tmp) / "directory"
            directory.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.com")
            source = directory / "APIs/example.com/v1/openapi.yaml"
            source.parent.mkdir(parents=True)
            source.write_text("openapi: 3.0.0\n")
            git("add", ".")
            git("commit", "-qm", "Add OAD")
            first = git("rev-parse", "HEAD")
            path = self.write_overlay(root, first)
            (root / "catalog.json").write_text('{"platforms": []}')
            git("commit", "--allow-empty", "-qm", "Unrelated change")
            unrelated = git("rev-parse", "HEAD")
            self.assertEqual(validate(root, directory), [])
            path.unlink()
            path = self.write_overlay(root, unrelated)
            self.assertTrue(any("did not last change" in error for error in validate(root, directory)))
            path.unlink()
            self.write_overlay(root, first)
            source.write_text("openapi: 3.1.0\n")
            git("add", ".")
            git("commit", "-qm", "Update OAD")
            self.assertEqual(validate(root, directory), [])
            self.assertTrue(any("is historical" in error for error in validate(root, directory, "HEAD")))


if __name__ == "__main__":
    unittest.main()
