"""Check the Collection Completeness 0.2.0-draft overlays against their exact source OADs.

Each overlay is composed after the crud-causality overlay it targets, the
result must pass the completeness validator, and synthetic read answers shaped
as the apps document them must classify as the apps handle them. No provider is
called. Use --directory for a full-history openapi-directory checkout;
otherwise the full-SHA source URLs are downloaded.
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

SPECS = ROOT.parent / "openapi-extensions" / "spec"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


completeness = load("completeness_validate", SPECS / "collection-completeness" / "validate.py")
crud = load("crud_validate", SPECS / "crud-causality" / "validate.py")

DIRECTORY = None
TASKS = "APIs/googleapis.com/tasks/v1/"
TODOIST = "APIs/todoist.com/1/"
COMPOSITIONS = {
    "google_tasks": [TASKS + "pagination-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml",
                     TASKS + "crud-causality-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml",
                     TASKS + "completeness-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml"],
    "todoist": [TODOIST + "crud-causality-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml",
                TODOIST + "pagination-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml",
                TODOIST + "completeness-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml"],
}


class CompletenessOverlayTests(unittest.TestCase):
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

    def resource(self, name, resource):
        return self.documents[name][1]["components"]["crudResources"][resource]

    def test_composed_documents_pass_the_validators(self):
        for name, (_, composed) in self.documents.items():
            with self.subTest(provider=name):
                completeness.validate(composed)
                crud.validate(composed)

    def test_google_tasks_outcomes_match_the_app(self):
        task = self.resource("google_tasks", "task")
        declaration = task["collections"]["tasks"]["x-completeness"]
        tombstone = task["x-read-tombstone"]
        classify = lambda status, body: completeness.classify_read(declaration, tombstone, "id", "t1", status, body)
        # integrations/google-tasks/README.md, "A task that stops appearing".
        self.assertEqual(classify(200, {"id": "t1", "deleted": True}), "deleted")
        self.assertEqual(classify(404, None), "unavailable")
        self.assertEqual(classify(200, {"id": "t1", "hidden": True}), "present")
        self.assertEqual(classify(500, None), "unknown")
        self.assertEqual(completeness.members_of_gone_parent(declaration, "unavailable"), "unavailable")
        lists = self.resource("google_tasks", "taskList")["collections"]["taskLists"]["x-completeness"]
        self.assertEqual(completeness.classify_read(lists, None, "id", "L1", 404, None), "unavailable")
        # The complete read is the K3 fixed read.
        self.assertEqual(task["collections"]["tasks"]["listQuery"], {"showCompleted": "true", "showHidden": "true"})
        self.assertEqual(completeness.parents(self.documents["google_tasks"][1], "task", task["collections"]["tasks"]),
                         {"tasklist": ["taskList"]})

    def test_todoist_outcomes_match_the_app(self):
        task = self.resource("todoist", "task")
        declaration = task["collections"]["tasks"]["x-completeness"]
        classify = lambda status, body: completeness.classify_read(declaration, task["x-read-tombstone"], "id", "7", status, body)
        # integrations/issue-tracker/README.md: checked true is completed (present, a field value), is_deleted deleted, 404 unavailable.
        self.assertEqual(classify(200, {"id": "7", "checked": True}), "present")
        self.assertEqual(classify(200, {"id": "7", "is_deleted": True}), "deleted")
        self.assertEqual(classify(404, None), "unavailable")
        self.assertNotIn("parentAbsent", declaration)

    def test_only_completeness_and_read_tombstones_are_added_in_any_order(self):
        for name, overlays in COMPOSITIONS.items():
            with self.subTest(provider=name):
                overlay = yaml.safe_load((ROOT / overlays[-1]).read_text())
                self.assertEqual([a["target"] for a in overlay["actions"]], ["$.components"])
                resources = overlay["actions"][0]["update"]["crudResources"]
                for resource in resources.values():
                    self.assertLessEqual(set(resource), {"x-read-tombstone", "collections"})
                    for collection in resource.get("collections", {}).values():
                        self.assertEqual(set(collection), {"x-completeness"})
                # Applied first, the crud-causality overlay's deep merge gives the same document.
                original = self.documents[name][0]
                reordered = copy.deepcopy(original)
                for path in [overlays[-1], *overlays[:-1]]:
                    apply(reordered, yaml.safe_load((ROOT / path).read_text()))
                self.assertEqual(reordered, self.documents[name][1])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
