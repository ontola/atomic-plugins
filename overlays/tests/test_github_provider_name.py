"""Canonical GitHub catalog ID; provider bytes and historical profiles stay unchanged."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, compose, platform_config

CATALOG = ROOT / "catalog/2026-11-19-github.json"
PREVIOUS = ROOT / "catalog/2026-11-19-collection-navigation.json"


class GitHubProviderNameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.directory = Path(cls.temporary.name)
        cls.cache = cls.directory / "cache"
        cls.cache.mkdir()
        cls.catalog = json.loads(CATALOG.read_text())
        cls.previous = json.loads(PREVIOUS.read_text())
        cls.document, cls.provenance = compose("github", cls.cache, cls.catalog)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_only_the_provider_id_changes_and_all_other_sixteen_profiles_stay_identical(self):
        names = [entry["name"] for entry in self.catalog["platforms"]]
        self.assertEqual(len(names), 17)
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(names.count("github"), 1)
        self.assertNotIn("github-issues", names)
        expected = copy.deepcopy(self.previous)
        platform_config("github-issues", expected)["name"] = "github"
        self.assertEqual(self.catalog, expected)
        self.assertEqual(
            [entry for entry in self.catalog["platforms"] if entry["name"] != "github"],
            [entry for entry in self.previous["platforms"] if entry["name"] != "github-issues"],
        )

    def test_the_composed_document_and_every_source_hash_are_unchanged(self):
        previous_document, previous_provenance = compose(
            "github-issues", self.cache, self.previous)
        self.assertEqual(self.document, previous_document)
        self.assertEqual(self.provenance, previous_provenance)
        self.assertEqual(self.document["info"]["title"], "GitHub")
        principal = self.document["paths"]["/user"]["get"]["x-authenticated-principal"]
        self.assertEqual(principal["namespace"], "https://github.com")
        self.assertEqual(principal["subject"], "$response.body#/id")

    def test_fixture_generator_selects_the_exact_new_catalog_id_without_an_alias(self):
        output = self.directory / "canonical"
        subprocess.run([
            sys.executable, str(ROOT / "tests/generate_identity_catalog_fixtures.py"),
            "--catalog", str(CATALOG), "--platform", "github",
            "--cache", str(self.cache), "--output", str(output),
        ], check=True)
        manifest = json.loads((output / "sources.json").read_text())
        self.assertEqual(set(manifest["platforms"]), {"github"})
        self.assertEqual(manifest["platforms"]["github"], self.provenance)
        self.assertEqual(manifest["catalog"], {
            "path": "catalog/2026-11-19-github.json",
            "sha256": hashlib.sha256(CATALOG.read_bytes()).hexdigest(),
        })
        self.assertEqual(yaml.safe_load((output / "github-composed.yaml").read_text()), self.document)
        self.assertFalse((output / "github-issues-composed.yaml").exists())

    def test_historical_catalog_keeps_its_old_provider_id_and_has_no_new_alias(self):
        old_names = [entry["name"] for entry in self.previous["platforms"]]
        self.assertIn("github-issues", old_names)
        self.assertNotIn("github", old_names)
        with self.assertRaises(StopIteration):
            platform_config("github-issues", self.catalog)
        with self.assertRaises(StopIteration):
            platform_config("github", self.previous)

    def test_fixture_generator_historical_defaults_are_unchanged(self):
        output = self.directory / "historical-defaults"
        subprocess.run([
            sys.executable, str(ROOT / "tests/generate_identity_catalog_fixtures.py"),
            "--cache", str(self.cache), "--output", str(output),
        ], check=True)
        manifest = json.loads((output / "sources.json").read_text())
        self.assertEqual(manifest["catalog"]["path"], "catalog/2026-10-02.json")
        self.assertEqual(set(manifest["platforms"]), {"google-calendar", "github-issues"})


if __name__ == "__main__":
    unittest.main()
