"""Check the Clockify forceProjects write-precondition overlay against its exact source OAD.

The overlay composes after the crud-causality and time-entry-write overlays of
the same pin (in either order), the result must pass the write preconditions
and collection-read validators, and the reference client logic must refuse an
entry without a project exactly when the timesheets app does. No provider is
called. Use --directory for a full-history openapi-directory checkout;
otherwise the full-SHA source URL is downloaded.
"""
import argparse
import copy
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

SPECS = ROOT.parent / "openapi-extensions" / "spec"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wp = load("write_preconditions", SPECS / "write-preconditions" / "validate.py")
crud = load("crud_validate", SPECS / "crud-causality" / "validate.py")

DIRECTORY = None
PIN = "dd34a70a45c5109479068b4b5d91337baf8822cd"
FOLDER = "APIs/clockify.me/1.0.0-readonly/"
OVERLAYS = [FOLDER + f"crud-causality-{PIN}-overlay.yaml", FOLDER + f"time-entry-write-{PIN}-overlay.yaml",
            FOLDER + f"write-preconditions-{PIN}-overlay.yaml"]
CREATE = "/v1/workspaces/{workspaceId}/time-entries"
UPDATE = "/v1/workspaces/{workspaceId}/time-entries/{id}"


class ClockifyForceProjectsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAYS[-1])
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.overlays = [yaml.safe_load((ROOT / path).read_text()) for path in OVERLAYS]
        cls.composed = copy.deepcopy(cls.original)
        for overlay in cls.overlays:
            apply(cls.composed, overlay)

    def test_composition_passes_the_validators_in_either_order(self):
        wp.validate(self.composed)
        crud.validate(self.composed)
        reordered = copy.deepcopy(self.original)
        for overlay in [self.overlays[-1], *self.overlays[:-1]]:
            apply(reordered, overlay)
        self.assertEqual(reordered, self.composed)

    def test_workspace_settings_and_resource(self):
        self.assertNotIn("Workspace", self.original.get("components", {}).get("schemas", {}))
        workspace = self.composed["components"]["schemas"]["Workspace"]
        self.assertEqual(workspace["required"], ["id", "name"])  # kept from the crud-causality overlay
        self.assertEqual(workspace["properties"]["settings"]["properties"]["forceProjects"]["type"], "boolean")
        resource = self.composed["components"]["crudResources"]["workspace"]
        self.assertEqual(resource["collections"]["workspaces"]["urlTemplate"], "/v1/workspaces")
        self.assertIn("/v1/workspaces", self.composed["paths"])
        body = self.composed["components"]["schemas"]["TimeEntryWriteRequest"]["properties"]
        self.assertEqual(body["projectId"]["type"], "string")

    def test_entries_without_a_project_are_refused_under_force_projects(self):
        forced = {"workspace": {"id": "w1", "settings": {"forceProjects": True}}}
        relaxed = {"workspace": {"id": "w1", "settings": {"forceProjects": False}}}
        no_project = {"start": "2026-10-08T09:00:00Z", "end": "2026-10-08T10:00:00Z"}
        with_project = dict(no_project, projectId="p1")
        for path, method, action in ((CREATE, "post", "create"), (UPDATE, "put", "update")):
            declaration = self.composed["paths"][path][method]["x-write-precondition"]
            send = lambda body, sources: wp.may_send(declaration, {}, list(body), None, body=body, sources=sources, action=action)
            with self.subTest(method=method):
                self.assertEqual(send(no_project, forced)[0], "refused")
                self.assertEqual(send(with_project, forced), ("send", {}))
                self.assertEqual(send(no_project, relaxed), ("send", {}))
                # The workspace could not be read (the app's 403/404 warning): fail closed for entries without a project.
                self.assertEqual(send(no_project, {"workspace": None})[0], "source-unknown")
                self.assertEqual(send(with_project, {"workspace": None}), ("send", {}))
        app = (ROOT.parent / "integrations/timesheets/app/clockifyApi.ts").read_text()
        self.assertIn("workspace?.settings?.forceProjects", app)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
