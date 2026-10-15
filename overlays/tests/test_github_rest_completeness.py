"""Check the GitHub REST (api.github.com) issues Collection Completeness overlay against its exact source OAD.

It composes with the pagination overlay and crud-causality v2 of the same pin
(and with v1, which keeps its known findings), in either order; the result
must pass the completeness and collection-read validators, missing issues
and comments are classified as declared, and the declaration matches the
github-issues document's. No provider is called. The pinned OAD is
downloaded by its full-SHA URL.
"""
import copy
import importlib.util
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

PIN = "920631db31e628be547e9366821d3ebc7fa0ead5"
FOLDER = ROOT / "APIs/github.com/api.github.com/1.1.4"
OVERLAY = f"completeness-{PIN}-overlay.yaml"
PAGINATION = f"pagination-{PIN}-overlay.yaml"
CRUD_V2 = f"crud-causality-v2-{PIN}-overlay.yaml"
CRUD_V1 = f"crud-causality-{PIN}-overlay.yaml"
ISSUES_DOCUMENT = ROOT / "APIs/github.com/github-issues/1.1.4/completeness-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml"
OPENAPI = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/APIs/github.com/api.github.com/1.1.4/openapi.yaml"


def overlay(name):
    return yaml.safe_load((FOLDER / name).read_text(encoding="utf-8"))


def findings(document):
    warnings = []
    try:
        crud.validate(copy.deepcopy(document), warnings)
        errors = []
    except ValueError as raised:
        errors = str(raised).splitlines()
    return set(errors), set(warnings)


class GitHubRestCompletenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.original = yaml.safe_load(fetch(OPENAPI, Path(cache))[0])
        cls.composed = cls.compose([PAGINATION, CRUD_V2, OVERLAY])

    @classmethod
    def compose(cls, names):
        document = copy.deepcopy(cls.original)
        for name in names:
            apply(document, overlay(name))
        return document

    def test_composes_in_either_order_and_passes_the_validators(self):
        completeness.validate(self.composed)
        self.assertEqual(findings(self.composed), (set(), set()))
        self.assertEqual(self.compose([OVERLAY, PAGINATION, CRUD_V2]), self.composed)
        # With v1 the overlay adds no finding to those v1 has alone.
        v1 = self.compose([PAGINATION, CRUD_V1])
        with_overlay = self.compose([PAGINATION, CRUD_V1, OVERLAY])
        completeness.validate(with_overlay)
        self.assertEqual(findings(with_overlay), findings(v1))

    def test_the_same_declaration_as_the_github_issues_document(self):
        ours = overlay(OVERLAY)["actions"][0]["update"]["crudResources"]
        theirs = yaml.safe_load(ISSUES_DOCUMENT.read_text(encoding="utf-8"))["actions"][0]["update"]["crudResources"]
        strip = lambda resources: {name: {c: {k: v for k, v in body["x-completeness"].items() if k != "description"}
                                          for c, body in r["collections"].items()} for name, r in resources.items()}
        self.assertEqual(strip(ours), strip(theirs))

    def test_issue_outcomes(self):
        issue = self.composed["components"]["crudResources"]["issue"]
        declaration = issue["collections"]["issues"]["x-completeness"]
        self.assertEqual(issue["collections"]["issues"]["x-list-query"], {"state": "all"})
        not_found = completeness.resource_not_found(self.composed, "issue")
        self.assertEqual(not_found, "unavailable")
        self.assertNotIn("gone", declaration)
        classify = lambda status, body=None: completeness.classify_read(declaration, None, "number", 7, status, body,
                                                                         not_found)
        self.assertEqual(classify(404), "unavailable")  # possibly transferred out of reach
        self.assertEqual(classify(410, {"message": "Issues are disabled for this repo"}), "unavailable")
        self.assertEqual(classify(200, {"number": 7, "state": "closed"}), "present")
        self.assertEqual(classify(301), "unknown")  # transferred

    def test_comments_follow_their_issue(self):
        comments = self.composed["components"]["crudResources"]["issueComment"]["collections"]["issueComments"]
        self.assertEqual(completeness.parents(self.composed, "issueComment", comments), {"issue_number": ["issue"]})
        for parent in ("deleted", "unavailable"):
            self.assertEqual(completeness.members_of_gone_parent(comments["x-completeness"], parent), "unavailable")
        self.assertEqual(completeness.classify_read(comments["x-completeness"], None, "id", 1, 410, None),
                         "unavailable")

    def test_only_completeness_is_added(self):
        actions = overlay(OVERLAY)["actions"]
        self.assertEqual([action["target"] for action in actions], ["$.components"])
        for resource in actions[0]["update"]["crudResources"].values():
            self.assertEqual(set(resource), {"collections"})
            for collection in resource["collections"].values():
                self.assertEqual(set(collection), {"x-completeness"})

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
