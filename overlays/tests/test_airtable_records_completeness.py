"""Check the Airtable table records Collection Completeness overlay against its exact source OAD.

It composes with the catalog's auth, pagination and crud-causality overlays of
the same pin, in either order; the result must pass the completeness and
collection-read validators, a missing record is classified as declared, and
the pinned document still says what the overlay quotes. No provider is
called. Use --directory for a full-history openapi-directory checkout;
otherwise the full-SHA source URL is downloaded.
"""
import argparse
import copy
import importlib.util
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
PIN = "1f5368e0251bfbaa233860dc8131507c38a4f8b3"
FOLDER = "APIs/airtable.com/1.0-readonly/"
OVERLAYS = [FOLDER + f"auth-{PIN}-overlay.yaml", FOLDER + f"pagination-{PIN}-overlay.yaml",
            FOLDER + f"crud-causality-{PIN}-overlay.yaml", FOLDER + f"completeness-{PIN}-overlay.yaml"]
LIST = "/v0/{baseId}/{tableIdOrName}"
READ = "/v0/{baseId}/{tableIdOrName}/{recordId}"


class AirtableRecordsCompletenessTests(unittest.TestCase):
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

    def test_composition_passes_the_validators_in_either_order(self):
        completeness.validate(self.composed)
        warnings = []
        crud.validate(copy.deepcopy(self.composed), warnings)
        self.assertEqual(warnings, [])
        reordered = copy.deepcopy(self.original)
        for overlay in [self.overlays[-1], *self.overlays[:-1]]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.composed)

    def test_the_pinned_document_still_says_what_the_overlay_quotes(self):
        paths = self.original["paths"]
        self.assertEqual(paths[READ]["get"]["responses"]["404"]["description"],
                         "The base, table, or record does not exist or is not accessible.")
        self.assertEqual(paths[LIST]["get"]["responses"]["404"]["description"],
                         "The base or table does not exist or is not accessible.")
        self.assertNotIn("410", paths[READ]["get"]["responses"])

    def test_record_outcomes(self):
        record = self.composed["components"]["crudResources"]["record"]
        declaration = record["collections"]["tableRecords"]["x-completeness"]
        self.assertEqual(declaration["absent"], "removed")
        not_found = completeness.resource_not_found(self.composed, "record")
        self.assertEqual(not_found, "unavailable")
        self.assertNotIn("gone", declaration)
        classify = lambda status, body=None: completeness.classify_read(declaration, None, "id", "recA1", status,
                                                                         body, not_found)
        # A deleted record, or a deleted or renamed table or base: the answer does not say.
        self.assertEqual(classify(404, {"error": "NOT_FOUND"}), "unavailable")
        self.assertEqual(classify(410), "unavailable")  # undocumented: read like a 404
        self.assertEqual(classify(200, {"id": "recA1", "fields": {}}), "present")
        self.assertEqual(classify(403, {"error": {"type": "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"}}), "unknown")

    def test_records_have_no_parent_collection(self):
        records = self.composed["components"]["crudResources"]["record"]["collections"]["tableRecords"]
        self.assertEqual(completeness.parents(self.composed, "record", records), {})
        self.assertNotIn("parentAbsent", records["x-completeness"])

    def test_only_completeness_is_added(self):
        actions = self.overlays[-1]["actions"]
        self.assertEqual([action["target"] for action in actions], ["$.components"])
        resources = actions[0]["update"]["crudResources"]
        self.assertEqual(set(resources), {"record"})
        self.assertEqual(set(resources["record"]), {"collections"})
        self.assertEqual(set(resources["record"]["collections"]), {"tableRecords"})
        self.assertEqual(set(resources["record"]["collections"]["tableRecords"]), {"x-completeness"})

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(f"completeness-{PIN}", catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
