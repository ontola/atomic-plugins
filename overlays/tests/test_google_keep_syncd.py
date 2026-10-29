"""Current Keep OAD, SyncD metadata, and the proxy's exact default catalog.

Only pinned public descriptions are fetched. All note values are synthetic;
these checks do not authorize or perform any request to Google Keep.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from generate_identity_catalog_fixtures import ROOT, compose
from test_google_keep import path_matches

CATALOG = ROOT / "catalog/2026-10-29-google-keep-writes.json"
PIN = "5ccf0e09eef66d45b43e97dfc364233b2707689c"
SCOPE = "https://www.googleapis.com/auth/keep"


def validator(name):
    spec = importlib.util.spec_from_file_location(
        name, ROOT.parent / "openapi-extensions/spec" / name / "validate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GoogleKeepSyncDTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG.read_text())
        with tempfile.TemporaryDirectory() as cache:
            cls.document, cls.sources = compose("google-keep", Path(cache), cls.catalog)

    def test_default_adds_only_keep_and_preserves_all_existing_platforms(self):
        previous = json.loads((ROOT / "catalog/2026-10-02-auth-profiles.json").read_text())
        self.assertEqual([p for p in self.catalog["platforms"] if p["name"] != "google-keep"], previous["platforms"])
        entry = next(p for p in self.catalog["platforms"] if p["name"] == "google-keep")
        self.assertEqual(entry["selection"], {"authenticationProfile": "googleKeep"})
        self.assertEqual(len(entry["overlays"]), 3)
        self.assertTrue(all(PIN in source["url"] for source in self.sources))
        config = (ROOT.parent / "integration-proxy/src/config.rs").read_text()
        self.assertIn(f'"catalog/{CATALOG.name}"', config)
        self.assertIn(f'/overlays/catalog/{CATALOG.name}"', config)

    def test_all_seven_google_operations_survive_without_an_update(self):
        operations = {op["operationId"] for item in self.document["paths"].values()
                      for method, op in item.items() if method in {"get", "post", "delete", "put", "patch"}}
        self.assertEqual(operations, {
            "keep.notes.list", "keep.notes.get", "keep.notes.create", "keep.notes.delete",
            "keep.notes.permissions.batchCreate", "keep.notes.permissions.batchDelete",
            "keep.media.download", "keep.notes.get.byId", "keep.notes.delete.byId",
        })
        self.assertTrue(all("patch" not in item and "put" not in item for item in self.document["paths"].values()))
        download = self.document["paths"]["/v1/notes/{note}/attachments/{attachment}"]["get"]
        self.assertEqual(download["responses"]["200"]["content"]["*/*"]["schema"], {"type": "string", "format": "binary"})

    def test_profile_selects_only_note_read_create_delete(self):
        doc = self.document
        self.assertEqual(doc["components"]["x-authentication-profiles"]["googleKeep"]["securityScheme"], "googleKeepOAuth")
        covered = {(method, path) for path, item in doc["paths"].items()
                   for method, op in item.items()
                   if method in {"get", "post", "delete", "put", "patch"}
                   and {"googleKeepOAuth": [SCOPE]} in op.get("security", [])}
        self.assertEqual(covered, {("get", "/v1/notes"), ("post", "/v1/notes"),
                                   ("get", "/v1/notes/{note}"), ("delete", "/v1/notes/{note}")})
        for path in ["/v1/notes", "/v1/notes/invented-note"]:
            matches = [t for t in doc["paths"] if path_matches(t, path)]
            self.assertEqual(matches[0], "/v1/notes" if path == "/v1/notes" else "/v1/notes/{note}")

    def test_extension_contracts_validate_without_findings(self):
        warnings = []
        validator("crud-causality").validate(self.document, warnings)
        self.assertEqual(warnings, [])
        validator("pagination-schemes").validate(self.document)

    def test_missing_notes_are_empty_but_malformed_notes_are_refused(self):
        pagination = validator("pagination-schemes")
        scheme = self.document["components"]["paginationSchemes"]["forwardPages"]
        self.assertEqual(pagination.page_items({"nextPageToken": "invented-next"}, scheme), [])
        for value in [None, {}, "invalid"]:
            with self.assertRaises(pagination.PageReadError):
                pagination.page_items({"notes": value}, scheme)

    def test_replacements_block_attachments_and_live_collaborators(self):
        crud = validator("crud-causality")
        note = self.document["components"]["crudResources"]["note"]
        self.assertEqual(note["identity"], {"urlTemplate": "/v1/{name}", "bindings": {"name": {"field": "name", "x-path-segments": True}}})
        self.assertEqual(self.document["paths"]["/v1/notes"]["post"]["x-crud"]["url"], {"source": "template"})
        self.assertIs(self.document["components"]["schemas"]["ListItem"]["properties"]["checked"]["default"], False)
        self.assertEqual(self.document["components"]["schemas"]["ListItem"]["properties"]["childListItems"]["default"], [])
        replacement = note["replace"]
        self.assertEqual(crud.replace_block(replacement, {"attachments": [{}]})["field"], "attachments")
        owner = {"role": "OWNER"}
        writer = {"role": "WRITER"}
        self.assertEqual(crud.replace_block(replacement, {"permissions": [owner, writer]})["field"], "permissions")
        self.assertIsNone(crud.replace_block(replacement, {"permissions": [owner, {**writer, "deleted": True}]}))
        self.assertEqual(note["unkeyedLists"], {"body.list.listItems": {"match": ["text.text", "checked"], "children": "childListItems"}})

    def test_syncd_example_is_the_exact_composed_oad(self):
        example = json.loads((ROOT.parent / "syncables/examples/daemon/google-keep.json").read_text())
        self.assertEqual(example, self.document)
        self.assertEqual(example["info"]["title"], "Google Keep API")
        self.assertEqual(example["info"]["version"], "v1")


if __name__ == "__main__":
    unittest.main()
