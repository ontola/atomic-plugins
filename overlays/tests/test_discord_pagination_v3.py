"""Discord pagination revision 3: ordered item cursors (Pagination Schemes 0.10.0).

Composes pagination-v3 with the pinned OAD alone and in place of v1 after the
catalog's Discord overlays, runs the Pagination Schemes validator (and CRUD
Causality on the catalog composition), checks the operations that use each
scheme and that their parameters exist, reads synthetic pages with the
reference `read_item_cursor` (joined private archived threads in descending
id order with `before`, ascending bans with `after`, and out-of-order pages
that must fail); Get Channel Messages stays without a scheme, and checks that v3
keeps every action of v2 apart from the declared changes. No dated catalog
selects it. No provider is called; the pinned OAD is downloaded by its
full-SHA URL.
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


pagination = load("pagination_validate", SPECS / "pagination-schemes" / "validate.py")
crud = load("crud_validate", SPECS / "crud-causality" / "validate.py")

PIN = "9d0d73c6b23cb07ca2d225fb8b3848fede322b21"
FOLDER = ROOT / "APIs/discord.com/10"
V1 = f"pagination-{PIN}-overlay.yaml"
V2 = f"pagination-v2-{PIN}-overlay.yaml"
V3 = f"pagination-v3-{PIN}-overlay.yaml"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/discord.com/10/openapi.yaml"
THREADS = "/channels/{channel_id}/users/@me/threads/archived/private"
MESSAGES = "/channels/{channel_id}/messages"
BANS = "/guilds/{guild_id}/bans"
EVENT_USERS = "/guilds/{guild_id}/scheduled-events/{guild_scheduled_event_id}/users"
CATALOG = "2026-10-12-tasks-box-pages.json"


def overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


def pages(*bodies):
    source = iter(list(bodies) + [[]])
    sent = []

    def request(values):
        sent.append(values)
        return next(source)
    return request, sent


class DiscordPaginationV3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.alone = copy.deepcopy(cls.original)
        apply(cls.alone, overlay(V3))
        discord = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                       if p["name"] == "discord")
        cls.names = [url.rsplit("/", 1)[1] for url in discord["overlays"]]
        cls.catalog = copy.deepcopy(cls.original)
        for name in cls.names:
            apply(cls.catalog, overlay(V3 if name == V1 else name))
        cls.schemes = cls.alone["components"]["paginationSchemes"]

    def test_the_compositions_pass_the_validators(self):
        self.assertIn(V1, self.names)
        pagination.validate(copy.deepcopy(self.alone))
        pagination.validate(copy.deepcopy(self.catalog))
        warnings = []
        crud.validate(copy.deepcopy(self.catalog), warnings)
        self.assertEqual(warnings, [])

    def test_operations_and_parameters(self):
        used = {path: operation["x-pagination"][0]["scheme"]
                for path, item in self.alone["paths"].items()
                for method, operation in item.items()
                if isinstance(operation, dict) and "x-pagination" in operation}
        self.assertEqual(used, {THREADS: "beforeThreadId", BANS: "afterUserId", EVENT_USERS: "afterUserId"})
        self.assertNotIn(MESSAGES, used)
        for path, cursor in ((THREADS, "before"), (BANS, "after"), (EVENT_USERS, "after")):
            names = {p["name"] for p in self.original["paths"][path]["get"].get("parameters", [])}
            self.assertTrue({cursor, "limit"} <= names, path)

    def test_threads_page_back_with_before_and_stop_at_has_more(self):
        scheme = self.schemes["beforeThreadId"]
        request, sent = pages({"threads": [{"id": "1300000000000000300"}, {"id": "1300000000000000200"}],
                               "has_more": True},
                              {"threads": [{"id": "1300000000000000100"}], "has_more": False})
        result = pagination.read_item_cursor(scheme, request, page_size=2)
        self.assertTrue(result["complete"])
        self.assertEqual([v.get(("queryParameters", "before")) for v in sent], [None, "1300000000000000200"])
        self.assertEqual({v[("queryParameters", "limit")] for v in sent}, {2})

    def test_out_of_order_threads_end_the_read(self):
        scheme = self.schemes["beforeThreadId"]
        for bodies in (({"threads": [{"id": "200"}, {"id": "300"}], "has_more": True},),
                       ({"threads": [{"id": "300"}, {"id": "200"}], "has_more": True},
                        {"threads": [{"id": "250"}], "has_more": False})):
            request, _ = pages(*bodies)
            with self.subTest(bodies=bodies), self.assertRaises(pagination.PageReadError):
                pagination.read_item_cursor(scheme, request, identity=lambda item: object())

    def test_ascending_bans_page_forward_with_after(self):
        scheme = self.schemes["afterUserId"]
        request, sent = pages([{"user": {"id": "10"}}, {"user": {"id": "20"}}], [{"user": {"id": "30"}}])
        result = pagination.read_item_cursor(scheme, request, identity=lambda item: item["user"]["id"])
        self.assertTrue(result["complete"])
        self.assertEqual([v.get(("queryParameters", "after")) for v in sent], [None, "20", "30"])
        request, _ = pages([{"user": {"id": "20"}}, {"user": {"id": "10"}}])
        with self.assertRaises(pagination.PageReadError):
            pagination.read_item_cursor(scheme, request, identity=lambda item: item["user"]["id"])

    def test_v3_keeps_v2(self):
        v2, v3 = overlay(V2), overlay(V3)
        self.assertEqual(v2["extends"], v3["extends"])
        schemes2 = v2["actions"][0]["update"]["paginationSchemes"]
        schemes3 = copy.deepcopy(v3["actions"][0]["update"]["paginationSchemes"])
        self.assertEqual(schemes3["afterUserId"]["request"]["queryParameters"]["after"].pop("order"), "ascending")
        schemes3.pop("beforeThreadId")
        self.assertEqual(schemes3, schemes2)
        rest2 = [a for a in v2["actions"][1:]]
        rest3 = [a for a in v3["actions"][1:] if a["target"] != f"$.paths['{THREADS}'].get"]
        self.assertEqual(rest3, rest2)

    def test_no_dated_catalog_selects_it(self):
        for catalog in (ROOT / "catalog").glob("*.json"):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(V3, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
