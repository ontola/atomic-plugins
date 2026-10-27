"""Stripe pagination revision 2: a cursor read from the last item (Pagination Schemes 0.9.0, §4.3.3 rule a).

Composes pagination-v2 with the pinned OAD, runs the Pagination Schemes
validator, checks that the scheme sits on exactly the list operations that
take `starting_after` and answer `data` and `has_more`, that the pinned
document still describes `starting_after` as the place in the list, reads
synthetic pages with the reference `read_item_cursor`, and checks that v2
keeps every action target of v1. No dated catalog selects it. No provider is
called; the pinned OAD is downloaded by its full-SHA URL.
"""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

SPECS = ROOT.parent / "openapi-extensions" / "spec"
spec = importlib.util.spec_from_file_location("pagination_validate", SPECS / "pagination-schemes" / "validate.py")
pagination = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pagination)

PIN = "dec74da7a6785d5d5b83bc6a4cebc07336d67ec9"
FOLDER = ROOT / "APIs/stripe.com/2022-11-15"
V1 = f"pagination-{PIN}-overlay.yaml"
V2 = f"pagination-v2-{PIN}-overlay.yaml"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/stripe.com/2022-11-15/openapi.yaml"
PLACE = "defines your place in the list"


def overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


class StripePaginationV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.composed = copy.deepcopy(cls.original)
        apply(cls.composed, overlay(V2))

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
                if p.get("in") == "query"}

    def test_the_composition_passes_the_validator(self):
        pagination.validate(copy.deepcopy(self.composed))

    def test_exactly_the_starting_after_lists_use_the_scheme(self):
        lists = set()
        for path, item in self.original["paths"].items():
            if "get" not in item or "starting_after" not in self.query(path):
                continue
            schema = self.resolve(item["get"]["responses"]["200"]["content"]["application/json"]["schema"])
            self.assertLessEqual({"data", "has_more"}, set(schema["properties"]), path)
            lists.add(path)
        declared = {path for path, item in self.composed["paths"].items()
                    if "x-pagination" in (item.get("get") or {})}
        self.assertEqual(declared, lists)
        self.assertEqual(len(declared), 99)

    def test_every_list_applies_exactly_the_cursor_scheme(self):
        # Every operation, not a sample: an empty or extra x-pagination entry
        # would still count as "declared" above.
        applied = {path: item["get"]["x-pagination"] for path, item in self.composed["paths"].items()
                   if "x-pagination" in (item.get("get") or {})}
        self.assertEqual(len(applied), 99)
        for path, applications in applied.items():
            with self.subTest(path=path):
                self.assertEqual(applications, [{"scheme": "cursor"}])

    def test_the_cursor_scheme_is_exact(self):
        scheme = copy.deepcopy(self.composed["components"]["paginationSchemes"]["cursor"])
        self.assertTrue(scheme.pop("description"))
        self.assertEqual(scheme, {
            "type": "pageToken", "autoDetect": False,
            "request": {"queryParameters": {"starting_after": {"role": "cursor", "fromLastItem": "id"},
                                            "limit": {"role": "pageSize"}}},
            "response": {"envelope": {"itemsField": "data"}, "bodyFields": {"has_more": {"role": "hasMore"}}},
        })

    def test_the_pinned_document_describes_the_cursor_as_the_place_in_the_list(self):
        texts = {path: " ".join((self.query(path)["starting_after"].get("description") or "").split())
                 for path, item in self.composed["paths"].items() if "x-pagination" in (item.get("get") or {})}
        placed = {path for path, text in texts.items() if PLACE in text}
        self.assertEqual(set(texts) - placed, {"/v1/treasury/financial_accounts"})
        self.assertIn("the currency that defines your place in the list", texts["/v1/exchange_rates"])

    def test_reads_follow_the_last_id_until_has_more_is_false(self):
        scheme = self.composed["components"]["paginationSchemes"]["cursor"]
        pages = {None: {"object": "list", "data": [{"id": "cus_3"}, {"id": "cus_2"}], "has_more": True},
                 "cus_2": {"object": "list", "data": [{"id": "cus_1"}], "has_more": False}}
        sent = []

        def request(values):
            cursor = values.get(("queryParameters", "starting_after"))
            sent.append((cursor, values.get(("queryParameters", "limit"))))
            return pages[cursor]

        result = pagination.read_item_cursor(scheme, request, page_size=100)
        self.assertEqual([item["id"] for item in result["items"]], ["cus_3", "cus_2", "cus_1"])
        self.assertTrue(result["complete"])
        self.assertEqual(sent, [(None, 100), ("cus_2", 100)])

    def test_v2_keeps_every_target_of_v1(self):
        targets = lambda name: {action["target"] for action in overlay(name)["actions"]}
        self.assertLessEqual(targets(V1), targets(V2))

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn("stripe.com/2022-11-15/" + V2, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
