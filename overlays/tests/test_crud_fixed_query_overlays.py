"""Check the CRUD Causality 0.4.0 fixed-read overlays against their exact source OADs.

Each overlay is composed with its pinned OAD and the pagination overlay of the
same revision, the result must pass the CRUD Causality collection-read
validator, and each fixed read must be the request the drive app sends. No
provider is called. Use --directory for a full-history openapi-directory
checkout; otherwise the full-SHA source URLs are downloaded.
"""
import argparse
import re
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "crud-causality"))
from validate import read_request, validate as validate_crud

DIRECTORY = None
TASKS = "APIs/googleapis.com/tasks/v1/"
CALENDAR = "APIs/googleapis.com/calendar/v3/"
COMPOSITIONS = {
    "google_tasks": [TASKS + "pagination-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml",
                     TASKS + "crud-causality-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml"],
    "google_calendar": [CALENDAR + "app-pagination-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml",
                        CALENDAR + "app-crud-causality-v2-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml"],
}


def query_parameters(document, path):
    item = document["paths"][path]
    return {p["name"]: p for p in item.get("parameters", []) + item["get"].get("parameters", []) if p.get("in") == "query"}


class FixedQueryOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.documents = {}
        with tempfile.TemporaryDirectory() as cache:
            for name, overlays in COMPOSITIONS.items():
                url, sha, source = overlay_pin(ROOT / overlays[0])
                for overlay in overlays[1:]:
                    assert overlay_pin(ROOT / overlay)[0] == url
                if DIRECTORY:
                    raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
                else:
                    raw, _ = fetch(url, Path(cache))
                original = yaml.safe_load(raw)
                composed = copy.deepcopy(original)
                for overlay in overlays:
                    apply(composed, yaml.safe_load((ROOT / overlay).read_text()))
                cls.documents[name] = (original, composed)

    def test_composed_documents_pass_the_collection_read_validator(self):
        for name, (_, composed) in self.documents.items():
            with self.subTest(provider=name):
                validate_crud(composed)

    def test_google_tasks_reads_completed_and_hidden_tasks(self):
        original, composed = self.documents["google_tasks"]
        method, path, body = read_request(composed, "task", "tasks", {"tasklist": "L1"})
        self.assertEqual((method, path, body), ("GET", "/tasks/v1/lists/L1/tasks?showCompleted=true&showHidden=true", None))
        parameters = query_parameters(original, "/tasks/v1/lists/{tasklist}/tasks")
        self.assertIn("The default is False", parameters["showHidden"]["description"])
        self.assertIn("showHidden must also be True", parameters["showCompleted"]["description"])
        self.assertEqual(read_request(composed, "taskList", "taskLists", {}), ("GET", "/tasks/v1/users/@me/lists", None))
        # The google-tasks app sends exactly these values (integrations/google-tasks/app/read.ts).
        app = (ROOT.parent / "integrations/google-tasks/app/read.ts").read_text()
        match = re.search(r"^export const TASK_QUERY = \{([^}]*)\};$", app, re.MULTILINE)
        self.assertIsNotNone(match)
        self.assertEqual(object_literal(match.group(1)),
                         composed["components"]["crudResources"]["task"]["collections"]["tasks"]["listQuery"])

    def test_google_tasks_adds_only_read_metadata(self):
        original, composed = self.documents["google_tasks"]
        for path, item in composed["paths"].items():
            for method, operation in item.items():
                crud = operation.get("x-crud") if isinstance(operation, dict) else None
                if crud:
                    self.assertEqual(method, "get", path)
                    self.assertIn(crud["action"], ("list", "read"))

    def test_google_tasks_v2_keeps_v1(self):
        v1 = yaml.safe_load((ROOT / TASKS / "crud-causality-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml").read_text())
        v2 = yaml.safe_load((ROOT / TASKS / "crud-causality-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml").read_text())
        self.assertEqual(v1["extends"], v2["extends"])
        old, new = (v["actions"][0]["update"]["crudResources"] for v in (v1, v2))
        self.assertEqual(set(old), set(new))
        for name, resource in old.items():
            self.assertEqual(resource["identity"], new[name]["identity"])
            for collection, definition in resource["collections"].items():
                self.assertEqual(definition["urlTemplate"], new[name]["collections"][collection]["urlTemplate"])
        targets = lambda v: {(a["target"], yaml.safe_dump(a["update"].get("x-crud"))) for a in v["actions"][1:]}
        self.assertLessEqual(targets(v1), targets(v2))

    def test_google_calendar_reads_series_masters_and_cancelled_events(self):
        original, composed = self.documents["google_calendar"]
        method, path, _ = read_request(composed, "event", "events", {"calendarId": "primary"})
        self.assertEqual((method, path), ("GET", "/calendars/primary/events?showDeleted=true&singleEvents=false"))
        parameters = query_parameters(original, "/calendars/{calendarId}/events")
        self.assertIn('status equals "cancelled"', parameters["showDeleted"]["description"])
        self.assertIn("expand recurring events into instances", parameters["singleEvents"]["description"])
        # The calendar app's events.list sends these values plus maxResults, the page size.
        app = (ROOT.parent / "integrations/calendar/app/operations.ts").read_text()
        match = re.search(r"id: 'events\.list',.*?fixedQuery: \{([^}]*)\}", app, re.DOTALL)
        self.assertIsNotNone(match)
        fixed = object_literal(match.group(1))
        self.assertEqual(fixed.pop("maxResults"), "250")
        self.assertEqual(fixed, composed["components"]["crudResources"]["event"]["collections"]["events"]["listQuery"])

    def test_calendar_v2_changes_v1_only_by_the_fixed_read_and_update_mode(self):
        v1 = yaml.safe_load((ROOT / CALENDAR / "app-crud-causality-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml").read_text())
        v2 = yaml.safe_load((ROOT / CALENDAR / "app-crud-causality-v2-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml").read_text())
        events = v2["actions"][0]["update"]["crudResources"]["event"]["collections"]["events"]
        self.assertEqual(events.pop("listQuery"), {"showDeleted": "true", "singleEvents": "false"})
        events.pop("description")
        patch = next(a for a in v2["actions"] if a["target"].endswith(".patch"))["update"]["x-crud"]
        self.assertEqual((patch.pop("mode"), patch.pop("patchFormat")), ("patch", "jsonMergePatch"))
        patch.pop("description")
        v1["info"]["version"] = v2["info"]["version"]
        self.assertEqual(v1, v2)


def object_literal(text):
    """A flat TypeScript object literal of string values, as a dict."""
    pairs = re.findall(r"(\w+):\s*'([^']*)'", text)
    rest = re.sub(r"(\w+):\s*'([^']*)'", "", text).replace(",", "").strip()
    assert not rest, f"not a flat literal of strings: {text!r}"  # any other entry fails the test
    return dict(pairs)



if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
