"""Google Calendar v3: the event list as a deletion feed (Deletion Feeds 0.2.0-draft).

Composes the Google Calendar entry of catalog/2026-10-12-tasks-box-pages.json,
plus the read-tombstone overlay, with the unpublished deletion-feed overlay,
and checks the declaration against the composed document: the feed is the
events collection's own list operation, its cursor is a query parameter of
that operation, the response field, items array and tombstone field are in
the pinned response schema, the list is paginated, and the pinned document
still says what the overlay relies on. It also checks that the overlay
composes in either order with the crud-causality overlay and that the CRUD
Causality validator passes. The pinned OAD is downloaded by its full-SHA URL;
no provider is called.
"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

PIN = "32237fa5d14aa887dc9f3923395dac971e00a36c"
FOLDER = ROOT / "APIs/googleapis.com/calendar/v3"
OVERLAY = f"deletion-feed-{PIN}-overlay.yaml"
TOMBSTONES = f"read-tombstone-{PIN}-overlay.yaml"
CATALOG = "2026-10-12-tasks-box-pages.json"
LIST = "/calendars/{calendarId}/events"

spec = importlib.util.spec_from_file_location(
    "crud_validate", ROOT.parent / "openapi-extensions" / "spec" / "crud-causality" / "validate.py")
crud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crud)


def load(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


class CalendarDeletionFeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        calendar = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                        if p["name"] == "google-calendar")
        cls.catalogued = [yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8"))
                          for url in calendar["overlays"]]
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(calendar["openapi"], Path(cache))[0])
        cls.document = copy.deepcopy(cls.original)
        for overlay in [*cls.catalogued, load(TOMBSTONES), load(OVERLAY)]:
            apply(cls.document, overlay)
        cls.feed = cls.document["components"]["crudResources"]["event"]["collections"]["events"]["x-deletion-feed"]

    def test_the_feed_is_the_collection_list_itself(self):
        operation = self.document["paths"][LIST]["get"]
        self.assertEqual(operation["operationId"], self.feed["operationId"])
        self.assertEqual(self.document["components"]["crudResources"]["event"]["collections"]["events"]["urlTemplate"],
                         LIST)
        # Paginated, so a feed read follows every page (the token is on the last one).
        self.assertIn("x-pagination", operation)

    def test_the_declaration_names_what_the_pinned_document_has(self):
        operation = self.original["paths"][LIST]["get"]
        names = set()
        for parameter in operation.get("parameters", []) + self.original["paths"][LIST].get("parameters", []):
            while "$ref" in parameter:
                node = self.original
                for part in parameter["$ref"][2:].split("/"):
                    node = node[part]
                parameter = node
            names.add(parameter["name"])
        self.assertIn(self.feed["cursor"]["parameter"], names)
        events = self.original["components"]["schemas"]["Events"]["properties"]
        self.assertIn(self.feed["cursor"]["responseField"], events)
        self.assertEqual(events[self.feed["envelope"]["itemsField"]]["type"], "array")
        self.assertEqual(self.feed["tombstone"], {"field": "status", "values": ["cancelled"]})
        self.assertEqual(self.feed["cursor"]["expiredStatuses"], [410])

    def test_the_pinned_document_still_says_what_the_overlay_relies_on(self):
        raw = json.dumps(self.original)
        for words in ("All events deleted since the previous list request will always be in the result set",
                      "returned on the last page of results from the previous list request",
                      "The event is cancelled (deleted)."):
            self.assertIn(words, raw)

    def test_it_composes_in_either_order_with_the_crud_overlay(self):
        reordered = copy.deepcopy(self.original)
        for overlay in [load(OVERLAY), *self.catalogued, load(TOMBSTONES)]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.document)
        warnings = []
        crud.validate(copy.deepcopy(self.document), warnings)
        self.assertEqual(warnings, [])

    def test_it_adds_only_the_deletion_feed(self):
        overlay = load(OVERLAY)
        self.assertEqual([a["target"] for a in overlay["actions"]], ["$.components"])
        events = overlay["actions"][0]["update"]["crudResources"]["event"]
        self.assertEqual(set(events), {"collections"})
        self.assertEqual(set(events["collections"]["events"]), {"x-deletion-feed"})

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test, and
        # selects the read-tombstone overlay with it.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
