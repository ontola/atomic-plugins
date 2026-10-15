"""Moneybird pagination revision 2: the documented Link header's rel="next".

Composes pagination-v2 with the pinned OAD alone and in place of v1 after the
catalog's Moneybird overlays, runs the Pagination Schemes and CRUD Causality
validators, checks that it applies to exactly v1's lists and that each takes
`page` (the parameter the documented links carry), follows links of the
documented shape with the reference `resolve_link` (same origin; another
origin refused), and checks that no dated catalog selects it. No provider is
called; the pinned OAD is downloaded by its full-SHA URL.
"""
import copy
import importlib.util
import json
from pathlib import Path
import re
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


pagination = load("pagination_validate", SPECS / "pagination-schemes" / "validate.py")
crud = load("crud_validate", SPECS / "crud-causality" / "validate.py")

PIN = "85a6105220036a98ef0d7cd6f228d4aae0036508"
FOLDER = ROOT / "APIs/moneybird.com/v2-readonly"
V1 = f"pagination-{PIN}-overlay.yaml"
V2 = f"pagination-v2-{PIN}-overlay.yaml"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/moneybird.com/v2-readonly/openapi.yaml"
CATALOG = "2026-10-12-tasks-box-pages.json"
SERVER = "https://moneybird.com/api/v2"
# The published crud-causality overlay's rule-10 warnings, as test_crud_reads_in_catalogs.py lists them.
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


def next_target(header):
    """The rel="next" target of a Link header (RFC 8288), enough for the documented shape."""
    for target, params in re.findall(r"<([^>]*)>((?:\s*;\s*[^,;]+)*)", header or ""):
        if re.search(r';\s*rel="?([^";]*\s)?next(\s[^";]*)?"?', params):
            return target
    return None


class MoneybirdPaginationV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.alone = copy.deepcopy(cls.original)
        apply(cls.alone, overlay(V2))
        moneybird = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                         if p["name"] == "moneybird")
        cls.names = [url.rsplit("/", 1)[1] for url in moneybird["overlays"]]
        cls.catalog = copy.deepcopy(cls.original)
        for name in cls.names:
            apply(cls.catalog, overlay(V2 if name == V1 else name))

    def resolve(self, node):
        while isinstance(node, dict) and "$ref" in node:
            target = self.original
            for part in node["$ref"][2:].split("/"):
                target = target[part]
            node = target
        return node

    def test_the_compositions_pass_the_validators(self):
        self.assertIn(V1, self.names)
        pagination.validate(copy.deepcopy(self.alone))
        pagination.validate(copy.deepcopy(self.catalog))
        warnings = []
        crud.validate(copy.deepcopy(self.catalog), warnings)
        self.assertLessEqual(set(warnings), KNOWN_WARNINGS)

    def test_it_applies_to_exactly_the_lists_v1_paged(self):
        v1 = {action["target"] for action in overlay(V1)["actions"]}
        v2 = {action["target"] for action in overlay(V2)["actions"]}
        self.assertEqual(v1, v2)
        lists = [target for target in v2 if target.startswith("$.paths")]
        self.assertEqual(len(lists), 19)
        for target in lists:
            path = re.match(r"\$\.paths\['(.*)'\]\.get", target).group(1)
            names = {self.resolve(p)["name"] for p in self.original["paths"][path]["get"].get("parameters", [])}
            with self.subTest(path=path):
                self.assertLessEqual({"page", "per_page"}, names)
                self.assertEqual(self.alone["paths"][path]["get"]["x-pagination"], [{"scheme": "linkHeader"}])

    def test_no_page_size_is_sent(self):
        # The documented example link carries only `page`; a per_page the
        # client sent might not survive into the next link.
        scheme = self.alone["components"]["paginationSchemes"]["linkHeader"]
        self.assertEqual(scheme["type"], "nextLink")
        self.assertNotIn("request", scheme)
        self.assertEqual(scheme["response"]["headers"]["Link"]["role"], "nextLink")
        self.assertEqual(self.original["components"]["headers"]["link"]["description"], "Pagination links (next, prev)")

    def test_documented_links_are_followed_on_the_same_origin_only(self):
        documented = ('<https://moneybird.com/api/v2/contacts.json?page=3>; rel="next", '
                      '<https://moneybird.com/api/v2/contacts.json?page=1>; rel="prev"')
        request = f"{SERVER}/123/contacts.json?page=2"
        target = next_target(documented)
        self.assertEqual(pagination.resolve_link(target, request_url=request, server_url=SERVER),
                         "https://moneybird.com/api/v2/contacts.json?page=3")
        # The last page: a Link with only rel="prev" (or none) ends the read.
        self.assertIsNone(next_target('<https://moneybird.com/api/v2/contacts.json?page=1>; rel="prev"'))
        self.assertIsNone(pagination.resolve_link(next_target(None), request_url=request, server_url=SERVER))
        with self.assertRaises(pagination.LinkRefused):
            pagination.resolve_link("https://example.com/api/v2/contacts.json?page=3", request_url=request,
                                    server_url=SERVER)

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn("moneybird.com/v2-readonly/" + V2, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
