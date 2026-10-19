"""Focused composition checks for the Asana and Airtable read-only overlays.

The pinned OADs are downloaded from immutable raw GitHub URLs. This validates
metadata composition, not provider credentials or live API behavior.
"""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay
from pinned_oad import read_pinned_oad

_spec = importlib.util.spec_from_file_location(
    "pagination_validate", ROOT.parent / "openapi-extensions" / "spec" / "pagination-schemes" / "validate.py")
PAGINATION = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PAGINATION)


def load_yaml(path):
    return yaml.safe_load(path.read_text())


# The catalog's selection (catalog/2026-10-08-asana-airtable.json), named
# explicitly: a later revision at the same pin must not be composed in.
KINDS = ("auth", "pagination", "crud-causality")
ASANA_PIN = "b58c91d9f59c6a10178916e7948793809edae46d"
AIRTABLE_PIN = "1f5368e0251bfbaa233860dc8131507c38a4f8b3"


def composed(provider, pin, version):
    source_path = f"APIs/{version}/openapi.yaml"
    raw = read_pinned_oad(
        pin,
        source_path,
        f"https://raw.githubusercontent.com/{provider}/{pin}/{source_path}",
        [ROOT.parent.parent / "openapi-directory"],
    )
    document = yaml.safe_load(raw)
    directory = ROOT / "APIs" / version
    overlays = [directory / f"{kind}-{pin}-overlay.yaml" for kind in KINDS]
    for path in overlays:
        document, errors = apply_overlay(document, load_yaml(path), str(path))
        if errors:
            raise AssertionError("\n".join(errors))
    return document


class ReadonlyOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.asana = composed("ontola/openapi-directory", ASANA_PIN, "asana.com/1.0")
        cls.airtable = composed("localthought/openapi-directory", AIRTABLE_PIN, "airtable.com/1.0-readonly")

    def test_asana_profile_is_scoped_to_selected_read_operations(self):
        doc = self.asana
        profile = doc["components"]["x-authentication-profiles"]["asanaReadOnly"]
        scheme = doc["components"]["securitySchemes"][profile["securityScheme"]]
        self.assertEqual(set(scheme["flows"]["authorizationCode"]["scopes"]), {"workspaces:read", "projects:read", "tasks:read", "users:read"})
        expected = {
            ("/workspaces", "workspaces:read"), ("/workspaces/{workspace_gid}", "workspaces:read"),
            ("/workspaces/{workspace_gid}/projects", "projects:read"), ("/projects/{project_gid}", "projects:read"),
            ("/projects/{project_gid}/tasks", "tasks:read"), ("/tasks/{task_gid}", "tasks:read"),
            ("/users", "users:read"), ("/users/{user_gid}", "users:read"),
        }
        for path, scope in expected:
            operation = doc["paths"][path]["get"]
            self.assertEqual(operation["security"], [{"asanaReadOnlyOAuth": [scope]}])
            self.assertIn("x-crud", operation)
        self.assertEqual(scheme["x-oauth-authentication-details"]["authorizationCode"]["pkce"]["requirement"], "optional")
        self.assertEqual(scheme["x-oauth-authentication-details"]["authorizationServerMetadata"]["code_challenge_methods_supported"], ["S256"])
        self.assertEqual(scheme["type"], "oauth2")
        flow = scheme["flows"]["authorizationCode"]
        self.assertEqual((flow["authorizationUrl"], flow["tokenUrl"]),
                         ("https://app.asana.com/-/oauth_authorize", "https://app.asana.com/-/oauth_token"))

    def test_the_composed_overlays_are_the_catalogs_selection(self):
        catalog = json.loads((ROOT / "catalog" / "2026-10-08-asana-airtable.json").read_text(encoding="utf-8"))
        selected = {p["name"]: [url.rsplit("/", 1)[1] for url in p["overlays"]] for p in catalog["platforms"]}
        for name, pin in (("asana", ASANA_PIN), ("airtable", AIRTABLE_PIN)):
            with self.subTest(platform=name):
                self.assertEqual(selected[name], [f"{kind}-{pin}-overlay.yaml" for kind in KINDS])

    def test_pagination_validator_passes_both_compositions(self):
        # Catches an x-pagination that names a scheme no longer declared, on any operation.
        PAGINATION.validate(deepcopy(self.asana))
        PAGINATION.validate(deepcopy(self.airtable))

    def test_asana_crud_collections_match_paged_response_envelopes(self):
        doc = self.asana
        resources = doc["components"]["crudResources"]
        for name, path in [("workspace", "/workspaces"), ("project", "/workspaces/{workspace_gid}/projects"), ("task", "/projects/{project_gid}/tasks"), ("user", "/users")]:
            collection = next(iter(resources[name]["collections"].values()))
            self.assertEqual(collection["urlTemplate"], path)
            self.assertEqual(collection["envelope"]["itemsField"], "data")
            self.assertIn("x-pagination", doc["paths"][path]["get"])

    def test_airtable_read_profile_and_record_offset(self):
        doc = self.airtable
        profile = doc["components"]["x-authentication-profiles"]["airtableReadOnly"]
        scheme = doc["components"]["securitySchemes"][profile["securityScheme"]]
        self.assertEqual(set(scheme["flows"]["authorizationCode"]["scopes"]), {"schema.bases:read", "data.records:read"})
        self.assertEqual(scheme["x-oauth-authentication-details"]["authorizationServerMetadata"]["token_endpoint_auth_methods_supported"], ["client_secret_basic", "none"])
        self.assertEqual(scheme["x-oauth-authentication-details"]["authorizationCode"]["pkce"]["requirement"], "required")
        self.assertEqual(doc["paths"]["/v0/meta/bases"]["get"]["security"], [{"airtableReadOnlyOAuth": ["schema.bases:read"]}])
        self.assertEqual(doc["paths"]["/v0/meta/bases/{baseId}/tables"]["get"]["security"], [{"airtableReadOnlyOAuth": ["schema.bases:read"]}])
        records = doc["paths"]["/v0/{baseId}/{tableIdOrName}"]["get"]
        self.assertEqual(records["security"], [{"airtableReadOnlyOAuth": ["data.records:read"]}])
        pagination = doc["components"]["paginationSchemes"]["recordsOffset"]
        self.assertEqual(pagination["request"]["queryParameters"]["offset"]["role"], "cursor")
        self.assertEqual(pagination["response"]["envelope"]["itemsField"], "records")
        self.assertEqual(pagination["response"]["bodyFields"]["offset"]["role"], "nextCursor")
        self.assertIn("x-pagination", records)

    # The checks below compare whole declarations, so a dropped or changed field
    # (a role, an envelope, a scheme name, an endpoint URL) fails a test.

    def test_airtable_pagination_schemes_and_applications_are_exact(self):
        doc = self.airtable
        schemes = {name: without_description(scheme)
                   for name, scheme in doc["components"]["paginationSchemes"].items()}
        offset_response = lambda items: {"envelope": {"itemsField": items},
                                         "bodyFields": {"offset": {"role": "nextCursor"}}}
        self.assertEqual(schemes, {
            "basesOffset": {"type": "pageToken", "autoDetect": False,
                            "request": {"queryParameters": {"offset": {"role": "cursor"}}},
                            "response": offset_response("bases")},
            "recordsOffset": {"type": "pageToken", "autoDetect": False,
                              "request": {"queryParameters": {"offset": {"role": "cursor"},
                                                              "pageSize": {"role": "pageSize"}}},
                              "response": offset_response("records")},
        })
        self.assertEqual(doc["paths"]["/v0/meta/bases"]["get"]["x-pagination"], [{"scheme": "basesOffset"}])
        self.assertEqual(doc["paths"]["/v0/{baseId}/{tableIdOrName}"]["get"]["x-pagination"],
                         [{"scheme": "recordsOffset"}])

    def test_airtable_oauth_scheme_is_exact(self):
        doc = self.airtable
        scheme = doc["components"]["securitySchemes"]["airtableReadOnlyOAuth"]
        self.assertEqual(scheme["type"], "oauth2")
        flow = scheme["flows"]["authorizationCode"]
        self.assertEqual((flow["authorizationUrl"], flow["tokenUrl"]),
                         ("https://airtable.com/oauth2/v1/authorize", "https://airtable.com/oauth2/v1/token"))
        self.assertEqual(scheme["x-oauth-authentication-details"], {
            "authorizationServerMetadata": {"token_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
                                            "code_challenge_methods_supported": ["S256"]},
            "authorizationCode": {"pkce": {"requirement": "required"}},
        })
        self.assertEqual(doc["paths"]["/v0/{baseId}/{tableIdOrName}/{recordId}"]["get"]["security"],
                         [{"airtableReadOnlyOAuth": ["data.records:read"]}])

    def test_asana_cursor_scheme_on_the_four_catalog_lists_is_exact(self):
        doc = self.asana
        self.assertEqual(without_description(doc["components"]["paginationSchemes"]["cursorData"]), {
            "type": "pageToken", "autoDetect": False,
            "request": {"queryParameters": {"offset": {"role": "cursor"},
                                            "limit": {"role": "pageSize", "required": True}}},
            "response": {"envelope": {"itemsField": "data"},
                         "bodyFields": {"next_page.offset": {"role": "nextCursor"}}},
        })
        for path in ("/workspaces", "/workspaces/{workspace_gid}/projects", "/projects/{project_gid}/tasks", "/users"):
            with self.subTest(path=path):
                self.assertEqual(doc["paths"][path]["get"]["x-pagination"], [{"scheme": "cursorData"}])


def without_description(scheme):
    scheme = deepcopy(scheme)
    scheme.pop("description", None)
    return scheme


if __name__ == "__main__":
    unittest.main()
