"""Catalog collections whose list operation has no pagination scheme, and why.

Syncables reads such a list once and takes the answer as the whole list. The
evidence for each is the pinned OAD (see overlays/README.md, "Lists without
pagination"): Moneybird's twelve lists below have no page parameter in the
document generated from Moneybird's official OpenAPI v2 specification, while
its paginated lists have `page` and `per_page`; Discord's guild list pages,
but a non-bot user's guilds fit in one 200-guild answer, which the catalog's
crud-causality overlay asks for. This test keeps that evidence current: if a
pinned document gains a page parameter, or a pagination overlay starts to
target one of these operations, it fails. Financial mutations are not here:
that list has no page parameter either but is "Limited to 100 financial
mutations", which a separate range-window overlay addresses. No provider is
called.
"""
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, fetch

MONEYBIRD_PIN = "85a6105220036a98ef0d7cd6f228d4aae0036508"
DISCORD_PIN = "9d0d73c6b23cb07ca2d225fb8b3848fede322b21"
MONEYBIRD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{MONEYBIRD_PIN}/APIs/moneybird.com/v2-readonly/openapi.yaml"
DISCORD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{DISCORD_PIN}/APIs/discord.com/10/openapi.yaml"

# Path -> words of its description the README quotes, or None.
UNPAGED = {
    "/{administration_id}/financial_accounts.json": "Only active financial accounts are returned",
    "/{administration_id}/identities.json": None,
    "/{administration_id}/ledger_accounts.json": "Pagination is not supported for this endpoint.",
    "/{administration_id}/subscriptions.json": "Lists the subscriptions of a single contact.",
    "/{administration_id}/users.json": None,
    "/{administration_id}/webhooks.json": "List all registered webhooks for the administration.",
    "/{administration_id}/workflows.json": "Returns a list of all the workflows of an administration.",
    "/{administration_id}/custom_fields.json": None,
    "/{administration_id}/document_styles.json": "Returns a list of all document styles.",
    "/{administration_id}/task_list_templates.json": "Returns all task list templates in the administration.",
    "/{administration_id}/contacts/{contact_id}/additional_charges.json": None,
    "/{administration_id}/subscriptions/{id}/additional_charges.json": None,
}
PAGE_PARAMETERS = {"page", "per_page", "offset", "cursor", "limit", "after", "before", "next_page"}


def query_names(document, path):
    item = document["paths"][path]
    names = set()
    for parameter in item["get"].get("parameters", []) + item.get("parameters", []):
        while "$ref" in parameter:
            node = document
            for part in parameter["$ref"][2:].split("/"):
                node = node[part]
            parameter = node
        if parameter["in"] == "query":
            names.add(parameter["name"])
    return names


def overlays_for(platform):
    names = set()
    for catalog in sorted((ROOT / "catalog").glob("*.json")):
        for entry in json.loads(catalog.read_text(encoding="utf-8"))["platforms"]:
            if entry["name"] == platform:
                names.update(url.split("/overlays/", 1)[1] for url in entry.get("overlays", []))
    return sorted(names)


class UnpagedListsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.moneybird = yaml.safe_load(fetch(MONEYBIRD, Path(cache))[0])
            cls.discord = yaml.safe_load(fetch(DISCORD, Path(cache))[0])

    def test_moneybird_paginated_lists_have_page_parameters(self):
        # The contrast the evidence rests on: a list the document paginates says so.
        for path in ("/{administration_id}/contacts.json", "/{administration_id}/tax_rates.json"):
            with self.subTest(path=path):
                self.assertLessEqual({"page", "per_page"}, query_names(self.moneybird, path))

    def test_moneybird_unpaged_lists_have_no_page_parameter(self):
        for path, words in UNPAGED.items():
            with self.subTest(path=path):
                self.assertEqual(query_names(self.moneybird, path) & PAGE_PARAMETERS, set())
                if words:
                    self.assertIn(words, " ".join(self.moneybird["paths"][path]["get"]["description"].split()))

    def test_no_catalogued_moneybird_pagination_overlay_targets_them(self):
        for name in overlays_for("moneybird"):
            overlay = yaml.safe_load((ROOT / name).read_text(encoding="utf-8"))
            for path in UNPAGED:
                for action in overlay["actions"]:
                    if action["target"] in (f"$.paths['{path}'].get", f'$.paths["{path}"].get'):
                        with self.subTest(overlay=name, path=path):
                            self.assertNotIn("x-pagination", action.get("update", {}))

    def test_discord_guilds_are_read_in_one_200_guild_answer(self):
        names = query_names(self.discord, "/users/@me/guilds")
        self.assertLessEqual({"before", "after", "limit"}, names)
        limit = next(p for p in self.discord["paths"]["/users/@me/guilds"]["get"]["parameters"]
                     if p.get("name") == "limit")
        self.assertEqual(limit["schema"]["maximum"], 200)
        for name in overlays_for("discord"):
            if "crud-causality" not in name:
                continue
            with self.subTest(overlay=name):
                crud = yaml.safe_load((ROOT / name).read_text(encoding="utf-8"))
                guilds = crud["actions"][0]["update"]["crudResources"]["guild"]["collections"]["myGuilds"]
                self.assertEqual(guilds["x-list-query"], {"limit": 200})


if __name__ == "__main__":
    unittest.main()
