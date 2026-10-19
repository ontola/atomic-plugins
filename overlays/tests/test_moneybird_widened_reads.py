"""Moneybird crud-causality v2 (widened fixed reads) and completeness v2 against the pinned OAD.

crud-causality v2 must be v1 plus a listQuery on exactly assets, products,
contacts and projects, equal to all-records-selection.json's query overrides
for those lists, each naming a query parameter the list declares, and the
composition must pass the CRUD Causality validator (with v1's known rule-10
warnings). completeness v2 must keep every declaration of v1 and add exactly
those four, on top of crud-causality v2, and pass the Collection Completeness
validator. No provider is called; the pinned OAD is downloaded by its full-SHA
URL.
"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

SPECS = ROOT.parent / "openapi-extensions" / "spec"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


completeness = load("completeness_validate", SPECS / "collection-completeness" / "validate.py")
crud = load("crud_validate", SPECS / "crud-causality" / "validate.py")

PIN = "85a6105220036a98ef0d7cd6f228d4aae0036508"
FOLDER = ROOT / "APIs/moneybird.com/v2-readonly"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/moneybird.com/v2-readonly/openapi.yaml"
CRUD_V1 = f"crud-causality-{PIN}-overlay.yaml"
CRUD_V2 = f"crud-causality-v2-{PIN}-overlay.yaml"
COMPLETENESS_V1 = f"completeness-{PIN}-overlay.yaml"
COMPLETENESS_V2 = f"completeness-v2-{PIN}-overlay.yaml"
BASE = [f"auth-{PIN}-overlay.yaml", f"pagination-{PIN}-overlay.yaml"]
WIDENED = {"asset": "assets", "product": "products", "contact": "contacts", "project": "projects"}
KNOWN_WARNINGS = {
    "crudResources.verification.identity.urlTemplate: {administration_id} is neither bound nor "
    "in a collection's urlTemplate (rule 10, SHOULD)",
    "crudResources.moneybird_payments_mandate.identity.urlTemplate: {administration_id} is "
    "neither bound nor in a collection's urlTemplate (rule 10, SHOULD)",
    "crudResources.moneybird_payments_mandate.identity.urlTemplate: {contact_id} is neither "
    "bound nor in a collection's urlTemplate (rule 10, SHOULD)",
}


def overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


def crud_resources(document):
    for action in document["actions"]:
        resources = (action.get("update") or {}).get("crudResources")
        if action["target"] == "$.components" and resources:
            return resources
    raise AssertionError("no $.components action with crudResources")


def as_string(value):
    return "true" if value is True else "false" if value is False else str(value)


class MoneybirdWidenedReadsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.composed = copy.deepcopy(cls.original)
        for name in [*BASE, CRUD_V2, COMPLETENESS_V2]:
            apply(cls.composed, overlay(name))

    def resolve(self, node):
        while isinstance(node, dict) and "$ref" in node:
            target = self.original
            for part in node["$ref"][2:].split("/"):
                target = target[part]
            node = target
        return node

    def query(self, path):
        item = self.original["paths"][path]
        return {p["name"]: p for p in map(self.resolve, item["get"].get("parameters", []) + item.get("parameters", []))
                if p["in"] == "query"}

    def test_crud_v2_is_v1_plus_the_selection_as_list_queries(self):
        v1, v2 = crud_resources(overlay(CRUD_V1)), copy.deepcopy(crud_resources(overlay(CRUD_V2)))
        selection = {o["path"]: o["values"] for o in json.loads((FOLDER / "all-records-selection.json").read_text())
                     ["query_overrides"]}
        for name, collection_name in WIDENED.items():
            collection = v2[name]["collections"][collection_name]
            with self.subTest(collection=collection_name):
                expected = {k: as_string(v) for k, v in selection[collection["urlTemplate"]].items()}
                self.assertEqual(collection.pop("listQuery"), expected)
                self.assertLessEqual(set(expected), set(self.query(collection["urlTemplate"])))
        self.assertEqual(v2, v1)
        other_actions = [a for a in overlay(CRUD_V2)["actions"] if "crudResources" not in (a.get("update") or {})]
        self.assertEqual(other_actions,
                         [a for a in overlay(CRUD_V1)["actions"] if "crudResources" not in (a.get("update") or {})])

    def test_the_pinned_document_says_what_the_widening_relies_on(self):
        self.assertEqual(self.query("/{administration_id}/assets.json")["active"]["description"],
                         "Whether to include only active assets")
        self.assertEqual(self.query("/{administration_id}/assets.json")["active"]["examples"]
                         ["ReturnsAListOfAllAssets"]["value"], "false")
        products = self.query("/{administration_id}/products.json")["active"]
        self.assertIn("Set to false to include deactivated products.",
                      " ".join(json.dumps(products).split()))
        self.assertIn("include_archived", self.query("/{administration_id}/contacts.json"))
        projects = self.query("/{administration_id}/projects.json")["filter"]
        self.assertEqual(projects["schema"]["default"], "state:active")
        self.assertIn("replaces the defaults below entirely", " ".join(projects["description"].split()))

    def test_the_composition_passes_both_validators(self):
        warnings = []
        crud.validate(copy.deepcopy(self.composed), warnings)
        self.assertLessEqual(set(warnings), KNOWN_WARNINGS)
        completeness.validate(self.composed)
        reordered = copy.deepcopy(self.original)
        for name in [COMPLETENESS_V2, *BASE, CRUD_V2]:
            apply(reordered, overlay(name))
        self.assertEqual(reordered, self.composed)

    def test_completeness_v2_is_v1_plus_the_four_widened_lists(self):
        v1, v2 = crud_resources(overlay(COMPLETENESS_V1)), copy.deepcopy(crud_resources(overlay(COMPLETENESS_V2)))
        for name, collection in WIDENED.items():
            with self.subTest(collection=collection):
                self.assertEqual(v2.pop(name), {"collections": {collection: {"x-completeness": {
                    "absent": "removed", "notFound": "unavailable"}}}})
        self.assertEqual(v2, v1)

    def test_every_declared_list_reads_without_a_narrowing_default(self):
        # A declared list either sends no filter parameter, or its fixed read sets
        # every parameter whose documented default narrows it.
        narrowing = {"assets": {"active"}, "products": {"active"}, "contacts": {"include_archived"},
                     "projects": {"filter"}}
        for name, resource in crud_resources(overlay(COMPLETENESS_V2)).items():
            for collection_name in resource["collections"]:
                collection = self.composed["components"]["crudResources"][name]["collections"][collection_name]
                params = set(self.query(collection["urlTemplate"])) - {"page", "per_page"}
                with self.subTest(collection=collection_name):
                    self.assertLessEqual(narrowing.get(collection_name, set()), set(collection.get("listQuery", {})))
                    if collection_name not in narrowing:
                        self.assertEqual(params, set())

    def test_record_outcomes(self):
        for name, collection in WIDENED.items():
            declaration = self.composed["components"]["crudResources"][name]["collections"][collection]["x-completeness"]
            not_found = completeness.resource_not_found(self.composed, name)
            classify = lambda status, body=None: completeness.classify_read(
                declaration, None, "id", "4155", status, body, not_found)
            with self.subTest(collection=collection):
                self.assertEqual(not_found, "unavailable")
                self.assertEqual(classify(404, {"error": "Not found"}), "unavailable")
                self.assertEqual(classify(200, {"id": "4155"}), "present")
                self.assertEqual(classify(403), "unknown")

    def test_no_dated_catalog_selects_them(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            text = catalog.read_text(encoding="utf-8")
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(CRUD_V2, text)
                self.assertNotIn(COMPLETENESS_V2, text)


if __name__ == "__main__":
    unittest.main()
