"""Check the Google Calendar v3 Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD, alone and after the Calendar
overlays the newest dated catalog selects. The result must pass the
throttling reference validator and change nothing but `x-throttling`, the
documented default quotas must be declared with their partitions, and
synthetic error responses in the shape Google's Calendar error guide shows
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
OVERLAY = "APIs/googleapis.com/calendar/v3/throttling-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"


def google_error(code, reason, domain="usageLimits"):
    return {"error": {"code": code, "message": reason,
                      "errors": [{"domain": domain, "reason": reason, "message": reason}]}}


class CalendarThrottlingTests(unittest.TestCase):
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

    def test_composes_after_the_catalogued_calendar_overlays(self):
        calendar = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                        if p["name"] == "google-calendar")
        self.assertTrue(calendar["openapi"].endswith("/32237fa5d14aa887dc9f3923395dac971e00a36c/APIs/googleapis.com/calendar/v3/openapi.yaml"))
        document = copy.deepcopy(self.original)
        for url in calendar["overlays"]:
            apply(document, yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8")))
        apply(document, self.overlay)
        throttling.validate(document)
        self.assertEqual(document["x-throttling"], self.composed["x-throttling"])

    def test_documented_default_quotas(self):
        root = self.composed["x-throttling"]
        self.assertEqual(root["applies"], ["perProject", "perUser"])
        self.assertEqual(
            {name: (limit["requests"], limit["window"], limit["partitionBy"]) for name, limit in root["limits"].items()},
            {"perProject": (10000, {"seconds": 60, "kind": "unspecified"}, ["application"]),
             "perUser": (600, {"seconds": 60, "kind": "unspecified"}, ["application", "user"])})
        self.assertNotIn("headers", root)

    def test_rate_limit_errors_are_throttled(self):
        for status, reason in ((403, "userRateLimitExceeded"), (403, "rateLimitExceeded"), (429, "rateLimitExceeded")):
            with self.subTest(status=status, reason=reason):
                self.assertEqual(throttling.classify(self.composed, status, {}, google_error(status, reason), NOW),
                                 {"meaning": "throttled", "bucket": None, "retryAt": None})

    def test_other_errors_are_not_throttling(self):
        for status, reason, domain in ((403, "quotaExceeded", "usageLimits"),
                                       (403, "forbiddenForNonOrganizer", "calendar"),
                                       (412, "conditionNotMet", "global"),
                                       (500, "backendError", "global")):
            with self.subTest(status=status, reason=reason):
                self.assertIsNone(throttling.classify(self.composed, status, {}, google_error(status, reason, domain), NOW))
        # A 403 with no JSON body is not throttling either.
        self.assertIsNone(throttling.classify(self.composed, 403, {}, None, NOW))

    def test_no_dated_catalog_selects_the_overlay(self):
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
