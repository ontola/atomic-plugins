"""Google Tasks pagination v2 (emptyWhenAbsent) and the catalog that selects it.

v2 of the Tasks pagination overlay adds Pagination Schemes 0.7.0
`emptyWhenAbsent: true` to both envelopes, so a list answered without
`items` (an empty list, as the Protocol Buffers JSON mapping serializes it)
is a page with no items. Checks the v2 file against v1, the Tasks platform
composed from catalog/2026-10-12-tasks-box-pages.json with the Pagination
Schemes reference validator and its `page_items`, and the catalog against
catalog/2026-10-12-box-pagination-v2.json: only the Tasks pagination overlay
(v1 to v2) and the Box one (v2 to v3, tests/test_box_pagination_v3.py)
differ. The pinned OAD is downloaded by its full-SHA URL; no provider is
called.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import PAGES_BASE, ROOT, apply, fetch

PIN = "7ca47c73cf2308c9812692b482b3713b397bc88c"
FOLDER = ROOT / "APIs/googleapis.com/tasks/v1"
V1 = f"pagination-{PIN}-overlay.yaml"
V2 = f"pagination-v2-{PIN}-overlay.yaml"
URL = PAGES_BASE + "APIs/googleapis.com/tasks/v1/"
CATALOG = "2026-10-12-tasks-box-pages.json"
BASE = "2026-10-12-box-pagination-v2.json"
BOX = PAGES_BASE + "APIs/box.com/2.0.0/pagination-{}-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml"
LISTS = ("/tasks/v1/lists/{tasklist}/tasks", "/tasks/v1/users/@me/lists")

spec = importlib.util.spec_from_file_location(
    "pagination_validate", ROOT.parent / "openapi-extensions" / "spec" / "pagination-schemes" / "validate.py")
pagination = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pagination)


def platforms(name):
    return json.loads((ROOT / "catalog" / name).read_text(encoding="utf-8"))["platforms"]


def applied_scheme(document, path):
    """The scheme an operation applies, with its overrides merged (§5)."""
    application = document["paths"][path]["get"]["x-pagination"][0]
    scheme = json.loads(json.dumps(document["components"]["paginationSchemes"][application["scheme"]]))
    return _merge(scheme, application.get("overrides", {}))


def _merge(base, update):
    for key, value in update.items():
        base[key] = _merge(base.get(key, {}), value) if isinstance(value, dict) and isinstance(base.get(key), dict) else value
    return base


class GoogleTasksEmptyListTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            tasks = next(p for p in platforms(CATALOG) if p["name"] == "google-tasks")
            document = yaml.safe_load(fetch(tasks["openapi"], Path(cache))[0])
            for url in tasks["overlays"]:
                apply(document, yaml.safe_load(fetch(url, Path(cache))[0]))
            cls.document = document

    def test_v2_is_v1_plus_empty_when_absent_on_both_envelopes(self):
        v1 = yaml.safe_load((FOLDER / V1).read_text(encoding="utf-8"))
        v2 = yaml.safe_load((FOLDER / V2).read_text(encoding="utf-8"))
        for action in v1["actions"]:
            envelope = action["update"].get("x-pagination", [{}])[0].get("overrides", {}).get("response", {}).get("envelope")
            if envelope is not None:
                envelope["emptyWhenAbsent"] = True
        self.assertEqual(v2["actions"], v1["actions"])
        self.assertEqual(v2["extends"], v1["extends"])

    def test_the_composed_platform_passes_the_validator(self):
        pagination.validate(self.document)

    def test_an_empty_list_without_items_is_a_page_with_no_items(self):
        for path in LISTS:
            with self.subTest(path=path):
                scheme = applied_scheme(self.document, path)
                self.assertEqual(scheme["response"]["envelope"], {"itemsField": "items", "emptyWhenAbsent": True})
                self.assertEqual(pagination.page_items({"kind": "tasks#tasks", "etag": "\"e1\""}, scheme), [])
                self.assertEqual(pagination.page_items({"items": [{"id": "t1"}]}, scheme), [{"id": "t1"}])
                with self.assertRaises(pagination.PageReadError):
                    pagination.page_items({"items": None}, scheme)

    def test_the_catalog_switches_only_the_tasks_and_box_pagination_overlays(self):
        base, new = platforms(BASE), platforms(CATALOG)
        self.assertEqual([p["name"] for p in new], [p["name"] for p in base])
        swaps = {"google-tasks": (URL + V1, URL + V2), "box": (BOX.format("v2"), BOX.format("v3"))}
        for before, after in zip(base, new):
            with self.subTest(platform=before["name"]):
                if before["name"] not in swaps:
                    self.assertEqual(after, before)
                    continue
                old, replacement = swaps[before["name"]]
                self.assertIn(old, before["overlays"])
                self.assertEqual(after["overlays"], [replacement if url == old else url for url in before["overlays"]])
                self.assertEqual({k: v for k, v in after.items() if k != "overlays"},
                                 {k: v for k, v in before.items() if k != "overlays"})

    def test_no_other_catalog_selects_v2(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            if catalog.name != CATALOG:
                with self.subTest(catalog=catalog.name):
                    self.assertNotIn(V2, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
