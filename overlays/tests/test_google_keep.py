"""Google Keep OAuth profile checks (integrations/google-keep/).

Composition only: the pinned OAD (from the sibling openapi-directory
worktree when available, otherwise its immutable raw GitHub URL) with the
auth overlay, the way catalog/2026-10-14-google-keep.json selects it. No live
Google request is made; the Keep API is offered to Google Workspace accounts
only.
"""
from copy import deepcopy
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.request
import unittest

import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[1]
PIN = "091431739208d017c11b0b0589ab33293f8b3690"
SOURCE_PATH = "APIs/googleapis.com/keep/v1/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
KEEP = ROOT / "APIs/googleapis.com/keep/v1"
SCOPE = "https://www.googleapis.com/auth/keep"
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
    overlay_path = KEEP / f"auth-{PIN}-overlay.yaml"
    document, errors = apply_overlay(
        document, yaml.safe_load(overlay_path.read_text()), str(overlay_path)
    )
    if errors:
        raise AssertionError("\n".join(errors))
    standard = deepcopy(document)
    standard.get("components", {}).pop("x-authentication-profiles", None)
    validate(standard)
    return document


def path_matches(template, path):
    """integration-proxy catalog.rs path_matches: segment by segment."""
    left = template.strip("/").split("/")
    right = path.strip("/").split("/")
    if len(left) != len(right):
        return False
    return all(
        re.fullmatch(re.sub(r"\\\{[^}]*\\\}", "[^/]+", re.escape(t)), p)
        for t, p in zip(left, right)
    )


class GoogleKeepTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = compose()

    def test_profile_covers_the_four_calls_the_app_makes(self):
        doc = self.document
        profile = doc["components"]["x-authentication-profiles"]["googleKeep"]
        self.assertEqual(profile["securityScheme"], "googleKeepOAuth")
        scheme = doc["components"]["securitySchemes"]["googleKeepOAuth"]
        self.assertEqual(set(scheme["flows"]["authorizationCode"]["scopes"]), {SCOPE})
        covered = set()
        for path, item in doc["paths"].items():
            for method, operation in item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                if any(list(r) == ["googleKeepOAuth"] for r in operation.get("security", [])):
                    covered.add((method, path))
                    self.assertEqual(operation["security"], [{"googleKeepOAuth": [SCOPE]}])
        self.assertEqual(
            covered,
            {
                ("get", "/v1/notes"),
                ("post", "/v1/notes"),
                ("get", "/v1/notes/{note}"),
                ("delete", "/v1/notes/{note}"),
            },
        )
        # Sharing stays outside the profile.
        for path in ("/v1/{parent}/permissions:batchCreate", "/v1/{parent}/permissions:batchDelete"):
            self.assertNotIn({"googleKeepOAuth": [SCOPE]}, doc["paths"][path]["post"]["security"])

    def test_the_app_paths_resolve_to_the_profile_operations(self):
        # The proxy takes the first template that matches, in document order.
        paths = list(self.document["paths"])
        for method, path, expected in (
            ("get", "/v1/notes", "/v1/notes"),
            ("post", "/v1/notes", "/v1/notes"),
            ("get", "/v1/notes/abc123", "/v1/notes/{note}"),
            ("delete", "/v1/notes/abc123", "/v1/notes/{note}"),
        ):
            found = next(t for t in paths if path_matches(t, path))
            self.assertEqual(found, expected, (method, path))
            self.assertIn(method, self.document["paths"][found])

    def test_catalog_selects_the_profile(self):
        catalog = json.loads((ROOT / "catalog/2026-10-14-google-keep.json").read_text())
        keep = next(p for p in catalog["platforms"] if p["name"] == "google-keep")
        self.assertEqual(keep["selection"], {"authenticationProfile": "googleKeep"})
        self.assertIn(PIN, keep["openapi"])
        previous = json.loads((ROOT / "catalog/2026-10-12-tasks-box-pages.json").read_text())
        self.assertEqual(
            [p for p in catalog["platforms"] if p["name"] != "google-keep"],
            previous["platforms"],
        )


if __name__ == "__main__":
    unittest.main()
