"""Discord pagination revision 4: the guild audit log paged back by `before`.

Composes pagination-v4 with the pinned OAD alone and in place of v1 after the
catalog's Discord overlays, runs the Pagination Schemes validator (and CRUD
Causality on the catalog composition), checks the operations that use each
scheme and that their parameters exist, reads synthetic audit log pages with
the reference `read_item_cursor` (descending entry ids with `before`, an
empty page ending the read, and out-of-order pages that must fail), and checks
that v4 is v3 plus the audit log scheme and its application. No dated catalog
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
V3 = f"pagination-v3-{PIN}-overlay.yaml"
V4 = f"pagination-v4-{PIN}-overlay.yaml"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/discord.com/10/openapi.yaml"
AUDIT = "/guilds/{guild_id}/audit-logs"
THREADS = "/channels/{channel_id}/users/@me/threads/archived/private"
BANS = "/guilds/{guild_id}/bans"
EVENT_USERS = "/guilds/{guild_id}/scheduled-events/{guild_scheduled_event_id}/users"
CATALOG = "2026-10-12-tasks-box-pages.json"


def overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


def pages(*bodies):
    source = iter(list(bodies) + [{"audit_log_entries": [], "users": []}])
    sent = []

    def request(values):
        sent.append(values)
        return next(source)
    return request, sent


def entries(*ids):
    return {"audit_log_entries": [{"id": i, "action_type": 1} for i in ids], "users": [{"id": "1"}]}


class DiscordPaginationV4Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.alone = copy.deepcopy(cls.original)
        apply(cls.alone, overlay(V4))
        discord = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                       if p["name"] == "discord")
        cls.names = [url.rsplit("/", 1)[1] for url in discord["overlays"]]
        cls.catalog = copy.deepcopy(cls.original)
        for name in cls.names:
            apply(cls.catalog, overlay(V4 if name == V1 else name))
        cls.scheme = cls.alone["components"]["paginationSchemes"]["beforeEntryId"]

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
        self.assertEqual(used, {AUDIT: "beforeEntryId", THREADS: "beforeThreadId",
                                BANS: "afterUserId", EVENT_USERS: "afterUserId"})
        names = {p["name"] for p in self.original["paths"][AUDIT]["get"]["parameters"]}
        self.assertTrue({"before", "limit"} <= names)
        response = self.original["components"]["schemas"]["GuildAuditLogResponse"]
        self.assertIn("audit_log_entries", response["required"])
        self.assertIn("id", self.original["components"]["schemas"]["AuditLogEntryResponse"]["required"])

    def test_entries_page_back_with_before_until_an_empty_page(self):
        request, sent = pages(entries("1300000000000000300", "1300000000000000200"),
                              entries("1300000000000000100"))
        result = pagination.read_item_cursor(self.scheme, request, page_size=2)
        self.assertTrue(result["complete"])
        self.assertEqual([v.get(("queryParameters", "before")) for v in sent],
                         [None, "1300000000000000200", "1300000000000000100"])
        self.assertEqual({v[("queryParameters", "limit")] for v in sent}, {2})
        self.assertNotIn(("queryParameters", "after"), {k for v in sent for k in v})

    def test_out_of_order_entries_end_the_read(self):
        for bodies in ((entries("200", "300"),),
                       (entries("300", "200"), entries("250"))):
            request, _ = pages(*bodies)
            with self.subTest(bodies=bodies), self.assertRaises(pagination.PageReadError):
                pagination.read_item_cursor(self.scheme, request, identity=lambda item: object())

    def test_v4_is_v3_plus_the_audit_log(self):
        v3, v4 = overlay(V3), overlay(V4)
        self.assertEqual(v3["extends"], v4["extends"])
        schemes4 = copy.deepcopy(v4["actions"][0]["update"]["paginationSchemes"])
        schemes4.pop("beforeEntryId")
        self.assertEqual(schemes4, v3["actions"][0]["update"]["paginationSchemes"])
        rest4 = [a for a in v4["actions"][1:] if a["target"] != f"$.paths['{AUDIT}'].get"]
        self.assertEqual(rest4, v3["actions"][1:])

    def test_no_dated_catalog_selects_it(self):
        for catalog in (ROOT / "catalog").glob("*.json"):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(V4, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
