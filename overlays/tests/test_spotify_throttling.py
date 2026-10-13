"""Check the Spotify Web API Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD, alone and after the Spotify
overlays of catalog/2026-10-12-box-pagination-v2.json. The result must pass
the throttling reference validator and change nothing but `x-throttling`,
and synthetic responses in the form Spotify's rate-limits page describes
must classify as the overlay intends. No provider is called. Use
--directory for a full-history openapi-directory checkout; otherwise the
full-SHA source URL is downloaded.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "throttling_validate", ROOT.parent / "openapi-extensions" / "spec" / "throttling" / "validate.py")
throttling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(throttling)

DIRECTORY = None
NOW = 1_800_000_000
OVERLAY = "APIs/spotify.com/1.0.0-readonly/throttling-2914e6bed4db4389921b36e4ed79e645c2085668-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"


class SpotifyThrottlingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAY)
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.overlay = yaml.safe_load((ROOT / OVERLAY).read_text(encoding="utf-8"))
        cls.composed = copy.deepcopy(cls.original)
        apply(cls.composed, cls.overlay)

    def test_composition_is_valid_and_adds_only_x_throttling(self):
        throttling.validate(self.composed)
        standard = copy.deepcopy(self.composed)
        standard.pop("x-throttling")
        self.assertEqual(standard, self.original)

    def test_composes_after_the_catalogued_spotify_overlays(self):
        spotify = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                       if p["name"] == "spotify")
        self.assertTrue(spotify["openapi"].endswith(
            "/2914e6bed4db4389921b36e4ed79e645c2085668/APIs/spotify.com/1.0.0-readonly/openapi.yaml"))
        document = copy.deepcopy(self.original)
        for url in spotify["overlays"]:
            apply(document, yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8")))
        apply(document, self.overlay)
        throttling.validate(document)
        self.assertEqual(document["x-throttling"], self.composed["x-throttling"])

    def test_the_documented_window_without_a_number(self):
        root = self.composed["x-throttling"]
        self.assertEqual(root["applies"], ["perApp"])
        limit = root["limits"]["perApp"]
        self.assertNotIn("requests", limit)
        self.assertEqual((limit["window"], limit["partitionBy"]),
                         ({"seconds": 30, "kind": "sliding"}, ["application"]))

    def test_the_pinned_document_answers_429_as_a_rate_limit(self):
        described = {
            str(response.get("description"))
            for item in self.original["paths"].values()
            for operation in item.values() if isinstance(operation, dict)
            for status, response in operation.get("responses", {}).items()
            if str(status) == "429" and isinstance(response, dict)
        }
        self.assertEqual(described, {"Rate limit exceeded."})

    def test_429_with_retry_after_in_seconds(self):
        body = {"error": {"status": 429, "message": "API rate limit exceeded"}}
        self.assertEqual(throttling.classify(self.composed, 429, {"Retry-After": "7"}, body, NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 7})
        # "normally" includes it: without one the consumer's backoff applies.
        self.assertIsNone(throttling.classify(self.composed, 429, {}, body, NOW)["retryAt"])
        # An HTTP date is not the documented unit, so it is ignored.
        self.assertIsNone(throttling.classify(
            self.composed, 429, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, body, NOW)["retryAt"])

    def test_other_errors_are_not_throttling(self):
        for status in (401, 403, 404, 500, 503):
            with self.subTest(status=status):
                self.assertIsNone(throttling.classify(self.composed, status, {"Retry-After": "7"},
                                                      {"error": {"status": status, "message": "x"}}, NOW))

    def test_no_dated_catalog_selects_the_overlay(self):
        # Whoever adds the overlay to a dated catalog changes this test.
        name = OVERLAY.rsplit("/", 1)[1]
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(name, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
