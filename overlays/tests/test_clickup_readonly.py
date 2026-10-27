"""ClickUp overlay composition and profile checks against the pinned OAD."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
CATALOG = "overlays/catalog/2026-10-08-gitlab-tasks-clickup.json"
PIN = "de95e5bf40f54e3752281a771a786854038d683b"


def compose():
    raw = subprocess.check_output(
        ["python3", "overlays/tests/compose_gitlab_platform.py", "clickup"],
        cwd=REPO,
        env={**os.environ, "ONBOARDING_CATALOG_PATH": CATALOG},
    )
    return json.loads(raw)


class ClickUpOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = compose()

    def test_composed_document_is_valid_and_pinned(self):
        # These extension specifications intentionally add unprefixed keys
        # under components; the generic OpenAPI validator predates them.
        standard_openapi = json.loads(json.dumps(self.document))
        standard_openapi["components"].pop("crudResources", None)
        standard_openapi["components"].pop("paginationSchemes", None)
        validate(standard_openapi)
        entry = next(
            item for item in json.loads((REPO / CATALOG).read_text())["platforms"]
            if item["name"] == "clickup"
        )
        self.assertIn(PIN, entry["openapi"])
        for url in entry["overlays"]:
            path = ROOT / url.split("/overlays/", 1)[1]
            overlay = yaml.safe_load(path.read_text())
            self.assertIn(PIN, overlay["extends"])

    def test_oauth_profile_is_read_only_and_has_no_provider_scope(self):
        doc = self.document
        profile = doc["components"]["x-authentication-profiles"]["clickupReadOnly"]
        scheme_name = profile["securityScheme"]
        scheme = doc["components"]["securitySchemes"][scheme_name]
        self.assertEqual(scheme["flows"]["authorizationCode"]["scopes"], {})
        self.assertEqual(
            scheme["flows"]["authorizationCode"]["authorizationUrl"],
            "https://app.clickup.com/api",
        )
        self.assertEqual(
            scheme["flows"]["authorizationCode"]["tokenUrl"],
            "https://api.clickup.com/api/v2/oauth/token",
        )
        details = scheme["x-oauth-authentication-details"]
        self.assertEqual(
            details["authorizationServerMetadata"]["token_endpoint_auth_methods_supported"],
            ["client_secret_post"],
        )
        self.assertEqual(details["authorizationCode"]["pkce"]["requirement"], "unsupported")
        expected_paths = {
            "/v2/team",
            "/v2/team/{team_Id}/task",
            "/v2/task/{task_id}",
        }
        self.assertEqual(set(doc["paths"]), expected_paths)
        for path in expected_paths:
            self.assertEqual(doc["paths"][path]["get"]["security"], [{scheme_name: []}])

    def test_crud_traversal_and_page_metadata(self):
        doc = self.document
        resources = doc["components"]["crudResources"]
        self.assertEqual(resources["workspace"]["collections"]["workspaces"]["urlTemplate"], "/v2/team")
        self.assertEqual(
            resources["workspace"]["collections"]["workspaces"]["envelope"]["itemsField"],
            "teams",
        )
        self.assertEqual(resources["workspace"]["identity"]["bindings"]["team_Id"]["field"], "id")
        tasks = resources["task"]["collections"]["workspaceTasks"]
        self.assertEqual(tasks["urlTemplate"], "/v2/team/{team_Id}/task")
        self.assertEqual(tasks["envelope"]["itemsField"], "tasks")
        # The page number is the scheme's (Pagination Schemes 0.6.0 start: 0), not a fixed query.
        self.assertNotIn("x-list-query", tasks)
        self.assertNotIn("listQuery", tasks)
        self.assertEqual(doc["paths"]["/v2/team/{team_Id}/task"]["get"]["x-pagination"][0]["scheme"], "workspaceTaskPages")
        pagination = doc["components"]["paginationSchemes"]["workspaceTaskPages"]
        self.assertEqual(pagination["request"]["queryParameters"]["page"], {"role": "page", "start": 0})
        self.assertEqual(pagination["response"]["envelope"]["itemsField"], "tasks")
        self.assertEqual(
            {k: v for k, v in pagination["response"]["shortPage"].items() if k != "description"},
            {"size": 100, "assurance": "assumed"},
        )
        self.assertNotIn("bodyFields", pagination["response"])


if __name__ == "__main__":
    unittest.main()
