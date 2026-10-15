"""Check the Moneybird Collection Completeness overlay against its exact source OAD.

It composes with the catalog's Moneybird overlays of the same pin, in either
order; the result must pass the completeness and collection-read validators
(with the published crud-causality overlay's known rule-10 warnings). The
overlay must declare exactly the five lists that send no filter and leave
nothing out by default (Collection Completeness §4.2: `removed` "still tells a
consumer that the list does not filter by default"), every list whose
documented default leaves out existing records must stay undeclared, and a
missing record is classified as declared. No provider
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
# The lists that send no filter: only page and per_page, or nothing.
DECLARED = {("identity", "identities"), ("ledger_account", "ledger_accounts"),
            ("task_list_template", "task_list_templates"), ("task_list", "task_lists"),
            ("workflow", "workflows")}
PAGING = {"page", "per_page"}
# The lists whose documented default leaves out records that still exist:
# never declared, since with `removed` every record outside the default would
# go unconfirmed (the documents' period:this_year on 1 January, say).
NARROWING = {
    "asset": ("assets", "active", True),
    "product": ("products", "active", True),
    "project": ("projects", "filter", "state:active"),
    "contact": ("contacts", "include_archived", None),
    "recurring_sales_invoice": ("recurring_sales_invoices", "filter", "state:active"),
    "purchase_transaction": ("purchase_transactions", "filter", "unbatched:true"),
    "general_document": ("general_documents", "filter", "period:this_year"),
    "general_journal_document": ("general_journal_documents", "filter", "period:this_year"),
    "purchase_invoice": ("purchase_invoices", "filter", "period:this_year"),
    "receipt": ("receipts", "filter", "period:this_year"),
    "typeless_document": ("typeless_documents", "filter", "period:this_year"),
    "estimate": ("estimates", "filter", "period:this_year"),
    "external_sales_invoice": ("external_sales_invoices", "filter", "period:this_year"),
    "sales_invoice": ("sales_invoices", "filter", "period:this_year"),
    "time_entrie": ("time_entries", "filter", "period:this_year"),
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

    def query(self, name, collection):
        path = self.composed["components"]["crudResources"][name]["collections"][collection]["urlTemplate"]
        parameters = map(self.resolve, self.original["paths"][path]["get"].get("parameters", []))
        return {p["name"]: p for p in parameters if p["in"] == "query"}

    def test_declared_on_exactly_the_lists_that_do_not_filter(self):
        found = {(name, collection) for name, resource in self.declared.items()
                 for collection in resource["collections"]}
        self.assertEqual(found, DECLARED)
        for name, collection in DECLARED:
            with self.subTest(collection=collection):
                # No filter parameter at all: only paging, or nothing.
                self.assertLessEqual(set(self.query(name, collection)), PAGING)
                # Each has an item read that documents a 404.
                template = self.composed["components"]["crudResources"][name]["identity"]["urlTemplate"]
                self.assertIn("404", self.original["paths"][template]["get"]["responses"])

    def test_lists_that_leave_out_existing_records_stay_undeclared(self):
        crud_resources = self.composed["components"]["crudResources"]
        for name, (collection, parameter, default) in NARROWING.items():
            with self.subTest(collection=collection):
                found = self.query(name, collection)
                if default is None:
                    self.assertIn(parameter, found)  # contacts: archived ones only with include_archived
                else:
                    self.assertEqual(found[parameter]["schema"]["default"], default)
                self.assertNotIn("x-completeness", crud_resources[name]["collections"][collection])
        # Every list with a filter parameter is either narrowing or excluded.
        for name, resource in crud_resources.items():
            for collection in resource.get("collections") or {}:
                if (name, collection) in DECLARED or name in EXCLUDED:
                    continue
                with self.subTest(other=collection):
                    self.assertNotIn("x-completeness", resource["collections"][collection])

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
