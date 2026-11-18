"""The ordinary GitHub catalog composes read/discovery metadata for Syncables.

The proxy's checked-in catalog pipeline reads all overlay bytes locally and
only downloads the immutable upstream OAD. No provider account is contacted.
"""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from generate_identity_catalog_fixtures import ROOT, compose, platform_config
from test_crud_reads_in_catalogs import KNOWN, findings


CATALOG = ROOT / "catalog/2026-11-18-syncables-apps.json"
PREVIOUS = ROOT / "catalog/2026-11-16-syncables-github.json"


class GitHubSyncablesCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG.read_text())
        cls.github = platform_config("github-issues", cls.catalog)
        with tempfile.TemporaryDirectory() as cache:
            cls.document, cls.provenance = compose("github-issues", Path(cache), cls.catalog)

    def test_the_new_catalog_preserves_the_previous_platforms(self):
        previous = json.loads(PREVIOUS.read_text())
        without_additions = copy.deepcopy(self.catalog)
        github = platform_config("github-issues", without_additions)
        added = github["overlays"].pop()
        self.assertTrue(added.endswith("/builtin-read-model-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml"))
        github["selection"].pop("query_overrides")
        self.assertEqual(without_additions, previous)

    def test_composition_has_only_previously_known_crud_findings(self):
        self.assertEqual(sorted(findings("github-issues", self.document) - KNOWN), [])

    def test_discovery_and_canonical_issue_collections_are_standard_metadata(self):
        resources = self.document["components"]["crudResources"]
        expected = [
            ("githubOrganization", "githubOrganizations", "/user/orgs"),
            ("githubRepository", "githubRepositories", "/user/repos"),
            ("issue", "repositoryIssues", "/repositories/{repository_id}/issues"),
        ]
        for resource, collection, path in expected:
            with self.subTest(collection=collection):
                definition = resources[resource]["collections"][collection]
                self.assertEqual(definition["urlTemplate"], path)
                self.assertNotIn("per_page", definition.get("listQuery", {}))
                operation = self.document["paths"][path]["get"]
                self.assertEqual(operation["x-crud"], {"action": "list", "resource": resource, "collection": collection})
                self.assertEqual(operation["x-pagination"], [{"scheme": "builtinGithubNextLink"}])
        self.assertEqual(resources["issue"]["collections"]["repositoryIssues"]["listQuery"], {"state": "all"})
        self.assertEqual(resources["githubRepository"]["identity"]["bindings"], {"repository_id": {"field": "id"}})
        self.assertEqual(resources["issue"]["identity"]["bindings"], {"issue_number": {"field": "number"}})

    def test_page_sizes_are_catalog_selection_not_provider_behavior(self):
        self.assertEqual(self.github["selection"]["query_overrides"], [
            {"path": "/user/orgs", "values": {"per_page": 100}},
            {"path": "/user/repos", "values": {"per_page": 100}},
            {"path": "/repositories/{repository_id}/issues", "values": {"per_page": 100}},
        ])
        parameters = self.document["paths"]["/repositories/{repository_id}/issues"]["get"]["parameters"]
        self.assertEqual([parameter["name"] for parameter in parameters], ["repository_id", "per_page", "page", "state", "after"])


if __name__ == "__main__":
    unittest.main()
