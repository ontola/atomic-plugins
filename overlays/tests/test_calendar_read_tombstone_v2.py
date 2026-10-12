"""Google Calendar v3: cancelled events as read tombstones, revision 2 (Deletion Feeds 0.3.0-draft §4.3, §4.4).

Composes the Google Calendar entry of catalog/2026-10-12-box-pagination-v2.json
(the newest dated catalog when this was written) with the unpublished
read-tombstone overlay after it, and checks that the
declaration has the Tombstone Object's shape (§4.3), sits on the event read
operation that the composed CRUD Causality metadata names as the `event`
resource's read, that the composition still passes the CRUD Causality
collection-read validator, and that the pinned document still says what the
overlay relies on. No dated catalog selects the overlay yet. The pinned OAD
is downloaded by its full-SHA URL; no provider is called.
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
OVERLAY = f"read-tombstone-v2-{PIN}-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"
READ = "/calendars/{calendarId}/events/{eventId}"

feeds_spec = importlib.util.spec_from_file_location(
    "deletion_feeds_validate", ROOT.parent / "openapi-extensions" / "spec" / "deletion-feeds" / "validate.py")
feeds = importlib.util.module_from_spec(feeds_spec)
feeds_spec.loader.exec_module(feeds)

spec = importlib.util.spec_from_file_location(
    "crud_validate", ROOT.parent / "openapi-extensions" / "spec" / "crud-causality" / "validate.py")
crud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crud)


class CalendarReadTombstoneTests(unittest.TestCase):
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

    def test_the_declaration_is_a_tombstone_object_on_the_event_read(self):
        operation = self.document["paths"][READ]["get"]
        self.assertEqual(operation["x-read-tombstone"], {
            "field": "status", "values": ["cancelled"],
            "except": [{"field": "recurringEventId", "present": True}]})
        # The composed CRUD Causality metadata makes this the event resource's read.
        self.assertEqual(operation["x-crud"], {"action": "read", "resource": "event"})
        identity = self.document["components"]["crudResources"]["event"]["identity"]
        self.assertEqual(identity["urlTemplate"], READ)
        self.assertNotIn("x-read-tombstone", self.document["components"]["crudResources"]["event"])

    def test_the_composition_passes_the_collection_read_validator(self):
        warnings = []
        crud.validate(self.document, warnings)
        self.assertEqual(warnings, [])

    def test_the_pinned_document_still_says_what_the_overlay_relies_on(self):
        status = self.original["components"]["schemas"]["Event"]["properties"]["status"]["description"]
        for words in ('"cancelled" - The event is cancelled (deleted).',
                      "The get method always returns them.",
                      "All other cancelled events represent deleted events.",
                      "Cancelled exceptions of an uncancelled recurring event indicate that this instance "
                      "should no longer be presented to the user.",
                      "can be restored (undeleted)"):
            self.assertIn(words, status)
        self.assertEqual(self.original["paths"][READ]["get"]["operationId"], "calendar.events.get")

    def test_one_reading_with_the_list_tombstone(self):
        feeds.validate(self.document)
        declaration = self.document["paths"][READ]["get"]["x-read-tombstone"]
        listed = yaml.safe_load((ROOT / "APIs/googleapis.com/calendar/v3"
                                 / f"list-tombstone-{PIN}-overlay.yaml").read_text(encoding="utf-8"))
        self.assertEqual(listed["actions"][0]["update"]["x-list-tombstone"], declaration)
        exception = {"id": "e2_1", "status": "cancelled", "recurringEventId": "e2"}
        self.assertFalse(feeds.read_tombstone(declaration, exception, "id", "e2_1"))
        self.assertTrue(feeds.read_tombstone(declaration, {"id": "e1", "status": "cancelled"}, "id", "e1"))

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test to
        # assert that only that catalog selects it, after the Calendar
        # crud-causality overlay.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
