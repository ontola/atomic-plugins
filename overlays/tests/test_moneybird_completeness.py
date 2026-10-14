"""Check the Moneybird Collection Completeness overlay against its exact source OAD.

It composes with the catalog's Moneybird overlays of the same pin, in either
order; the result must pass the completeness and collection-read validators
(with the published crud-causality overlay's known rule-10 warnings), the
overlay must declare exactly the collections whose resource has an item read
documented with a 404 (less the two exclusions its header gives), each list
must still document a default that leaves out existing records or have no
filter at all, and a missing record is classified as declared. No provider
is called. Use --directory for a full-history openapi-directory checkout;
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
PIN = "85a6105220036a98ef0d7cd6f228d4aae0036508"
FOLDER = "APIs/moneybird.com/v2-readonly/"
OVERLAYS = [FOLDER + f"auth-{PIN}-overlay.yaml", FOLDER + f"pagination-{PIN}-overlay.yaml",
            FOLDER + f"crud-causality-{PIN}-overlay.yaml", FOLDER + f"throttling-{PIN}-overlay.yaml",
            FOLDER + f"completeness-{PIN}-overlay.yaml"]
# The published crud-causality overlay's rule-10 warnings (a SHOULD), as
# test_crud_reads_in_catalogs.py and the syncables 0.22 catalog test list them.
KNOWN_WARNINGS = {
    "crudResources.verification.identity.urlTemplate: {administration_id} is neither bound nor "
    "in a collection's urlTemplate (rule 10, SHOULD)",
    "crudResources.moneybird_payments_mandate.identity.urlTemplate: {administration_id} is "
    "neither bound nor in a collection's urlTemplate (rule 10, SHOULD)",
    "crudResources.moneybird_payments_mandate.identity.urlTemplate: {contact_id} is neither "
    "bound nor in a collection's urlTemplate (rule 10, SHOULD)",
}
EXCLUDED = {"financial_mutation", "subscription"}
# Each declared list's documented default that leaves out records that still exist.
DEFAULTS = {
    "assets": ("active", True), "products": ("active", True), "projects": ("filter", "state:active"),
    "recurring_sales_invoices": ("filter", "state:active"), "purchase_transactions": ("filter", "unbatched:true"),
    "general_documents": ("filter", "period:this_year"), "general_journal_documents": ("filter", "period:this_year"),
    "purchase_invoices": ("filter", "period:this_year"), "receipts": ("filter", "period:this_year"),
    "typeless_documents": ("filter", "period:this_year"), "estimates": ("filter", "period:this_year"),
    "external_sales_invoices": ("filter", "period:this_year"), "sales_invoices": ("filter", "period:this_year"),
    "time_entries": ("filter", "period:this_year"),
}


class MoneybirdCompletenessTests(unittest.TestCase):
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
        cls.declared = cls.overlays[-1]["actions"][0]["update"]["crudResources"]

    def resolve(self, node):
        while isinstance(node, dict) and "$ref" in node:
            target = self.original
            for part in node["$ref"][2:].split("/"):
                target = target[part]
            node = target
        return node

    def test_composition_passes_the_validators_in_either_order(self):
        completeness.validate(self.composed)
        warnings = []
        crud.validate(copy.deepcopy(self.composed), warnings)
        self.assertLessEqual(set(warnings), KNOWN_WARNINGS)
        reordered = copy.deepcopy(self.original)
        for overlay in [self.overlays[-1], *self.overlays[:-1]]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.composed)

    def test_declared_on_exactly_the_collections_with_a_documented_404_read(self):
        expected = set()
        for name, resource in self.composed["components"]["crudResources"].items():
            template = (resource.get("identity") or {}).get("urlTemplate")
            read = self.original["paths"].get(template, {}).get("get") if template else None
            if not read or "404" not in read["responses"] or name in EXCLUDED:
                continue
            if self.resolve(read["responses"]["404"])["description"] != "Not found":
                # One read documents its 404 as "Error code"; its resource has no collection.
                self.assertFalse(resource.get("collections"), name)
                continue
            expected.update((name, collection) for collection in resource.get("collections") or {})
        found = {(name, collection) for name, resource in self.declared.items()
                 for collection in resource["collections"]}
        self.assertEqual(found, expected)
        self.assertEqual(len(found), 20)

    def test_the_lists_document_defaults_that_leave_out_existing_records(self):
        crud_resources = self.composed["components"]["crudResources"]
        for name, resource in self.declared.items():
            for collection in resource["collections"]:
                if collection not in DEFAULTS:
                    continue
                parameter, default = DEFAULTS[collection]
                path = crud_resources[name]["collections"][collection]["urlTemplate"]
                with self.subTest(collection=collection):
                    found = {p["name"]: p for p in map(self.resolve, self.original["paths"][path]["get"]["parameters"])}
                    self.assertEqual(found[parameter]["schema"]["default"], default)
        contacts = {p["name"] for p in map(self.resolve,
                                           self.original["paths"]["/{administration_id}/contacts.json"]["get"]["parameters"])}
        self.assertIn("include_archived", contacts)

    def test_excluded_collections_stay_undeclared(self):
        resources = self.composed["components"]["crudResources"]
        for name in EXCLUDED:
            for collection in resources[name]["collections"].values():
                with self.subTest(resource=name):
                    self.assertNotIn("x-completeness", collection)
        operation = self.original["paths"]["/{administration_id}/financial_mutations.json"]["get"]
        self.assertIn("Limited to 100 financial mutations", operation["description"])

    def test_record_outcomes(self):
        for name, resource in self.declared.items():
            for collection, body in resource["collections"].items():
                declaration = body["x-completeness"]
                self.assertEqual(declaration, {"absent": "removed", "notFound": "unavailable"})
                not_found = completeness.resource_not_found(self.composed, name)
                with self.subTest(resource=name):
                    self.assertEqual(not_found, "unavailable")
                    classify = lambda status, payload=None: completeness.classify_read(
                        declaration, None, "id", "4155", status, payload, not_found)
                    self.assertEqual(classify(404, {"error": "Not found"}), "unavailable")
                    self.assertEqual(classify(410), "unavailable")
                    self.assertEqual(classify(200, {"id": "4155"}), "present")
                    self.assertEqual(classify(403), "unknown")
                    collection_object = self.composed["components"]["crudResources"][name]["collections"][collection]
                    self.assertEqual(completeness.parents(self.composed, name, collection_object), {})

    def test_only_completeness_is_added(self):
        actions = self.overlays[-1]["actions"]
        self.assertEqual([action["target"] for action in actions], ["$.components"])
        for resource in self.declared.values():
            self.assertEqual(set(resource), {"collections"})
            for collection in resource["collections"].values():
                self.assertEqual(set(collection), {"x-completeness"})

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
