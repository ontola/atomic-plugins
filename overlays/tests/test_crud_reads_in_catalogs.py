"""Every dated catalog's compositions stay valid under the CRUD Causality 0.4.0 read rules.

CRUD Causality 0.4.0 promises that a 0.3.0 document stays valid, including one
that uses syncables' x-list-* forms (rules 14-18 constrain the standard fields
only). This composes every platform of every dated catalog, in catalog order,
from the checkout and the pinned OADs, and runs the collection-read validator
on each. The pinned OADs are downloaded by their full-SHA URLs; no provider is
called.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

spec = importlib.util.spec_from_file_location(
    "crud_validate", ROOT.parent / "openapi-extensions" / "spec" / "crud-causality" / "validate.py")
crud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crud)


class CatalogCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compositions = {}
        with tempfile.TemporaryDirectory() as cache:
            for catalog_path in sorted((ROOT / "catalog").glob("*.json")):
                catalog = json.loads(catalog_path.read_text())
                for platform in catalog["platforms"]:
                    document = yaml.safe_load(fetch(platform["openapi"], Path(cache))[0])
                    for url in platform.get("overlays", []):
                        apply(document, yaml.safe_load(fetch(url, Path(cache))[0]))
                    cls.compositions[(catalog_path.name, platform["name"])] = document

    def test_every_composition_passes_the_collection_read_validator(self):
        for (catalog, platform), document in self.compositions.items():
            with self.subTest(catalog=catalog, platform=platform):
                warnings = []
                crud.validate(document, warnings)
                self.assertEqual(warnings, [])

    def test_the_github_issues_x_list_query_collection_is_a_consumer_fallback(self):
        document = self.compositions[("2026-10-02.json", "github-issues")]
        issues = document["components"]["crudResources"]["issue"]["collections"]["issues"]
        self.assertEqual(issues["x-list-query"], {"state": "all"})
        parameters = document["paths"]["/repos/{owner}/{repo}/issues"]["get"].get("parameters", [])
        names = {crud._resolve(document, p).get("name") for p in parameters}
        self.assertNotIn("state", names)  # the pinned subset OAD does not declare it
        self.assertTrue(crud.defines_read(issues))
        self.assertFalse(crud.declares_standard(issues))
        self.assertEqual(crud.read_request(document, "issue", "issues", {"owner": "o", "repo": "r"}),
                         ("GET", "/repos/o/r/issues?state=all", None))


if __name__ == "__main__":
    unittest.main()
