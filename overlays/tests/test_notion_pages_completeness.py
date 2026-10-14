"""Check the Notion pages Collection Completeness overlay against its exact source OAD.

It composes with the catalog's auth, pagination and crud-causality overlays of
the same pin, and with pagination-v3 in place of pagination, in either order;
the result must pass the completeness and collection-read validators, and a
missing page is classified as declared. No provider is called. Use --directory
for a full-history openapi-directory checkout; otherwise the full-SHA source
URL is downloaded.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

SPECS = ROOT.parent / "openapi-extensions" / "spec"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


completeness = load("completeness_validate", SPECS / "collection-completeness" / "validate.py")
crud = load("crud_validate", SPECS / "crud-causality" / "validate.py")

DIRECTORY = None
PIN = "0c8e229623efdcc1d4ab50111d17bcca3214a899"
FOLDER = "APIs/notion.com/2026-03-11/"
OVERLAYS = [FOLDER + f"auth-{PIN}-overlay.yaml", FOLDER + f"pagination-{PIN}-overlay.yaml",
            FOLDER + f"crud-causality-{PIN}-overlay.yaml", FOLDER + f"completeness-{PIN}-overlay.yaml"]
PAGINATION_V3 = FOLDER + f"pagination-v3-{PIN}-overlay.yaml"


class NotionPagesCompletenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAYS[-1])
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.overlays = [yaml.safe_load((ROOT / path).read_text()) for path in OVERLAYS]
        cls.composed = copy.deepcopy(cls.original)
        for overlay in cls.overlays:
            apply(cls.composed, overlay)

    def compose(self, overlays):
        document = copy.deepcopy(self.original)
        for overlay in overlays:
            apply(document, overlay)
        return document

    def test_composition_passes_the_validators_in_either_order(self):
        v3 = yaml.safe_load((ROOT / PAGINATION_V3).read_text())
        for name, overlays in (("pagination", self.overlays),
                               ("pagination-v3", [self.overlays[0], v3, *self.overlays[2:]])):
            with self.subTest(pagination=name):
                document = self.compose(overlays)
                completeness.validate(document)
                warnings = []
                crud.validate(copy.deepcopy(document), warnings)
                self.assertEqual(warnings, [])
                self.assertEqual(self.compose([overlays[-1], *overlays[:-1]]), document)

    def test_page_outcomes(self):
        page = self.composed["components"]["crudResources"]["page"]
        declaration = page["collections"]["pages"]["x-completeness"]
        self.assertEqual(declaration["absent"], "removed")
        not_found = completeness.resource_not_found(self.composed, "page")
        self.assertEqual(not_found, "unavailable")
        self.assertNotIn("gone", declaration)  # Notion documents no 410
        page_id = "59833787-2cf9-4fdf-8782-e53db20768a5"
        classify = lambda status, body=None: completeness.classify_read(declaration, None, "id", page_id, status,
                                                                         body, not_found)
        # Not found, or not shared with the connection.
        self.assertEqual(classify(404, {"object": "error", "status": 404, "code": "object_not_found"}), "unavailable")
        self.assertEqual(classify(410), "unavailable")  # undocumented: read like a 404
        # A trashed page answered 2xx (inferred, not documented) is present, not a deletion.
        self.assertEqual(classify(200, {"object": "page", "id": page_id, "in_trash": True}), "present")
        self.assertEqual(classify(403, {"code": "restricted_resource"}), "unknown")

    def test_pages_are_not_concluded_from_their_data_source(self):
        pages = self.composed["components"]["crudResources"]["page"]["collections"]["pages"]
        self.assertEqual(completeness.parents(self.composed, "page", pages), {"data_source_id": ["data_source"]})
        # §4.4 needs a parent collection with a Completeness Object; data
        # sources (POST /search) have none, so no conclusion is drawn.
        sources = self.composed["components"]["crudResources"]["data_source"]["collections"]["data_sources"]
        self.assertNotIn("x-completeness", sources)
        self.assertNotIn("parentAbsent", pages["x-completeness"])
        for parent in ("deleted", "unavailable"):
            self.assertIsNone(completeness.members_of_gone_parent(pages["x-completeness"], parent))

    def test_only_completeness_is_added(self):
        actions = self.overlays[-1]["actions"]
        self.assertEqual([action["target"] for action in actions], ["$.components"])
        resources = actions[0]["update"]["crudResources"]
        self.assertEqual(set(resources), {"page"})
        self.assertEqual(resources["page"], {"collections": {"pages": {"x-completeness": resources["page"][
            "collections"]["pages"]["x-completeness"]}}})

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test, and
        # keeps the next one passing.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(f"completeness-{PIN}", catalog.read_text(encoding="utf-8"))

    def test_a_catalog_selects_it_only_with_pagination_v3(self):
        # Under an earlier pagination revision a query over 10,000 results
        # looks complete, so the pages past the cap would be taken as absent.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            for platform in json.loads(catalog.read_text(encoding="utf-8"))["platforms"]:
                names = [url.rsplit("/", 1)[1] for url in platform.get("overlays", [])]
                if f"completeness-{PIN}-overlay.yaml" not in names:
                    continue
                with self.subTest(catalog=catalog.name, platform=platform["name"]):
                    self.assertIn(f"pagination-v3-{PIN}-overlay.yaml", names)
                    self.assertNotIn(f"pagination-{PIN}-overlay.yaml", names)
                    self.assertNotIn(f"pagination-v2-{PIN}-overlay.yaml", names)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
