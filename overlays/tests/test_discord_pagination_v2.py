"""Discord pagination revision 2: a cursor read from the last item (Pagination Schemes 0.9.0).

Composes pagination-v2 with the pinned OAD alone and in place of v1 after the
catalog's Discord overlays, runs the Pagination Schemes validator (and CRUD
Causality on the catalog composition), checks that the scheme sits on
exactly the two operations whose order Discord documents and that their
parameters exist in the pinned document, reads synthetic pages with the
reference `read_item_cursor`, and checks that v2 keeps every action target
of v1. No dated catalog selects it. No provider is called; the pinned OAD is
downloaded by its full-SHA URL.
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
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/discord.com/10/openapi.yaml"
BANS = "/guilds/{guild_id}/bans"
EVENT_USERS = "/guilds/{guild_id}/scheduled-events/{guild_scheduled_event_id}/users"
CATALOG = "2026-10-12-tasks-box-pages.json"


def overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


class DiscordPaginationV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.alone = copy.deepcopy(cls.original)
        apply(cls.alone, overlay(V2))
        discord = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                       if p["name"] == "discord")
        cls.names = [url.rsplit("/", 1)[1] for url in discord["overlays"]]
        cls.catalog = copy.deepcopy(cls.original)
        for name in cls.names:
            apply(cls.catalog, overlay(V2 if name == V1 else name))

    def test_the_compositions_pass_the_validators(self):
        self.assertIn(V1, self.names)
        pagination.validate(copy.deepcopy(self.alone))
        pagination.validate(copy.deepcopy(self.catalog))
        warnings = []
        crud.validate(copy.deepcopy(self.catalog), warnings)
        self.assertEqual(warnings, [])

    def test_only_the_two_documented_ascending_lists_use_the_scheme(self):
        found = {path for path, item in self.alone["paths"].items()
                 for method, operation in item.items()
                 if isinstance(operation, dict) and "x-pagination" in operation}
        self.assertEqual(found, {BANS, EVENT_USERS})
        for path in (BANS, EVENT_USERS):
            names = set()
            for parameter in self.original["paths"][path]["get"].get("parameters", []):
                names.add(parameter["name"])
            with self.subTest(path=path):
                self.assertLessEqual({"after", "limit"}, names)
        # Bans always carry the user; scheduled-event users may not (an error then, §4.3.3).
        schemas = self.original["components"]["schemas"]
        self.assertIn("user", schemas["GuildBanResponse"]["required"])
        self.assertNotIn("user", schemas["ScheduledEventUserResponse"].get("required", []))

    def test_the_scheme_and_its_applications_are_exact(self):
        scheme = copy.deepcopy(self.alone["components"]["paginationSchemes"]["afterUserId"])
        self.assertTrue(scheme.pop("description"))
        self.assertEqual(scheme, {
            "type": "pageToken", "autoDetect": False,
            "request": {"queryParameters": {"after": {"role": "cursor", "fromLastItem": "user.id"},
                                            "limit": {"role": "pageSize"}}},
        })
        for document in (self.alone, self.catalog):
            for path in (BANS, EVENT_USERS):
                with self.subTest(path=path):
                    self.assertEqual(document["paths"][path]["get"]["x-pagination"], [{"scheme": "afterUserId"}])

    def test_reads_follow_the_last_user_id_until_an_empty_page(self):
        scheme = self.alone["components"]["paginationSchemes"]["afterUserId"]
        pages = {None: [{"user": {"id": "10"}, "reason": None}, {"user": {"id": "20"}, "reason": "spam"}],
                 "20": [{"user": {"id": "30"}, "reason": None}],
                 "30": []}
        sent = []

        def request(values):
            cursor = values.get(("queryParameters", "after"))
            sent.append((cursor, values.get(("queryParameters", "limit"))))
            return pages[cursor]

        result = pagination.read_item_cursor(scheme, request, page_size=1000,
                                             identity=lambda item: item["user"]["id"])
        self.assertEqual([item["user"]["id"] for item in result["items"]], ["10", "20", "30"])
        self.assertTrue(result["complete"])
        self.assertEqual(sent, [(None, 1000), ("20", 1000), ("30", 1000)])

    def test_an_item_without_a_user_ends_the_read_with_an_error(self):
        scheme = self.alone["components"]["paginationSchemes"]["afterUserId"]
        with self.assertRaises(pagination.PageReadError):
            pagination.read_item_cursor(scheme, lambda values: [{"response": 1}],
                                        identity=lambda item: json.dumps(item))

    def test_v2_keeps_every_target_of_v1(self):
        targets = lambda name: {action["target"] for action in overlay(name)["actions"]}
        self.assertLessEqual(targets(V1), targets(V2))
        guilds = self.alone["paths"]["/users/@me/guilds"]["get"]
        self.assertNotIn("x-pagination", guilds)

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(V2, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
