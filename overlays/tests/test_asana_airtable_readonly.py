"""Focused composition checks for the Asana and Airtable read-only overlays.

The pinned OADs are downloaded from immutable raw GitHub URLs. This validates
metadata composition, not provider credentials or live API behavior.
"""
from copy import deepcopy
from pathlib import Path
import subprocess
import sys
import urllib.request
import unittest

import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay


def load_yaml(path):
    return yaml.safe_load(path.read_text())


def composed(provider, pin, version):
    source_path = f"APIs/{version}/openapi.yaml"
    directory_repo = ROOT.parent.parent / "openapi-directory"
    try:
        raw = subprocess.check_output(["git", "-C", str(directory_repo), "show", f"{pin}:{source_path}"])
    except (subprocess.CalledProcessError, FileNotFoundError):
        source = f"https://raw.githubusercontent.com/{provider}/{pin}/{source_path}"
        raw = urllib.request.urlopen(source, timeout=30).read()
    document = yaml.safe_load(raw)
    directory = ROOT / "APIs" / version
    overlays = sorted(directory.glob(f"*-{pin}-overlay.yaml"))
    assert overlays, f"no overlays found for {version}@{pin}"
    for path in overlays:
        document, errors = apply_overlay(document, load_yaml(path), str(path))
        if errors:
            raise AssertionError("\n".join(errors))
    return document


class ReadonlyOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.asana = composed("ontola/openapi-directory", "b58c91d9f59c6a10178916e7948793809edae46d", "asana.com/1.0")
        cls.airtable = composed("localthought/openapi-directory", "1f5368e0251bfbaa233860dc8131507c38a4f8b3", "airtable.com/1.0-readonly")

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


if __name__ == "__main__":
    unittest.main()
