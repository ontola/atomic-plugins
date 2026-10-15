"""Check the Asana project tasks Collection Completeness overlay against its exact source OAD.

It composes with the catalog's auth and pagination overlays and crud-causality v2 of
the same pin, in either order; the result must pass the completeness and
collection-read validators, a missing task is classified as declared, and the
pinned document still says what the overlay quotes. No provider is called.
Use --directory for a full-history openapi-directory checkout; otherwise the
full-SHA source URL is downloaded.
"""
import argparse
import copy
import importlib.util
import json
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
PIN = "b58c91d9f59c6a10178916e7948793809edae46d"
FOLDER = "APIs/asana.com/1.0/"
OVERLAYS = [FOLDER + f"auth-{PIN}-overlay.yaml", FOLDER + f"pagination-{PIN}-overlay.yaml",
            FOLDER + f"crud-causality-v2-{PIN}-overlay.yaml", FOLDER + f"completeness-{PIN}-overlay.yaml"]
CRUD_V1 = FOLDER + f"crud-causality-{PIN}-overlay.yaml"


class AsanaTasksCompletenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAYS[-1])
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.overlays = [yaml.safe_load((ROOT / path).read_text()) for path in OVERLAYS]
        cls.composed = copy.deepcopy(cls.original)
        for overlay in cls.overlays:
            apply(cls.composed, overlay)

    def test_composition_passes_the_validators_in_either_order(self):
        completeness.validate(self.composed)
        warnings = []
        crud.validate(copy.deepcopy(self.composed), warnings)
        self.assertEqual(warnings, [])
        reordered = copy.deepcopy(self.original)
        for overlay in [self.overlays[-1], *self.overlays[:-1]]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.composed)

    def test_the_pinned_document_still_says_what_the_overlay_quotes(self):
        text = json.dumps(self.original, ensure_ascii=False)
        for words in ("Tasks can exist in more than one project at a time.",
                      "Tasks can be recovered from the trash within a",
                      "or the object specified by the request does not exist.",
                      "Only return tasks that are either incomplete or that have been completed since this time.",
                      "Note that an offset token will expire after some time, as data may have changed."):
            with self.subTest(words=words):
                self.assertIn(words, " ".join(text.split()))

    def test_the_read_pages_with_limit_100_instead_of_being_truncated(self):
        # "Alternatively, your query will be truncated at about 1,000 objects."
        tasks = self.composed["components"]["crudResources"]["task"]["collections"]["projectTasks"]
        self.assertEqual(tasks["listQuery"], {"limit": "100"})
        item = self.original["paths"]["/projects/{project_gid}/tasks"]
        limit = next(p for p in map(self.resolve, item.get("parameters", []) + item["get"].get("parameters", []))
                     if p["name"] == "limit")
        self.assertEqual((limit["in"], limit["schema"]["maximum"]), ("query", 100))
        # limit is the pagination scheme's pageSize field, which a listQuery may set (§4.2.1).
        scheme = self.composed["components"]["paginationSchemes"]["cursorData"]
        self.assertEqual(scheme["request"]["queryParameters"]["limit"]["role"], "pageSize")
        self.assertEqual(self.composed["paths"]["/projects/{project_gid}/tasks"]["get"]["x-pagination"],
                         [{"scheme": "cursorData"}])

    def test_crud_v2_is_v1_plus_a_limit_on_each_list(self):
        v1 = yaml.safe_load((ROOT / CRUD_V1).read_text())
        v2 = copy.deepcopy(self.overlays[2])
        resources = next(a["update"]["crudResources"] for a in v2["actions"] if "crudResources" in a.get("update", {}))
        dropped = []
        for name, resource in resources.items():
            for collection_name, collection in resource.get("collections", {}).items():
                self.assertEqual(collection.pop("listQuery"), {"limit": "100"}, collection_name)
                dropped.append(collection_name)
        self.assertEqual(sorted(dropped), ["projectTasks", "users", "workspaceProjects", "workspaces"])
        self.assertEqual(v2["actions"], v1["actions"])

    def resolve(self, node):
        while isinstance(node, dict) and "$ref" in node:
            target = self.original
            for part in node["$ref"][2:].split("/"):
                target = target[part]
            node = target
        return node

    def test_task_outcomes(self):
        task = self.composed["components"]["crudResources"]["task"]
        declaration = task["collections"]["projectTasks"]["x-completeness"]
        self.assertEqual(declaration["absent"], "removed")
        not_found = completeness.resource_not_found(self.composed, "task")
        self.assertEqual(not_found, "unavailable")
        self.assertNotIn("gone", declaration)  # Asana documents no 410
        id_field = task["identity"]["bindings"]["task_gid"]["field"]
        classify = lambda status, body=None: completeness.classify_read(declaration, None, id_field, "1204", status,
                                                                         body, not_found)
        # Deleted, possibly still in the trash for 30 days.
        self.assertEqual(classify(404, {"errors": [{"message": "Not Found"}]}), "unavailable")
        self.assertEqual(classify(410), "unavailable")  # undocumented: read like a 404
        self.assertEqual(classify(200, {id_field: "1204", "completed": True}), "present")  # moved to another project
        self.assertEqual(classify(403), "unknown")

    def test_tasks_are_not_concluded_from_their_project(self):
        resources = self.composed["components"]["crudResources"]
        tasks = resources["task"]["collections"]["projectTasks"]
        self.assertEqual(completeness.parents(self.composed, "task", tasks), {"project_gid": ["project"]})
        # §4.4 needs a parent collection with a Completeness Object; projects have none.
        self.assertNotIn("x-completeness", resources["project"]["collections"]["workspaceProjects"])
        self.assertNotIn("parentAbsent", tasks["x-completeness"])
        for parent in ("deleted", "unavailable"):
            self.assertIsNone(completeness.members_of_gone_parent(tasks["x-completeness"], parent))

    def test_only_completeness_is_added(self):
        actions = self.overlays[-1]["actions"]
        self.assertEqual([action["target"] for action in actions], ["$.components"])
        resources = actions[0]["update"]["crudResources"]
        self.assertEqual(set(resources), {"task"})
        self.assertEqual(set(resources["task"]), {"collections"})
        self.assertEqual(set(resources["task"]["collections"]), {"projectTasks"})
        self.assertEqual(set(resources["task"]["collections"]["projectTasks"]), {"x-completeness"})

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(f"completeness-{PIN}", catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
