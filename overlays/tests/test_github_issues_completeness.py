"""Check the GitHub Issues Collection Completeness overlay against its exact source OAD.

It composes with the published crud-causality and pagination overlays of the
same pin, in either order; the result must pass the completeness and
collection-read validators, and a missing issue is classified as declared. No
provider is called. Use --directory
for a full-history openapi-directory checkout; otherwise the full-SHA source
URL is downloaded.
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
PIN = "9c5cfb87b3f8b64e11069373a73e3fc85de0de5e"
FOLDER = "APIs/github.com/github-issues/1.1.4/"
OVERLAYS = [FOLDER + f"crud-causality-{PIN}-overlay.yaml", FOLDER + f"pagination-{PIN}-overlay.yaml",
            FOLDER + f"completeness-{PIN}-overlay.yaml"]


class GitHubIssuesCompletenessTests(unittest.TestCase):
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
        crud.validate(self.composed)
        reordered = copy.deepcopy(self.original)
        for overlay in [self.overlays[-1], *self.overlays[:-1]]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.composed)

    def test_issue_outcomes(self):
        issue = self.composed["components"]["crudResources"]["issue"]
        declaration = issue["collections"]["issues"]["x-completeness"]
        self.assertEqual(issue["collections"]["issues"]["x-list-query"], {"state": "all"})  # the complete read
        not_found = completeness.resource_not_found(self.composed, "issue")
        self.assertEqual(not_found, "unavailable")
        self.assertNotIn("gone", declaration)  # a 410 may be "Issues are disabled for this repo"
        classify = lambda status, body=None: completeness.classify_read(declaration, None, "number", 7, status, body,
                                                                         not_found)
        self.assertEqual(classify(404), "unavailable")  # possibly transferred out of reach
        # A 410 is a deletion or "Issues are disabled for this repo" (reversible): unavailable.
        self.assertEqual(classify(410, {"message": "Issues are disabled for this repo"}), "unavailable")
        self.assertEqual(classify(200, {"number": 7, "state": "closed"}), "present")
        self.assertEqual(classify(301), "unknown")  # transferred: neither deleted nor present here

    def test_comments_follow_their_issue(self):
        comments = self.composed["components"]["crudResources"]["issueComment"]["collections"]["issueComments"]
        self.assertEqual(completeness.parents(self.composed, "issueComment", comments), {"issue_number": ["issue"]})
        self.assertEqual(completeness.members_of_gone_parent(comments["x-completeness"], "unavailable"), "unavailable")
        self.assertEqual(completeness.members_of_gone_parent(comments["x-completeness"], "deleted"), "unavailable")
        # GitHub documents no 410 for comments: gone is not declared there, so a 410 is read like a 404.
        self.assertNotIn("gone", comments["x-completeness"])
        self.assertEqual(completeness.classify_read(comments["x-completeness"], None, "id", 1, 410, None), "unavailable")

    def test_only_completeness_is_added(self):
        resources = self.overlays[-1]["actions"][0]["update"]["crudResources"]
        for resource in resources.values():
            self.assertEqual(set(resource), {"collections"})
            for collection in resource["collections"].values():
                self.assertEqual(set(collection), {"x-completeness"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
