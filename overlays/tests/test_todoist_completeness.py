"""Check the Todoist active-task completeness overlay (#99) against its pinned OAD.

The overlay is composed with its pinned OAD and the catalog's crud-causality
overlay, in either order. The result must pass the Collection Completeness
validator, add only x-completeness on the tasks collection, and classify
synthetic reads as the overlay intends: a task absent from a complete read is
removed (not deleted), and a 404 from reading it is unavailable whatever its
cause. No read tombstone is declared, since GET /tasks/{task_id} returns
active tasks only. No provider is called. Use --directory for a full-history
openapi-directory checkout; otherwise the full-SHA source URL is downloaded.
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
    "completeness_validate", ROOT.parent / "openapi-extensions" / "spec" / "collection-completeness" / "validate.py")
completeness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(completeness)

DIRECTORY = None
TODOIST = "APIs/todoist.com/1/"
OVERLAY = TODOIST + "completeness-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml"
CRUD = TODOIST + "crud-causality-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml"


def load(path):
    return yaml.safe_load((ROOT / path).read_text())


class TodoistCompletenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAY)
        assert overlay_pin(ROOT / CRUD)[0] == url
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.composed = copy.deepcopy(cls.original)
        apply(cls.composed, load(CRUD))
        apply(cls.composed, load(OVERLAY))

    def declaration(self):
        return self.composed["components"]["crudResources"]["task"]["collections"]["tasks"]["x-completeness"]

    def test_composes_in_either_order_and_validates(self):
        other = copy.deepcopy(self.original)
        apply(other, load(OVERLAY))
        apply(other, load(CRUD))
        self.assertEqual(other, self.composed)
        completeness.validate(self.composed)

    def test_declares_only_tasks_completeness(self):
        crud_only = copy.deepcopy(self.original)
        apply(crud_only, load(CRUD))
        composed = copy.deepcopy(self.composed)
        tasks = composed["components"]["crudResources"]["task"]["collections"]["tasks"]
        self.assertEqual((tasks.pop("x-completeness")["absent"], self.declaration()["notFound"]),
                         ("removed", "unavailable"))
        self.assertEqual(composed, crud_only)
        self.assertNotIn("x-read-tombstone", self.composed["components"]["crudResources"]["task"])
        self.assertNotIn("gone", self.declaration())

    def test_the_pinned_document_says_what_the_overlay_relies_on(self):
        self.assertEqual(self.original["paths"]["/tasks"]["get"]["summary"], "Get active tasks")
        params = [p.get("name") for p in self.original["paths"]["/tasks"]["get"].get("parameters", [])]
        self.assertIn("project_id", params)

    def test_reads_of_a_task_that_left_the_active_list(self):
        declaration = self.declaration()
        not_found = completeness.resource_not_found(self.composed, "task")
        self.assertEqual(not_found, "unavailable")
        # Completed, deleted or out of reach: a 404 or 410 is unavailable, never deleted.
        for status in (404, 410):
            self.assertEqual(completeness.classify_read(declaration, None, "id", "t1", status, None, not_found),
                             "unavailable")
        # A 200 with the task: it is still active (present), even with is_deleted or checked,
        # since no read tombstone is declared.
        for body in ({"id": "t1", "checked": False}, {"id": "t1", "checked": True, "is_deleted": True}):
            self.assertEqual(completeness.classify_read(declaration, None, "id", "t1", 200, body, not_found),
                             "present")
        # Another answer says nothing.
        self.assertEqual(completeness.classify_read(declaration, None, "id", "t1", 500, None, not_found), "unknown")

    def test_no_dated_catalog_selects_it(self):
        name = OVERLAY.rsplit("/", 1)[1]
        for catalog in (ROOT / "catalog").glob("*.json"):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(name, catalog.read_text())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
