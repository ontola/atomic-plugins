"""Check the GitLab.com issues Collection Completeness overlay against its exact source OAD.

It composes with the published auth, pagination and crud-causality overlays of
the same pin, in either order; the result must pass the completeness and
collection-read validators, and a missing issue is classified as declared. No
provider is called. Use --directory for a full-history openapi-directory
checkout; otherwise the full-SHA source URL is downloaded.
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
PIN = "f6d7940e9865903b9c99c5c1fc2d57d92811eef4"
FOLDER = "APIs/gitlab.com/v4-readonly/"
OVERLAYS = [FOLDER + f"auth-{PIN}-overlay.yaml", FOLDER + f"pagination-{PIN}-overlay.yaml",
            FOLDER + f"crud-causality-{PIN}-overlay.yaml", FOLDER + f"completeness-{PIN}-overlay.yaml"]


class GitLabIssuesCompletenessTests(unittest.TestCase):
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
        crud.validate(self.composed, warnings)
        self.assertEqual(warnings, [])
        reordered = copy.deepcopy(self.original)
        for overlay in [self.overlays[-1], *self.overlays[:-1]]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.composed)

    def test_issue_outcomes(self):
        issue = self.composed["components"]["crudResources"]["issue"]
        declaration = issue["collections"]["projectIssues"]["x-completeness"]
        self.assertEqual(declaration["absent"], "removed")
        not_found = completeness.resource_not_found(self.composed, "issue")
        self.assertEqual(not_found, "unavailable")
        self.assertNotIn("gone", declaration)  # GitLab documents no 410 for issues
        classify = lambda status, body=None: completeness.classify_read(declaration, None, "iid", 7, status, body,
                                                                         not_found)
        self.assertEqual(classify(404, {"message": "404 Issue Not Found"}), "unavailable")  # or not authorized
        self.assertEqual(classify(410), "unavailable")  # undocumented: read like a 404
        self.assertEqual(classify(200, {"iid": 7, "state": "closed"}), "present")
        self.assertEqual(classify(200, {"iid": 8}), "unknown")
        self.assertEqual(classify(403), "unknown")

    def test_issues_are_not_concluded_from_their_project(self):
        issues = self.composed["components"]["crudResources"]["issue"]["collections"]["projectIssues"]
        self.assertEqual(completeness.parents(self.composed, "issue", issues), {"id": ["project"]})
        # §4.4 needs a parent collection with a Completeness Object, and projects
        # have none (see test_projects_stay_undeclared): no conclusion is drawn.
        self.assertNotIn("parentAbsent", issues["x-completeness"])
        for parent in ("deleted", "unavailable"):
            self.assertIsNone(completeness.members_of_gone_parent(issues["x-completeness"], parent))

    def test_projects_stay_undeclared(self):
        # The catalog narrows /projects with membership=true; a consumer drops a
        # completeness declaration that a selection narrows, so none is made.
        projects = self.composed["components"]["crudResources"]["project"]["collections"]["projects"]
        self.assertNotIn("x-completeness", projects)

    def test_only_completeness_is_added(self):
        actions = self.overlays[-1]["actions"]
        self.assertEqual([action["target"] for action in actions], ["$.components"])
        resources = actions[0]["update"]["crudResources"]
        self.assertEqual(set(resources), {"issue"})
        for resource in resources.values():
            self.assertEqual(set(resource), {"collections"})
            for collection in resource["collections"].values():
                self.assertEqual(set(collection), {"x-completeness"})

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
