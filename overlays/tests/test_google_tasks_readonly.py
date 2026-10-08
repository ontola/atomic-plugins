"""Read-only Google Tasks OAuth and Syncables metadata checks.

The pinned OAD is read from the sibling openapi-directory worktree when
available, otherwise from its immutable raw GitHub URL. These tests check
composition and declared generic-consumer behavior; they make no live Google
requests.
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
PIN = "7ca47c73cf2308c9812692b482b3713b397bc88c"
SOURCE_PATH = "APIs/googleapis.com/tasks/v1/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
TASKS = ROOT / "APIs/googleapis.com/tasks/v1"
sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay


def load_source():
    directory_repo = ROOT.parents[1] / "more-openapi-directory"
    try:
        raw = subprocess.check_output(
            ["git", "-C", str(directory_repo), "show", f"{PIN}:{SOURCE_PATH}"]
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        raw = urllib.request.urlopen(OAD, timeout=30).read()
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

    def test_syncables_discovers_root_then_paginates_each_tasks_collection(self):
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


if __name__ == "__main__":
    unittest.main()
