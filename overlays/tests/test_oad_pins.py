"""Guard the revision layout and reject catalog/OAD mismatches."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from validate_oad_pins import OAD_BASE, PAGES_BASE, apply_overlay, overlay_pin, parse_target, validate, published_errors


class OADPinTests(unittest.TestCase):
    def write_overlay(self, root, sha="a" * 40, source="APIs/example.com/v1/openapi.yaml", name=None, actions=None):
        path = root / "APIs/example.com/v1" / (name or f"pagination-{sha}-overlay.yaml")
        path.parent.mkdir(parents=True, exist_ok=True)
        actions = json.dumps(actions if actions is not None else [{"target": "$", "update": {}}])
        path.write_text(f"overlay: 1.0.0\nextends: {OAD_BASE}{sha}/{source}\ninfo:\n  title: Test\n  version: 1.0.0\nactions: {actions}\n")
        return path

    def oad_repository(self, tmp, text, source="APIs/example.com/v1/openapi.yaml"):
        """A one-commit OAD checkout; returns (directory, sha)."""
        directory = Path(tmp) / "directory"
        directory.mkdir()
        def git(*args):
            return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()
        git("init", "-q")
        git("config", "user.name", "Test")
        git("config", "user.email", "test@example.com")
        (directory / source).parent.mkdir(parents=True)
        (directory / source).write_text(text)
        git("add", ".")
        git("commit", "-qm", "Add OAD")
        return directory, git("rev-parse", "HEAD")

    def test_target_parser_mirrors_the_proxy(self):
        self.assertEqual(parse_target("$"), [])
        self.assertEqual(parse_target("$.components"), ["components"])
        self.assertEqual(parse_target("$.paths['/things/{id}'].get"), ["paths", "/things/{id}", "get"])
        self.assertEqual(parse_target("$['x-crud'].a['b.c']"), ["x-crud", "a", "b.c"])
        for bad in ("components", "$..a", "$['a'", "$.paths[?(@.get)]", "$.a[0]", None):
            with self.assertRaisesRegex(ValueError, "unsupported overlay target"):
                parse_target(bad)

    def test_apply_overlay_merges_existing_targets_and_reports_missing_ones(self):
        document = {"swagger": "2.0", "paths": {"/a": {"get": {"summary": "A"}}}}
        overlay = {"actions": [
            {"target": "$.components", "update": {"paginationSchemes": {}}},
            {"target": "$.paths['/a'].get", "update": {"x-pagination": [{"scheme": "pages"}]}},
            {"target": "$.paths['/b'].get", "update": {}},
            {"target": "$", "update": {"x-paginationSchemes": {"pages": {"type": "pageNumber"}}}},
            {"target": "$.paths", "remove": True},
        ]}
        document, errors = apply_overlay(document, overlay, "test")
        self.assertEqual(errors, [
            "test: target '$.components' does not exist",
            "test: target \"$.paths['/b'].get\" does not exist",
            "test: action '$.paths' must have an update (the proxy supports no other action)",
        ])
        self.assertEqual(document["paths"]["/a"]["get"], {"summary": "A", "x-pagination": [{"scheme": "pages"}]})
        self.assertEqual(document["x-paginationSchemes"], {"pages": {"type": "pageNumber"}})
        self.assertNotIn("components", document)

    def test_swagger2_overlay_must_not_target_components(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "overlays"
            directory, sha = self.oad_repository(tmp, "swagger: '2.0'\npaths: {}\ndefinitions: {}\n", "APIs/example.com/v1/swagger.yaml")
            (root / "catalog").mkdir(parents=True)
            (root / "catalog/2026-10-02.json").write_text('{"platforms": []}')
            path = self.write_overlay(root, sha, "APIs/example.com/v1/swagger.yaml", actions=[{"target": "$.components", "update": {"paginationSchemes": {}}}])
            errors = validate(root, directory)
            self.assertEqual(len(errors), 1, errors)
            self.assertIn("target '$.components' does not exist", errors[0])
            self.assertTrue(errors[0].startswith(path.relative_to(root).as_posix()))
            path.unlink()
            self.write_overlay(root, sha, "APIs/example.com/v1/swagger.yaml", actions=[{"target": "$", "update": {"x-paginationSchemes": {}}}, {"target": "$.definitions", "update": {"Page": {"type": "object"}}}])
            self.assertEqual(validate(root, directory), [])

    def test_catalog_order_defines_the_targets_later_overlays_may_use(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "overlays"
            directory, sha = self.oad_repository(tmp, "openapi: 3.0.0\npaths: {}\ncomponents: {}\n")
            adds = self.write_overlay(root, sha, name=f"crud-causality-{sha}-overlay.yaml", actions=[{"target": "$.paths", "update": {"/a": {"get": {}}}}])
            uses = self.write_overlay(root, sha, name=f"pagination-{sha}-overlay.yaml", actions=[{"target": "$.paths['/a'].get", "update": {"x-pagination": []}}])
            (root / "catalog").mkdir(parents=True)
            catalog = root / "catalog/2026-10-02.json"
            def select(*paths):
                catalog.write_text(json.dumps({"platforms": [{"name": "example", "openapi": f"{OAD_BASE}{sha}/APIs/example.com/v1/openapi.yaml", "overlays": [PAGES_BASE + p.relative_to(root).as_posix() for p in paths]}]}))
            select(adds, uses)
            self.assertEqual(validate(root, directory), [])
            select(uses, adds)
            errors = validate(root, directory)
            self.assertEqual(len(errors), 1, errors)
            self.assertTrue(errors[0].startswith("2026-10-02.json example: " + uses.relative_to(root).as_posix()), errors[0])
            # Unselected while its sibling is selected, the same overlay must resolve against the bare OAD.
            select(adds)
            errors = validate(root, directory)
            self.assertEqual(len(errors), 1, errors)
            self.assertTrue(errors[0].startswith(uses.relative_to(root).as_posix() + ": target"), errors[0])
            # Unselected siblings for one pin compose in whichever order resolves (historical revisions).
            select()
            self.assertEqual(validate(root, directory), [])
            self.write_overlay(root, sha, name=f"auth-{sha}-overlay.yaml", actions=[{"target": "$.paths['/b'].get", "update": {}}])
            errors = validate(root, directory)
            self.assertEqual(len(errors), 1, errors)
            self.assertIn("auth-", errors[0])

    def test_superseded_revision_is_not_checked_on_its_own(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "overlays"
            directory, sha = self.oad_repository(tmp, "swagger: '2.0'\npaths: {}\n", "APIs/example.com/v1/swagger.yaml")
            (root / "catalog").mkdir(parents=True)
            (root / "catalog/2026-10-02.json").write_text('{"platforms": []}')
            old = self.write_overlay(root, sha, "APIs/example.com/v1/swagger.yaml", name=f"crud-causality-{sha}-overlay.yaml", actions=[{"target": "$.components", "update": {"crudResources": {}}}])
            self.assertEqual(len(validate(root, directory)), 1)
            self.write_overlay(root, sha, "APIs/example.com/v1/swagger.yaml", name=f"crud-causality-v2-{sha}-overlay.yaml", actions=[{"target": "$", "update": {"x-crudResources": {}}}])
            self.assertEqual(validate(root, directory), [])
            # A catalog that still selects the old revision is told.
            (root / "catalog/2026-10-02.json").write_text(json.dumps({"platforms": [{"name": "example", "openapi": f"{OAD_BASE}{sha}/APIs/example.com/v1/swagger.yaml", "overlays": [PAGES_BASE + old.relative_to(root).as_posix()]}]}))
            errors = validate(root, directory)
            self.assertEqual(len(errors), 1, errors)
            self.assertTrue(errors[0].startswith("2026-10-02.json example: "), errors[0])

    def test_unparseable_oad_is_a_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "overlays"
            directory, sha = self.oad_repository(tmp, "openapi: 3.0.0\npaths:\n  /a:\n\tget: {}\n")
            (root / "catalog").mkdir(parents=True)
            (root / "catalog/2026-10-02.json").write_text('{"platforms": []}')
            self.write_overlay(root, sha, actions=[{"target": "$.components", "update": {}}])
            warnings = []
            self.assertEqual(validate(root, directory, warnings=warnings), [])
            self.assertEqual(len(warnings), 1, warnings)
            self.assertIn("does not parse", warnings[0])

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
