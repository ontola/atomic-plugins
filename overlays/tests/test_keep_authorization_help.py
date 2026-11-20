"""Keep admin guidance is declarative and changes no API/authentication policy."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from generate_identity_catalog_fixtures import ROOT, compose, platform_config

CATALOG = ROOT / "catalog/2026-11-20-authorization-help.json"
PREVIOUS = ROOT / "catalog/2026-11-19-github.json"


class KeepAuthorizationHelpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.cache = Path(cls.temporary.name)
        cls.catalog = json.loads(CATALOG.read_text())
        cls.previous = json.loads(PREVIOUS.read_text())
        cls.document, _ = compose("google-keep", cls.cache, cls.catalog)
        cls.before, _ = compose("google-keep", cls.cache, cls.previous)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_only_keep_gains_one_overlay_and_all_other_providers_are_identical(self):
        expected = copy.deepcopy(self.previous)
        current = platform_config("google-keep", self.catalog)
        previous = platform_config("google-keep", expected)
        self.assertEqual(current["overlays"][:-1], previous["overlays"])
        self.assertIn("authorization-help-", current["overlays"][-1])
        previous["overlays"] = current["overlays"]
        self.assertEqual(self.catalog, expected)

    def test_help_is_on_selected_scheme_and_composed_api_is_otherwise_unchanged(self):
        actual = copy.deepcopy(self.document)
        profile = actual["components"]["x-authentication-profiles"]["googleKeep"]
        scheme = actual["components"]["securitySchemes"][profile["securityScheme"]]
        help = scheme.pop("x-oauth-authorization-help")
        self.assertEqual(actual, self.before)
        self.assertIn("may need", help["summary"])
        admin = help["adminApproval"]
        self.assertEqual(admin["documentationUrl"], "https://developers.google.com/workspace/keep/api/guides")
        for text in ("OAuth-client-ID", "authenticated user's", "do not set up a service account", "permanently deleting", "does not guarantee"):
            self.assertIn(text, admin["description"])
        self.assertNotIn("clientSecret", json.dumps(help))
        self.assertNotIn("clientId", json.dumps(help))


if __name__ == "__main__":
    unittest.main()
