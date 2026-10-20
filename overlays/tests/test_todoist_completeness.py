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
PAGINATION = TODOIST + "pagination-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml"


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

    @staticmethod
    def classifier(document):
        """classify_read for a task of `document`, with everything the composed document declares.

        The collection's declaration, the resource's read tombstone (on the
        resource, else on its read operation, Deletion Feeds §4.4), its
        notFound and its gone are all read from `document`, never assumed.
        """
        task = document["components"]["crudResources"]["task"]
        declaration = task["collections"]["tasks"]["x-completeness"]
        read = document["paths"]["/tasks/{task_id}"]["get"]
        tombstone = task.get("x-read-tombstone") or read.get("x-read-tombstone")
        not_found = completeness.resource_not_found(document, "task")
        gone = completeness.resource_read_value(document, "task", "gone")

        return lambda status, body: completeness.classify_read(
            declaration, tombstone, "id", "t1", status, body, not_found, gone)

    BODIES = (None, {}, {"id": "t1"}, {"id": "t1", "checked": True}, {"id": "t1", "is_deleted": True},
              {"id": "t1", "checked": True, "is_deleted": True}, {"id": "t2"})

    def outcomes(self, document):
        classify = self.classifier(document)

        return {classify(status, body) for status in range(200, 600) for body in self.BODIES}

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
        self.assertEqual(completeness.resource_not_found(self.composed, "task"), "unavailable")
        classify = self.classifier(self.composed)
        # Completed, deleted or out of reach: a 404 or 410 is unavailable, never deleted.
        for status in (404, 410):
            self.assertEqual(classify(status, None), "unavailable")
        # A 200 with the task: it is still active (present), even with is_deleted or checked,
        # since the composed document declares no read tombstone.
        for body in ({"id": "t1", "checked": False}, {"id": "t1", "checked": True, "is_deleted": True}):
            self.assertEqual(classify(200, body), "present")
        # Another answer says nothing.
        self.assertEqual(classify(500, None), "unknown")

    def test_no_read_answer_is_ever_taken_as_a_deletion(self):
        # #99: absence or a failed read is never proof of completion or
        # deletion. Whatever a task's own read answers, the composed
        # document (its declaration, read tombstone, notFound and gone)
        # yields present, unavailable or unknown, never deleted.
        outcomes = self.outcomes(self.composed)
        self.assertNotIn("deleted", outcomes)
        self.assertEqual(outcomes, {"present", "unavailable", "unknown"})

    def test_the_never_deleted_check_sees_a_read_tombstone_or_gone(self):
        # The check above reads the whole composed document: a read tombstone
        # on the task resource or on its read, or a gone, would show up as a
        # deleted outcome there.
        for where in ("resource", "operation"):
            document = copy.deepcopy(self.composed)
            tombstone = {"field": "is_deleted", "values": [True]}
            if where == "resource":
                document["components"]["crudResources"]["task"]["x-read-tombstone"] = tombstone
            else:
                document["paths"]["/tasks/{task_id}"]["get"]["x-read-tombstone"] = tombstone
            with self.subTest(read_tombstone_on=where):
                self.assertIn("deleted", self.outcomes(document))
        document = copy.deepcopy(self.composed)
        document["components"]["crudResources"]["task"]["collections"]["tasks"]["x-completeness"]["gone"] = "deleted"
        self.assertIn("deleted", self.outcomes(document))

    def test_a_complete_read_follows_the_cursor_to_its_documented_end(self):
        # "When next_cursor is null, you've reached the end of the results."
        # The catalog's pagination overlay pages GET /tasks by that cursor, so
        # a read that stops before a null next_cursor is not complete (§3).
        document = copy.deepcopy(self.original)
        apply(document, load(PAGINATION))
        self.assertEqual(document["paths"]["/tasks"]["get"]["x-pagination"], [{"scheme": "cursor"}])
        scheme = document["components"]["paginationSchemes"]["cursor"]
        self.assertEqual(scheme["response"]["bodyFields"]["next_cursor"]["role"], "nextCursor")
        self.assertEqual(scheme["request"]["queryParameters"]["cursor"]["role"], "cursor")

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
