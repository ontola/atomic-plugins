"""Google Calendar v3: the event list as a deletion feed (Deletion Feeds 0.3.0-draft).

Composes the Google Calendar entry of catalog/2026-10-12-tasks-box-pages.json
(which selects app-crud-causality), plus the read-tombstone-v2 and
list-tombstone overlays, with the unpublished deletion-feed overlay, and
checks the declaration against the composed document: the feed is the events
collection's own list operation, its cursor is a query parameter of that
operation, the response field, items array and tombstone field are in the
pinned response schema, the list is paginated, its tombstone has the same
marker and `except` as the read and list tombstones, and the pinned document
still says what the overlay relies on. It also checks that the overlay
composes in either order, with app-crud-causality and with crud-causality,
and that the Deletion Feeds and CRUD Causality validators pass. The pinned
OAD is downloaded by its full-SHA URL; no provider is called.
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
TOMBSTONES = [f"read-tombstone-v2-{PIN}-overlay.yaml", f"list-tombstone-{PIN}-overlay.yaml"]
CRUD = [f"app-crud-causality-{PIN}-overlay.yaml", f"crud-causality-{PIN}-overlay.yaml"]
# The published app-crud-causality revision's one finding under the current
# CRUD Causality validator, as overlays/tests/test_crud_reads_in_catalogs.py
# lists it; it is not this overlay's.
KNOWN_CRUD_ERRORS = {
    CRUD[0]: {"paths./calendars/{calendarId}/events/{eventId}.patch.x-crud.mode: required for action update (rule 5)"},
    CRUD[1]: set(),
}
CATALOG = "2026-10-12-tasks-box-pages.json"
LIST = "/calendars/{calendarId}/events"

spec = importlib.util.spec_from_file_location(
    "crud_validate", ROOT.parent / "openapi-extensions" / "spec" / "crud-causality" / "validate.py")
crud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crud)
spec = importlib.util.spec_from_file_location(
    "deletion_feeds_validate", ROOT.parent / "openapi-extensions" / "spec" / "deletion-feeds" / "validate.py")
feeds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feeds)


def load(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


class CalendarDeletionFeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        calendar = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                        if p["name"] == "google-calendar")
        cls.catalogued = [yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8"))
                          for url in calendar["overlays"]]
        # The catalog's overlays other than its crud-causality one.
        cls.others = [yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8"))
                      for url in calendar["overlays"] if not url.endswith("/" + CRUD[0])]
        assert len(cls.others) == len(cls.catalogued) - 1
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(calendar["openapi"], Path(cache))[0])
        cls.document = copy.deepcopy(cls.original)
        for overlay in [*cls.catalogued, *map(load, TOMBSTONES), load(OVERLAY)]:
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
        self.assertEqual(self.feed["tombstone"], {"field": "status", "values": ["cancelled"],
                                                  "except": [{"field": "recurringEventId", "present": True}]})
        self.assertEqual(self.feed["cursor"]["expiredStatuses"], [410])

    def test_the_pinned_document_still_says_what_the_overlay_relies_on(self):
        raw = json.dumps(self.original)
        for words in ("All events deleted since the previous list request will always be in the result set",
                      "returned on the last page of results from the previous list request",
                      "The event is cancelled (deleted)."):
            self.assertIn(words, raw)

    def test_it_composes_in_either_order_with_each_crud_overlay(self):
        reordered = copy.deepcopy(self.original)
        for overlay in [load(OVERLAY), *self.catalogued, *map(load, TOMBSTONES)]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.document)
        for name in CRUD:
            with self.subTest(crud=name):
                orders = [[*self.others, load(name), load(OVERLAY)],
                      [load(OVERLAY), *self.others, load(name)]]
                composed = []
                for order in orders:
                    document = copy.deepcopy(self.original)
                    for overlay in order:
                        apply(document, overlay)
                    composed.append(document)
                self.assertEqual(composed[0], composed[1])
                events = composed[0]["components"]["crudResources"]["event"]["collections"]["events"]
                self.assertEqual(events["urlTemplate"], LIST)
                self.assertEqual(events["x-deletion-feed"], self.feed)
                warnings = []
                try:
                    crud.validate(copy.deepcopy(composed[0]), warnings)
                    errors = set()
                except ValueError as raised:
                    errors = set(str(raised).splitlines())
                self.assertEqual(errors, KNOWN_CRUD_ERRORS[name])
                self.assertEqual(warnings, [])
                feeds.validate(composed[0])

    def test_one_reading_of_cancelled_wherever_an_event_is_answered(self):
        feeds.validate(self.document)
        read = self.document["paths"][LIST + "/{eventId}"]["get"]["x-read-tombstone"]
        listed = self.document["paths"][LIST]["get"]["x-list-tombstone"]
        tombstone = self.feed["tombstone"]
        for other in (read, listed):
            self.assertEqual({k: other[k] for k in ("field", "values", "except")}, tombstone)
        self.assertTrue(feeds.tombstone(tombstone, {"id": "a", "status": "cancelled"}))
        # A cancelled exception of a recurring event is stored, not removed.
        self.assertFalse(feeds.tombstone(tombstone, {"id": "a_20261013", "status": "cancelled",
                                                     "recurringEventId": "a"}))
        self.assertFalse(feeds.tombstone(tombstone, {"id": "a", "status": "confirmed"}))

    def test_it_adds_only_the_deletion_feed(self):
        overlay = load(OVERLAY)
        self.assertEqual([a["target"] for a in overlay["actions"]], ["$.components"])
        events = overlay["actions"][0]["update"]["crudResources"]["event"]
        self.assertEqual(set(events), {"collections"})
        self.assertEqual(set(events["collections"]["events"]), {"x-deletion-feed"})

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test, and
        # selects read-tombstone-v2 (not the first revision) with it, and not
        # pagination-v2 ("Full listing only: omit syncToken").
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
