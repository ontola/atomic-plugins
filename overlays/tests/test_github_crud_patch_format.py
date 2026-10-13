"""GitHub crud-causality v2: valid CRUD Causality §4.6 patch formats.

v1 of both GitHub crud-causality overlays declares `patchFormat: merge`,
which §4.6 does not define. v2 declares `jsonMergePatch` for the issue and
comment PATCHes and, in github-issues, `custom` for the two label writes,
and changes nothing else. Each v2 is composed after the overlays the newest
dated catalog selects for its document (github-issues), or after its own
pagination overlay (api.github.com), and every update must then name a
§8 rule 5 mode and a §4.6 patch format; the CRUD Causality validator must
pass. The pinned OADs are downloaded by their full-SHA URLs; no provider is
called.
"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import PAGES_BASE, ROOT, apply, fetch

spec = importlib.util.spec_from_file_location(
    "crud_validate", ROOT.parent / "openapi-extensions" / "spec" / "crud-causality" / "validate.py")
crud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crud)

CATALOG = "2026-10-12-tasks-box-pages.json"
ISSUES = "APIs/github.com/github-issues/1.1.4/"
ISSUES_PIN = "9c5cfb87b3f8b64e11069373a73e3fc85de0de5e"
REST = "APIs/github.com/api.github.com/1.1.4/"
REST_PIN = "920631db31e628be547e9366821d3ebc7fa0ead5"
PATCH_FORMATS = {"jsonPatch", "jsonMergePatch", "custom"}


def overlay(path):
    return yaml.safe_load((ROOT / path).read_text(encoding="utf-8"))


def updates(document):
    """(path, method) -> x-crud of every update, in paths and in overlay-added paths."""
    found = {}
    for path, item in document["paths"].items():
        for method, operation in item.items():
            if isinstance(operation, dict) and operation.get("x-crud", {}).get("action") == "update":
                found[(path, method)] = operation["x-crud"]
    return found


def creates(document):
    """(path, method) -> x-crud of every create."""
    return {
        (path, method): operation["x-crud"]
        for path, item in document["paths"].items()
        for method, operation in item.items()
        if isinstance(operation, dict) and operation.get("x-crud", {}).get("action") == "create"
    }


class GitHubPatchFormatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        issues = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                      if p["name"] == "github-issues")
        v1 = PAGES_BASE + ISSUES + f"crud-causality-{ISSUES_PIN}-overlay.yaml"
        assert v1 in issues["overlays"]
        with tempfile.TemporaryDirectory() as cache:
            cls.issues_oad = yaml.safe_load(fetch(issues["openapi"], Path(cache))[0])
            rest_url = f"https://raw.githubusercontent.com/ontola/openapi-directory/{REST_PIN}/{REST}openapi.yaml"
            cls.rest_oad = yaml.safe_load(fetch(rest_url, Path(cache))[0])
        cls.issues = {}
        for version, name in (("v1", f"crud-causality-{ISSUES_PIN}-overlay.yaml"),
                              ("v2", f"crud-causality-v2-{ISSUES_PIN}-overlay.yaml")):
            document = copy.deepcopy(cls.issues_oad)
            for url in issues["overlays"]:
                apply(document, overlay(ISSUES + name if url == v1 else url[len(PAGES_BASE):]))
            cls.issues[version] = document
        cls.rest = {}
        for version, name in (("v1", f"crud-causality-{REST_PIN}-overlay.yaml"),
                              ("v2", f"crud-causality-v2-{REST_PIN}-overlay.yaml")):
            document = copy.deepcopy(cls.rest_oad)
            apply(document, overlay(REST + f"pagination-{REST_PIN}-overlay.yaml"))
            apply(document, overlay(REST + name))
            cls.rest[version] = document

    def test_v1_declares_a_patch_format_section_4_6_does_not_define(self):
        for name, documents in (("github-issues", self.issues), ("api.github.com", self.rest)):
            with self.subTest(document=name):
                formats = {x.get("patchFormat") for x in updates(documents["v1"]).values()}
                self.assertIn("merge", formats)

    def test_v2_names_a_mode_and_a_section_4_6_format_for_every_update(self):
        for name, documents in (("github-issues", self.issues), ("api.github.com", self.rest)):
            for key, x_crud in updates(documents["v2"]).items():
                with self.subTest(document=name, operation=key):
                    self.assertIn(x_crud.get("mode"), ("replace", "patch"))
                    if x_crud["mode"] == "patch":
                        self.assertIn(x_crud.get("patchFormat"), PATCH_FORMATS)

    def test_the_formats_chosen(self):
        issues = {key: x.get("patchFormat") for key, x in updates(self.issues["v2"]).items()}
        self.assertEqual(issues[("/repos/{owner}/{repo}/issues/{issue_number}", "patch")], "jsonMergePatch")
        self.assertEqual(issues[("/repos/{owner}/{repo}/issues/comments/{comment_id}", "patch")], "jsonMergePatch")
        self.assertEqual(issues[("/repos/{owner}/{repo}/issues/{issue_number}/labels", "post")], "custom")
        self.assertEqual(issues[("/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", "delete")], "custom")
        rest = {key: x.get("patchFormat") for key, x in updates(self.rest["v2"]).items()}
        self.assertEqual(set(rest.values()), {"jsonMergePatch"})

    def test_v2_changes_v1_only_in_patch_formats_and_added_field_sources(self):
        for name, documents in (("github-issues", self.issues), ("api.github.com", self.rest)):
            with self.subTest(document=name):
                v1, v2 = copy.deepcopy(documents["v1"]), copy.deepcopy(documents["v2"])
                for document in (v1, v2):
                    for x_crud in updates(document).values():
                        x_crud.pop("patchFormat", None)
                        x_crud.pop("description", None)
                    for x_crud in creates(document).values():
                        for field in x_crud.get("addedFields", {}).values():
                            field.pop("source", None)
                self.assertEqual(v1, v2)

    def test_v2_added_fields_use_a_section_4_5_source(self):
        for name, documents in (("github-issues", self.issues), ("api.github.com", self.rest)):
            sources = {(key, field): spec["source"]
                       for key, x_crud in creates(documents["v2"]).items()
                       for field, spec in x_crud.get("addedFields", {}).items()}
            with self.subTest(document=name):
                self.assertTrue(sources)
                self.assertEqual(set(sources.values()), {"generated"})
            old = {spec["source"] for x_crud in creates(documents["v1"]).values()
                   for spec in x_crud.get("addedFields", {}).values()}
            self.assertEqual(old, {"server"})

    def test_the_compositions_pass_the_crud_causality_validator(self):
        for name, document in (("github-issues", self.issues["v2"]), ("api.github.com", self.rest["v2"])):
            with self.subTest(document=name):
                warnings = []
                crud.validate(copy.deepcopy(document), warnings)
                self.assertEqual(warnings, [])

    def test_only_the_syncables_0_22_catalog_selects_v2(self):
        # catalog/2026-10-12-syncables-0.22.json selects github-issues' v2 in place of v1; no catalog
        # selects api.github.com's (it has no catalog platform).
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            text = catalog.read_text(encoding="utf-8")
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(f"crud-causality-v2-{REST_PIN}", text)
                if catalog.name != "2026-10-12-syncables-0.22.json":
                    self.assertNotIn(f"crud-causality-v2-{ISSUES_PIN}", text)
                    continue
                issues = next(p for p in json.loads(text)["platforms"] if p["name"] == "github-issues")
                names = [url.rsplit("/", 1)[1] for url in issues["overlays"]]
                self.assertIn(f"crud-causality-v2-{ISSUES_PIN}-overlay.yaml", names)
                self.assertNotIn(f"crud-causality-{ISSUES_PIN}-overlay.yaml", names)


if __name__ == "__main__":
    unittest.main()
