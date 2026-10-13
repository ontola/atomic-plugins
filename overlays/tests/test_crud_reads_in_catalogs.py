"""Every dated catalog's compositions under the CRUD Causality validator, with the known findings listed.

CRUD Causality 0.4.0 promises that a 0.3.0 document stays valid, including one
that uses syncables' x-list-* forms (rules 14-18 constrain the standard fields
only). This composes every platform of every dated catalog, in catalog order,
from the checkout and the pinned OADs, and runs the validator (every rule of
§8 since #524) on each. The pinned OADs are downloaded by their full-SHA URLs;
no provider is called.

KNOWN lists the findings of published overlay revisions, which cannot change:
a new revision, selected by a new dated catalog, removes them. The test fails
on any finding not listed, and on any listed finding no composition shows any
more, so the list only shrinks.
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


# (platform, error or warning, message): the findings of published revisions.
KNOWN = {
    # googleapis.com/calendar/v3/app-crud-causality-32237fa5…: the event PATCH
    # declares no mode. Removed by a later app-crud-causality revision (no PR
    # yet) once a dated catalog selects it.
    ("google-calendar", "error",
     "paths./calendars/{calendarId}/events/{eventId}.patch.x-crud.mode: required for action update (rule 5)"),
    # github.com/github-issues/1.1.4/crud-causality-9c5cfb87…: patchFormat
    # `merge` is not a §4.6 value. Removed by the crud-causality-v2-9c5cfb87…
    # revision of #530 once a dated catalog selects it.
    ("github-issues", "error",
     "paths./repos/{owner}/{repo}/issues/{issue_number}.patch.x-crud.patchFormat: "
     "'merge' is not one of jsonPatch, jsonMergePatch, custom (§4.6)"),
    ("github-issues", "error",
     "paths./repos/{owner}/{repo}/issues/comments/{comment_id}.patch.x-crud.patchFormat: "
     "'merge' is not one of jsonPatch, jsonMergePatch, custom (§4.6)"),
    # The same file: the label follow-up updates are mode patch without a
    # patchFormat (rule 6, SHOULD). Also for that v2 revision.
    ("github-issues", "warning",
     "paths./repos/{owner}/{repo}/issues/{issue_number}/labels.post.x-crud: mode patch without patchFormat (rule 6, SHOULD)"),
    ("github-issues", "warning",
     "paths./repos/{owner}/{repo}/issues/{issue_number}/labels/{name}.delete.x-crud: "
     "mode patch without patchFormat (rule 6, SHOULD)"),
    # moneybird.com/v2-readonly/crud-causality-85a6105…: identity variables no
    # binding or collection supplies (rule 10, SHOULD). For a
    # crud-causality-v2-85a6105… revision, not yet written.
    ("moneybird", "warning",
     "crudResources.verification.identity.urlTemplate: {administration_id} is neither bound nor in a "
     "collection's urlTemplate (rule 10, SHOULD)"),
    ("moneybird", "warning",
     "crudResources.moneybird_payments_mandate.identity.urlTemplate: {administration_id} is neither bound nor "
     "in a collection's urlTemplate (rule 10, SHOULD)"),
    ("moneybird", "warning",
     "crudResources.moneybird_payments_mandate.identity.urlTemplate: {contact_id} is neither bound nor in a "
     "collection's urlTemplate (rule 10, SHOULD)"),
}


def findings(platform, document):
    """{(platform, kind, message)} the validator reports for one composition."""
    warnings = []
    try:
        crud.validate(document, warnings)
        errors = []
    except ValueError as raised:
        errors = str(raised).splitlines()
    return {(platform, "error", e) for e in errors} | {(platform, "warning", w) for w in warnings}


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

    def test_every_composition_has_only_the_known_findings(self):
        for (catalog, platform), document in self.compositions.items():
            found = findings(platform, document)
            with self.subTest(catalog=catalog, platform=platform):
                self.assertEqual(sorted(found - KNOWN), [], "new findings: fix the overlay, or list them in KNOWN")

    def test_every_known_finding_still_occurs(self):
        seen = set()
        for (catalog, platform), document in self.compositions.items():
            seen |= findings(platform, document)
        self.assertEqual(sorted(KNOWN - seen), [], "no longer found: remove them from KNOWN")

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
