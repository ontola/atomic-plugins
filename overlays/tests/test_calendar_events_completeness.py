"""Check the Google Calendar events Collection Completeness overlay against its exact source OAD.

It composes with the catalog's Calendar overlays (auth, app-pagination,
identity) and each Calendar crud-causality overlay of the pin, plus the
read-tombstone revision 2, the list tombstones and the deletion feed, in
either order; the result must pass the completeness, collection-read and
Deletion Feeds validators (app-crud-causality v1 keeps its known rule-5
finding), and an event's read is classified as declared: a 2xx answer is
decided by the read tombstone with its `except` (Deletion Feeds
`read_tombstone`), a 404 is unavailable.
No provider is called. The pinned OAD is downloaded by its full-SHA URL.
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


completeness = load("completeness_validate", SPECS / "collection-completeness" / "validate.py")
crud = load("crud_validate", SPECS / "crud-causality" / "validate.py")
feeds = load("deletion_feeds_validate", SPECS / "deletion-feeds" / "validate.py")

PIN = "32237fa5d14aa887dc9f3923395dac971e00a36c"
FOLDER = ROOT / "APIs/googleapis.com/calendar/v3"
OVERLAY = f"completeness-{PIN}-overlay.yaml"
BASE = [f"auth-{PIN}-overlay.yaml", f"app-pagination-{PIN}-overlay.yaml", f"identity-{PIN}-overlay.yaml"]
TOMBSTONE = f"read-tombstone-v2-{PIN}-overlay.yaml"
TOMBSTONE_V1 = f"read-tombstone-{PIN}-overlay.yaml"
DELETIONS = [TOMBSTONE, f"list-tombstone-{PIN}-overlay.yaml", f"deletion-feed-{PIN}-overlay.yaml"]
KNOWN_CRUD_ERRORS = {
    f"app-crud-causality-{PIN}-overlay.yaml":
        {"paths./calendars/{calendarId}/events/{eventId}.patch.x-crud.mode: required for action update (rule 5)"},
    f"app-crud-causality-v2-{PIN}-overlay.yaml": set(),
    f"crud-causality-{PIN}-overlay.yaml": set(),
}
READ = "/calendars/{calendarId}/events/{eventId}"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/googleapis.com/calendar/v3/openapi.yaml"


def load_overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


class CalendarEventsCompletenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])

    def compose(self, names):
        document = copy.deepcopy(self.original)
        for name in names:
            apply(document, load_overlay(name))
        return document

    def test_composes_with_each_crud_overlay_in_either_order(self):
        for crud_name, known in KNOWN_CRUD_ERRORS.items():
            with self.subTest(crud=crud_name):
                names = [*BASE, crud_name, *DELETIONS, OVERLAY]
                document = self.compose(names)
                self.assertEqual(self.compose([OVERLAY, *names[:-1]]), document)
                completeness.validate(document)
                warnings = []
                try:
                    crud.validate(copy.deepcopy(document), warnings)
                    errors = set()
                except ValueError as raised:
                    errors = set(str(raised).splitlines())
                self.assertEqual(errors, known)
                self.assertEqual(warnings, [])
                feeds.validate(document)

    def classifier(self, tombstone_overlay):
        document = self.compose([*BASE, f"app-crud-causality-v2-{PIN}-overlay.yaml", tombstone_overlay, OVERLAY])
        declaration = document["components"]["crudResources"]["event"]["collections"]["events"]["x-completeness"]
        not_found = completeness.resource_not_found(document, "event")
        tombstone = document["paths"][READ]["get"]["x-read-tombstone"]

        def classify(status, body=None, object_id="ev1"):
            # A 2xx answer is decided by the read tombstone with its except
            # conditions (Deletion Feeds §4.3, §4.4); classify_read's own
            # tombstone check knows no except, so it is not given one.
            if isinstance(status, int) and 200 <= status < 300 and feeds.read_tombstone(tombstone, body, "id",
                                                                                         object_id):
                return "deleted"
            return completeness.classify_read(declaration, None, "id", object_id, status, body, not_found)

        return declaration, not_found, classify

    def test_event_outcomes(self):
        declaration, not_found, classify = self.classifier(TOMBSTONE)
        self.assertEqual(declaration["absent"], "removed")
        self.assertNotIn("gone", declaration)
        self.assertNotIn("parentAbsent", declaration)
        self.assertEqual(not_found, "unavailable")
        self.assertEqual(classify(200, {"id": "ev1", "status": "cancelled"}), "deleted")  # the read tombstone
        self.assertEqual(classify(200, {"id": "ev1", "status": "confirmed"}), "present")
        # A cancelled exception of a live recurring event is stored, not removed.
        exception = {"id": "ev1_20261015", "status": "cancelled", "recurringEventId": "ev1"}
        self.assertEqual(classify(200, exception, "ev1_20261015"), "present")
        # "never existed", or "a calendar that the user can not access".
        self.assertEqual(classify(404), "unavailable")
        self.assertEqual(classify(410), "unavailable")  # no gone: read like a 404

    def test_the_first_read_tombstone_revision_reads_a_cancelled_exception_as_deleted(self):
        # read-tombstone v1 is superseded by v2 and selected by no catalog; it
        # has no except, so a cancelled exception, which the document says is
        # stored while its series is live, reads as a deletion there.
        _, _, classify = self.classifier(TOMBSTONE_V1)
        exception = {"id": "ev1_20261015", "status": "cancelled", "recurringEventId": "ev1"}
        self.assertEqual(classify(200, exception, "ev1_20261015"), "deleted")

    def test_the_pinned_document_still_says_get_returns_cancelled_events(self):
        status = self.original["components"]["schemas"]["Event"]["properties"]["status"]["description"]
        self.assertIn("The get method always returns them.", " ".join(status.split()))
        self.assertIn("will eventually disappear", " ".join(status.split()))
        self.assertIn("leave behind a cancelled event where only the id field is guaranteed to be populated",
                      " ".join(status.split()))

    def test_only_completeness_is_added(self):
        overlay = load_overlay(OVERLAY)
        self.assertEqual([action["target"] for action in overlay["actions"]], ["$.components"])
        resources = overlay["actions"][0]["update"]["crudResources"]
        self.assertEqual(resources, {"event": {"collections": {"events": {
            "x-completeness": resources["event"]["collections"]["events"]["x-completeness"]}}}})

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
