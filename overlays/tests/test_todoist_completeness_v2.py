"""Todoist completeness revision 2: v1's tasks plus the projects collection.

Composes the pinned OAD with the catalog's crud-causality overlay and
completeness v2, in either order, runs the Collection Completeness validator,
and checks that v2 is v1 plus exactly the projects declaration, that its
info.x-requires names the crud-causality overlay, that the projects list
sends neither of its narrowing parameters, and the outcomes `classify_read`
gives. No provider is called; the pinned OAD is downloaded by its full-SHA URL.
"""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

spec = importlib.util.spec_from_file_location(
    "completeness_validate", ROOT.parent / "openapi-extensions" / "spec" / "collection-completeness" / "validate.py")
completeness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(completeness)

PIN = "ac07532b0a0ac101cf8bae2a54177fb1d8ea3779"
FOLDER = ROOT / "APIs/todoist.com/1"
V1 = f"completeness-{PIN}-overlay.yaml"
V2 = f"completeness-v2-{PIN}-overlay.yaml"
CRUD = f"crud-causality-{PIN}-overlay.yaml"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/todoist.com/1/openapi.yaml"


def overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


class TodoistCompletenessV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.composed = copy.deepcopy(cls.original)
        for name in (CRUD, V2):
            apply(cls.composed, overlay(name))

    def test_composes_in_either_order_and_validates(self):
        completeness.validate(self.composed)
        other = copy.deepcopy(self.original)
        for name in (V2, CRUD):
            apply(other, overlay(name))
        self.assertEqual(other, self.composed)

    def test_v2_is_v1_plus_projects(self):
        v1 = overlay(V1)["actions"][0]["update"]["crudResources"]
        v2 = copy.deepcopy(overlay(V2)["actions"][0]["update"]["crudResources"])
        projects = v2.pop("project")
        self.assertEqual(v2, v1)
        self.assertEqual(set(projects["collections"]), {"projects"})
        declaration = projects["collections"]["projects"]["x-completeness"]
        self.assertEqual((declaration["absent"], declaration["notFound"]), ("removed", "unavailable"))
        self.assertEqual(overlay(V2)["info"]["x-requires"], [{"anyOf": [CRUD]}])

    def test_the_projects_read_sends_no_narrowing_parameter(self):
        collection = self.composed["components"]["crudResources"]["project"]["collections"]["projects"]
        self.assertEqual(collection["urlTemplate"], "/projects")
        fixed = {**collection.get("listQuery", {}), **collection.get("x-list-query", {})}
        self.assertTrue({"folder_id", "workspace_id"}.isdisjoint(fixed))

    def test_project_outcomes(self):
        declaration = self.composed["components"]["crudResources"]["project"]["collections"]["projects"]["x-completeness"]
        not_found = completeness.resource_not_found(self.composed, "project")
        classify = lambda status, body=None: completeness.classify_read(declaration, None, "id", "p1", status, body,
                                                                         not_found)
        self.assertEqual(not_found, "unavailable")
        self.assertEqual(classify(404), "unavailable")  # archived, deleted or out of reach: not said
        self.assertEqual(classify(200, {"id": "p1", "is_archived": True}), "present")
        self.assertEqual(classify(403), "unknown")

    def test_no_dated_catalog_selects_it(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(V2, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
