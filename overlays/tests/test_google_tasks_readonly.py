"""Read-only Google Tasks OAuth and Syncables metadata checks.

The pinned OAD is read from the sibling openapi-directory worktree when
available, otherwise from its immutable raw GitHub URL. These tests check
composition and declared generic-consumer behavior; they make no live Google
requests.
"""
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import unittest

import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[1]
PIN = "7ca47c73cf2308c9812692b482b3713b397bc88c"
SOURCE_PATH = "APIs/googleapis.com/tasks/v1/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
TASKS = ROOT / "APIs/googleapis.com/tasks/v1"
sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay
from pinned_oad import read_pinned_oad

SPECS = ROOT.parent / "openapi-extensions" / "spec"


def load_validator(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CRUD = load_validator("crud_validate", SPECS / "crud-causality" / "validate.py")
PAGINATION = load_validator("pagination_validate", SPECS / "pagination-schemes" / "validate.py")


def load_source():
    raw = read_pinned_oad(
        PIN, SOURCE_PATH, OAD, [ROOT.parents[1] / "more-openapi-directory"]
    )
    return yaml.safe_load(raw)


def compose():
    document = load_source()
    for filename in (
        f"auth-v2-{PIN}-overlay.yaml",
        f"pagination-{PIN}-overlay.yaml",
        f"crud-causality-{PIN}-overlay.yaml",
    ):
        overlay_path = TASKS / filename
        document, errors = apply_overlay(
            document, yaml.safe_load(overlay_path.read_text()), str(overlay_path)
        )
        if errors:
            raise AssertionError("\n".join(errors))
    standard = deepcopy(document)
    for key in ("paginationSchemes", "crudResources", "x-authentication-profiles"):
        standard.get("components", {}).pop(key, None)
    validate(standard)
    return document


class GoogleTasksReadonlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = compose()

    def test_profile_covers_only_the_three_read_calls(self):
        doc = self.document
        profile = doc["components"]["x-authentication-profiles"]["googleTasksReadOnly"]
        self.assertEqual(profile["securityScheme"], "googleTasksReadOnlyOAuth")
        scheme = doc["components"]["securitySchemes"][profile["securityScheme"]]
        scope = "https://www.googleapis.com/auth/tasks.readonly"
        self.assertEqual(set(scheme["flows"]["authorizationCode"]["scopes"]), {scope})
        self.assertEqual(
            scheme["x-oauth-authentication-details"]["authorizationCode"]["pkce"]["requirement"],
            "optional",
        )
        expected = {
            ("get", "/tasks/v1/users/@me/lists"),
            ("get", "/tasks/v1/lists/{tasklist}/tasks"),
            ("get", "/tasks/v1/lists/{tasklist}/tasks/{task}"),
        }
        covered = set()
        for path, item in doc["paths"].items():
            for method, operation in item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                if any(
                    list(requirement) == ["googleTasksReadOnlyOAuth"]
                    for requirement in operation.get("security", [])
                ):
                    covered.add((method, path))
                    self.assertEqual(
                        operation["security"], [{"googleTasksReadOnlyOAuth": [scope]}]
                    )
        self.assertEqual(covered, expected)
        # In particular, list creation, task creation, and task mutation stay
        # outside the selected OAuth profile and are refused by profile policy.
        self.assertEqual(set(doc["paths"]["/tasks/v1/users/@me/lists"]), {"get", "post", "parameters"})
        self.assertEqual(set(doc["paths"]["/tasks/v1/lists/{tasklist}/tasks"]), {"get", "post", "parameters"})
        task = doc["paths"]["/tasks/v1/lists/{tasklist}/tasks/{task}"]
        self.assertEqual(set(task) - {"parameters"}, {"get", "delete", "patch", "put"})
        for path, methods in (
            ("/tasks/v1/users/@me/lists", {"post"}),
            ("/tasks/v1/lists/{tasklist}/tasks", {"post"}),
            ("/tasks/v1/lists/{tasklist}/tasks/{task}", {"delete", "patch", "put"}),
        ):
            for method in methods:
                self.assertNotIn(
                    {"googleTasksReadOnlyOAuth": [scope]},
                    doc["paths"][path][method]["security"],
                )

    def test_collection_and_pagination_declarations(self):
        doc = self.document
        resources = doc["components"]["crudResources"]
        self.assertEqual(
            resources["taskList"]["collections"]["taskLists"]["urlTemplate"],
            "/tasks/v1/users/@me/lists",
        )
        self.assertEqual(
            resources["task"]["collections"]["tasks"]["urlTemplate"],
            "/tasks/v1/lists/{tasklist}/tasks",
        )
        self.assertEqual(
            resources["taskList"]["identity"]["bindings"]["tasklist"]["field"],
            "id",
        )
        # tasklist is supplied by the root taskList collection, so a caller
        # needs no workspace/list id input before Syncables can start walking.
        self.assertNotIn("tasklist", resources["taskList"]["collections"]["taskLists"]["urlTemplate"])
        self.assertIn("{tasklist}", resources["task"]["collections"]["tasks"]["urlTemplate"])
        self.assertIn("parent", doc["components"]["schemas"]["Task"]["properties"])
        for path, query in (
            ("/tasks/v1/users/@me/lists", "maxResults"),
            ("/tasks/v1/lists/{tasklist}/tasks", "maxResults"),
        ):
            operation = doc["paths"][path]["get"]
            paging = operation["x-pagination"][0]
            self.assertEqual(paging["scheme"], "forwardPages")
            self.assertEqual(paging["overrides"]["request"]["queryParameters"][query]["role"], "pageSize")
            self.assertEqual(paging["overrides"]["response"]["envelope"]["itemsField"], "items")
            self.assertIn("nextPageToken", doc["components"]["paginationSchemes"]["forwardPages"]["response"]["bodyFields"])

    # The checks below compare whole declarations and run the extension
    # validators, so a dropped or changed field (a binding, an x-crud action, a
    # role, an OAuth detail) fails a test.

    def test_composition_passes_the_extension_validators(self):
        warnings = []
        CRUD.validate(deepcopy(self.document), warnings)
        self.assertEqual(warnings, [])
        PAGINATION.validate(deepcopy(self.document))

    def test_crud_resources_and_operations_are_exact(self):
        doc = self.document

        def resource(schema, item, binding, collection, collection_url):
            return {"schema": {"$ref": f"#/components/schemas/{schema}"},
                    "identity": {"urlTemplate": item, "bindings": {binding: {"field": "id"}}},
                    "collections": {collection: {"urlTemplate": collection_url}}}
        self.assertEqual(doc["components"]["crudResources"], {
            "taskList": resource("TaskList", "/tasks/v1/users/@me/lists/{tasklist}", "tasklist", "taskLists",
                                 "/tasks/v1/users/@me/lists"),
            "task": resource("Task", "/tasks/v1/lists/{tasklist}/tasks/{task}", "task", "tasks",
                             "/tasks/v1/lists/{tasklist}/tasks"),
        })
        for path, crud in (
            ("/tasks/v1/users/@me/lists", {"action": "list", "resource": "taskList", "collection": "taskLists"}),
            ("/tasks/v1/lists/{tasklist}/tasks", {"action": "list", "resource": "task", "collection": "tasks"}),
            ("/tasks/v1/lists/{tasklist}/tasks/{task}", {"action": "read", "resource": "task"}),
        ):
            with self.subTest(path=path):
                self.assertEqual(doc["paths"][path]["get"]["x-crud"], crud)

    def test_forward_pages_scheme_is_exact(self):
        scheme = deepcopy(self.document["components"]["paginationSchemes"]["forwardPages"])
        self.assertTrue(scheme.pop("description"))
        self.assertEqual(scheme, {
            "type": "pageToken", "autoDetect": False,
            "request": {"queryParameters": {"pageToken": {"role": "cursor"}}},
            "response": {"bodyFields": {"nextPageToken": {"role": "nextCursor"}}},
        })

    def test_oauth_details_are_exact(self):
        scheme = self.document["components"]["securitySchemes"]["googleTasksReadOnlyOAuth"]
        self.assertEqual(scheme["type"], "oauth2")
        flow = scheme["flows"]["authorizationCode"]
        self.assertEqual((flow["authorizationUrl"], flow["tokenUrl"]),
                         ("https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token"))
        details = deepcopy(scheme["x-oauth-authentication-details"])
        self.assertTrue(details["authorizationCode"]["tokenIssuance"]["refreshToken"].pop("description"))
        self.assertEqual(details, {
            "authorizationServerMetadata": {
                "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
                "code_challenge_methods_supported": ["S256"]},
            "authorizationCode": {
                "pkce": {"requirement": "optional"},
                "profile": {"parameters": [{
                    "parameter": {"name": "access_type", "in": "query",
                                  "schema": {"type": "string", "enum": ["offline"]}},
                    "value": "offline"}]},
                "capabilities": ["offlineAccess"],
                "tokenIssuance": {"refreshToken": {"presence": "conditional",
                                                   "conditions": ["firstAuthorization"]}}},
        })


if __name__ == "__main__":
    unittest.main()
