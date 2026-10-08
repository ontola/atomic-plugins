"""Check the Write Preconditions 0.1.0-draft overlays against their exact source OADs.

Each overlay is composed with its pinned OAD, the result must pass the write
preconditions validator, and the reference client logic must behave as the
drive apps do. No provider is called. Use --directory for a full-history
openapi-directory checkout; otherwise the full-SHA source URLs are downloaded.
"""
import argparse
import copy
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

spec = importlib.util.spec_from_file_location(
    "write_preconditions", ROOT.parent / "openapi-extensions" / "spec" / "write-preconditions" / "validate.py")
wp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wp)

DIRECTORY = None
OVERLAYS = {
    "google_calendar": "APIs/googleapis.com/calendar/v3/write-preconditions-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml",
    "notion": "APIs/notion.com/2026-03-11/write-preconditions-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml",
}
EVENT = "/calendars/{calendarId}/events/{eventId}"


class WritePreconditionOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.documents = {}
        with tempfile.TemporaryDirectory() as cache:
            for name, relative in OVERLAYS.items():
                url, sha, source = overlay_pin(ROOT / relative)
                if DIRECTORY:
                    raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
                else:
                    raw, _ = fetch(url, Path(cache))
                original = yaml.safe_load(raw)
                composed = copy.deepcopy(original)
                apply(composed, yaml.safe_load((ROOT / relative).read_text()))
                cls.documents[name] = (original, composed)

    def test_composed_documents_pass_the_validator_and_change_only_the_extension(self):
        for name, (original, composed) in self.documents.items():
            with self.subTest(provider=name):
                wp.validate(composed)
                stripped = copy.deepcopy(composed)
                for item in stripped["paths"].values():
                    for operation in item.values():
                        if isinstance(operation, dict):
                            operation.pop("x-write-precondition", None)
                self.assertEqual(stripped, original)

    def test_calendar_event_writes_send_the_etag_read(self):
        original, composed = self.documents["google_calendar"]
        self.assertEqual(original["components"]["schemas"]["Event"]["properties"]["etag"]["type"], "string")
        for method in ("patch", "put", "delete"):
            declaration = composed["paths"][EVENT][method]["x-write-precondition"]
            event = {"id": "e1", "etag": '"3181161784712000"', "summary": "Old"}
            self.assertEqual(wp.may_send(declaration, {"summary": "Old"}, ["summary"], event),
                             ("send", {"If-Match": '"3181161784712000"'}))
        self.assertNotIn("x-write-precondition", composed["paths"][EVENT]["get"])
        # K18: recurring series and their occurrences are not written.
        event_schema = original["components"]["schemas"]["Event"]["properties"]
        self.assertIn("omitted for single events", event_schema["recurrence"]["description"])
        self.assertIn("instance of a recurring event", event_schema["recurringEventId"]["description"])
        for method in ("patch", "put", "delete"):
            declaration = composed["paths"][EVENT][method]["x-write-precondition"]
            single = {"id": "e1", "etag": '"v"', "summary": "Old"}
            master = dict(single, recurrence=["RRULE:FREQ=WEEKLY;BYDAY=MO"])
            occurrence = dict(single, recurringEventId="series1")
            self.assertEqual(wp.may_send(declaration, {}, ["summary"], single)[0], "send")
            self.assertEqual(wp.may_send(declaration, {}, ["summary"], master)[0], "refused")
            self.assertEqual(wp.may_send(declaration, {}, ["summary"], occurrence)[0], "refused")
        app = (ROOT.parent / "integrations/calendar/app/operations.ts").read_text()
        self.assertIn("Refusing a Calendar write without If-Match", app)

    def test_notion_pages_are_read_verified_and_trash_is_refused(self):
        _, composed = self.documents["notion"]
        declaration = composed["paths"]["/pages/{page_id}"]["patch"]["x-write-precondition"]
        baseline = {"properties.Status.status.name": "Open"}
        page = {"properties": {"Status": {"status": {"name": "Open"}}}, "in_trash": False, "archived": False}
        self.assertEqual(wp.may_send(declaration, baseline, list(baseline), page), ("send", {}))
        page["properties"]["Status"]["status"]["name"] = "Done"
        self.assertEqual(wp.may_send(declaration, baseline, list(baseline), page)[0], "conflict")
        for field in ("in_trash", "archived"):
            trashed = {"properties": {"Status": {"status": {"name": "Open"}}}, field: True}
            self.assertEqual(wp.may_send(declaration, baseline, list(baseline), trashed)[0], "refused")
        self.assertNotIn("idempotent", declaration)
        self.assertEqual(wp.resolve_unknown(declaration, "PATCH", baseline, {"properties.Status.status.name": "Done"}, None),
                         "read-first")
        app = (ROOT.parent / "integrations/notion/app/send.ts").read_text()
        self.assertIn("page.archived === true || page.in_trash === true", app)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
