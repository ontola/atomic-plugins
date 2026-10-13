"""Check the Google Tasks Collection Completeness overlay against its exact source OAD.

The overlay is composed after the pagination v2 and crud-causality v2
overlays it needs, the result must pass the completeness and CRUD Causality
validators, and synthetic read answers shaped as the google-tasks app
documents them must classify as the app handles them. A Todoist overlay was
drafted with it and is left out: Todoist's reference could not be read for
the task fields and reads it relies on, and its pinned OAD is an authored
subset without descriptions. No provider is called. Use --directory for a
full-history openapi-directory checkout; otherwise the full-SHA source URLs
are downloaded.
"""
import argparse
import copy
import json
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
COMPOSITIONS = {
    "google_tasks": [TASKS + "pagination-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml",
                     TASKS + "crud-causality-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml",
                     TASKS + "completeness-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml"],
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

    def test_a_410_is_unavailable_too_without_gone(self):
        # Collection Completeness 0.3.0: without `gone`, a 410 means what
        # `notFound` says.
        task = self.resource("google_tasks", "task")
        declaration = task["collections"]["tasks"]["x-completeness"]
        self.assertNotIn("gone", declaration)
        self.assertEqual(completeness.classify_read(declaration, task["x-read-tombstone"], "id", "t1", 410, None),
                         "unavailable")

    def test_only_the_syncables_0_22_catalog_selects_the_overlay(self):
        # catalog/2026-10-12-syncables-0.22.json selects it after the
        # crud-causality overlay; no earlier catalog does.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                text = catalog.read_text(encoding="utf-8")
                if catalog.name != "2026-10-12-syncables-0.22.json":
                    self.assertNotIn("completeness-7ca47c73cf2308c9812692b482b3713b397bc88c", text)
                    continue
                names = [url.rsplit("/", 1)[1] for p in json.loads(text)["platforms"]
                         for url in p["overlays"] if "7ca47c73cf2308c9812692b482b3713b397bc88c" in url]
                completeness = names.index("completeness-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml")
                crud = next(i for i, n in enumerate(names) if n.startswith("crud-causality"))
                self.assertLess(crud, completeness)

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
