"""Check the GitLab.com REST API v4 Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD, alone and after the GitLab
overlays of catalog/2026-10-12-box-pagination-v2.json. The result must pass
the throttling reference validator and change nothing but `x-throttling`,
the documented limit must be declared, and synthetic responses carrying
GitLab's documented headers must classify as the overlay intends. No
provider is called. Use --directory for a full-history openapi-directory
checkout; otherwise the full-SHA source URL is downloaded.
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
OVERLAY = "APIs/gitlab.com/v4-readonly/throttling-f6d7940e9865903b9c99c5c1fc2d57d92811eef4-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"


class GitLabThrottlingTests(unittest.TestCase):
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

    def test_composes_after_the_catalogued_gitlab_overlays(self):
        gitlab = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                      if p["name"] == "gitlab")
        document = copy.deepcopy(self.original)
        for url in gitlab["overlays"]:
            apply(document, yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8")))
        apply(document, self.overlay)
        throttling.validate(document)
        self.assertEqual(document["x-throttling"], self.composed["x-throttling"])

    def test_the_document_is_gitlab_com_and_the_limit_is_its_own(self):
        self.assertEqual([s["url"] for s in self.original["servers"]], ["https://gitlab.com/api/v4"])
        root = self.composed["x-throttling"]
        self.assertEqual(root["applies"], ["authenticatedApi"])
        limit = root["limits"]["authenticatedApi"]
        self.assertEqual((limit["requests"], limit["window"], limit["partitionBy"]),
                         (2000, {"seconds": 60, "kind": "unspecified"}, ["user"]))
        self.assertEqual({name: header["role"] for name, header in root["headers"].items()},
                         {"RateLimit-Limit": "limit", "RateLimit-Observed": "used", "RateLimit-Remaining": "remaining",
                          "RateLimit-Reset": "reset", "Retry-After": "retryAfter"})

    def test_429_waits_for_retry_after_or_the_reset(self):
        headers = {"RateLimit-Name": "throttle_authenticated_api", "RateLimit-Limit": "2000",
                   "RateLimit-Observed": "2001", "RateLimit-Remaining": "0",
                   "RateLimit-Reset": str(NOW + 40), "RateLimit-ResetTime": "Tue, 05 Jan 2021 11:00:00 GMT",
                   "Retry-After": "30"}
        # The later of Retry-After and the reset of an exhausted bucket.
        self.assertEqual(throttling.classify(self.composed, 429, headers, None, NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 40})
        del headers["RateLimit-Reset"]
        self.assertEqual(throttling.classify(self.composed, 429, headers, None, NOW)["retryAt"], NOW + 30)

    def test_other_responses_are_not_throttling(self):
        headers = {"RateLimit-Limit": "2000", "RateLimit-Remaining": "1999", "RateLimit-Reset": str(NOW + 40)}
        for status in (200, 400, 401, 403, 404, 500):
            with self.subTest(status=status):
                self.assertIsNone(throttling.classify(self.composed, status, headers, None, NOW))

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
