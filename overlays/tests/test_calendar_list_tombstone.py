"""Google Calendar v3: cancelled events in the event list as list tombstones (Deletion Feeds 0.3.0-draft §4.5).

Composes the Google Calendar entry of catalog/2026-10-12-box-pagination-v2.json
(the newest dated catalog with Calendar when this was written) with the
unpublished list-tombstone overlay after it, and checks that the declaration
passes the Deletion Feeds validator, sits on the event list operation that the
composed CRUD Causality metadata names as the `event` collection's list, that
the reference `list_tombstone` reads a cancelled event as a deletion and a
cancelled exception as a member, and that the pinned document still says what
the overlay relies on. No dated catalog selects the overlay yet. The pinned
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
OVERLAY = f"list-tombstone-{PIN}-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"
LIST = "/calendars/{calendarId}/events"

spec = importlib.util.spec_from_file_location(
    "deletion_feeds_validate", ROOT.parent / "openapi-extensions" / "spec" / "deletion-feeds" / "validate.py")
feeds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feeds)


class CalendarListTombstoneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        calendar = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                        if p["name"] == "google-calendar")
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(calendar["openapi"], Path(cache))[0])
        cls.document = copy.deepcopy(cls.original)
        for url in calendar["overlays"]:
            relative = url.split("/overlays/", 1)[1]
            apply(cls.document, yaml.safe_load((ROOT / relative).read_text(encoding="utf-8")))
        apply(cls.document, yaml.safe_load((ROOT / "APIs/googleapis.com/calendar/v3" / OVERLAY).read_text(encoding="utf-8")))

    def test_the_declaration_is_valid_and_on_the_event_list(self):
        feeds.validate(self.document)
        operation = self.document["paths"][LIST]["get"]
        self.assertEqual(operation["x-crud"]["action"], "list")
        self.assertEqual(operation["x-crud"]["resource"], "event")
        self.assertNotIn("x-list-tombstone", self.document["components"]["crudResources"]["event"])

    def test_cancelled_events_are_deletions_and_cancelled_exceptions_members(self):
        declaration = self.document["paths"][LIST]["get"]["x-list-tombstone"]
        self.assertTrue(feeds.list_tombstone(declaration, {"id": "e1", "status": "cancelled"}))
        self.assertFalse(feeds.list_tombstone(declaration, {
            "id": "e2_20261012T090000Z", "status": "cancelled", "recurringEventId": "e2",
            "originalStartTime": {"dateTime": "2026-10-12T09:00:00Z"}}))
        self.assertFalse(feeds.list_tombstone(declaration, {"id": "e1", "status": "confirmed"}))

    def test_the_pinned_document_still_says_what_the_overlay_relies_on(self):
        status = self.original["components"]["schemas"]["Event"]["properties"]["status"]["description"]
        for words in ('"cancelled" - The event is cancelled (deleted).',
                      "The list method returns cancelled events only on incremental sync",
                      "or if the showDeleted flag is set to true.",
                      "Cancelled exceptions of an uncancelled recurring event indicate that this instance "
                      "should no longer be presented to the user. Clients should store these events",
                      "Cancelled exceptions are only guaranteed to have values for the id, recurringEventId",
                      "All other cancelled events represent deleted events.",
                      "can be restored (undeleted)"):
            self.assertIn(words, status)
        names = [p.get("name") for p in self.original["paths"][LIST]["get"].get("parameters", [])]
        self.assertIn("showDeleted", names)

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
