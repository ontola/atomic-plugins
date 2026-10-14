"""Check the Google Calendar events Collection Completeness overlay against its exact source OAD.

It composes with the catalog's Calendar overlays (auth, app-pagination,
identity) and each Calendar crud-causality overlay of the pin, plus the
read-tombstone revision 2, in either order; the result must pass the
completeness and collection-read validators (app-crud-causality v1 keeps its
known rule-5 finding), and an event's read is classified as declared: a 2xx
cancelled answer is a deletion (the read tombstone), a 404 is unavailable.
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

PIN = "32237fa5d14aa887dc9f3923395dac971e00a36c"
FOLDER = ROOT / "APIs/googleapis.com/calendar/v3"
OVERLAY = f"completeness-{PIN}-overlay.yaml"
BASE = [f"auth-{PIN}-overlay.yaml", f"app-pagination-{PIN}-overlay.yaml", f"identity-{PIN}-overlay.yaml"]
TOMBSTONE = f"read-tombstone-v2-{PIN}-overlay.yaml"
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
                names = [*BASE, crud_name, TOMBSTONE, OVERLAY]
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

    def test_event_outcomes(self):
        document = self.compose([*BASE, f"app-crud-causality-v2-{PIN}-overlay.yaml", TOMBSTONE, OVERLAY])
        declaration = document["components"]["crudResources"]["event"]["collections"]["events"]["x-completeness"]
        self.assertEqual(declaration["absent"], "removed")
        self.assertNotIn("gone", declaration)
        self.assertNotIn("parentAbsent", declaration)
        not_found = completeness.resource_not_found(document, "event")
        self.assertEqual(not_found, "unavailable")
        tombstone = document["paths"][READ]["get"]["x-read-tombstone"]
        simple = {"field": tombstone["field"], "values": tombstone["values"]}
        classify = lambda status, body=None: completeness.classify_read(declaration, simple, "id", "ev1", status,
                                                                         body, not_found)
        self.assertEqual(classify(200, {"id": "ev1", "status": "cancelled"}), "deleted")  # the read tombstone
        self.assertEqual(classify(200, {"id": "ev1", "status": "confirmed"}), "present")
        # "never existed", or "a calendar that the user can not access".
        self.assertEqual(classify(404), "unavailable")
        self.assertEqual(classify(410), "unavailable")  # no gone: read like a 404

    def test_the_pinned_document_still_says_get_returns_cancelled_events(self):
        status = self.original["components"]["schemas"]["Event"]["properties"]["status"]["description"]
        self.assertIn("The get method always returns them.", " ".join(status.split()))

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
