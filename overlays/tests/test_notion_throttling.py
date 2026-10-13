"""Check the Notion Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD and, in either order, with the
auth, pagination and CRUD Causality overlays the dated catalogs select for it. The
result must pass the throttling validator and add only x-throttling, and
synthetic responses in Notion's documented error format must classify as the
overlay intends. No provider is called. Use --directory for a full-history
openapi-directory checkout; otherwise the full-SHA source URL is downloaded.
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

spec = importlib.util.spec_from_file_location(
    "throttling_validate", ROOT.parent / "openapi-extensions" / "spec" / "throttling" / "validate.py")
throttling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(throttling)

DIRECTORY = None
NOW = 1_800_000_000
NOTION = "APIs/notion.com/2026-03-11/"
OVERLAY = NOTION + "throttling-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"
# What the dated catalogs select for Notion (catalog/2026-10-11-box.json).
SIBLINGS = [NOTION + "auth-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml",
            NOTION + "pagination-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml",
            NOTION + "crud-causality-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"]


def error(code, reason=None):
    body = {"object": "error", "status": 429, "code": code, "message": "x"}
    if reason:
        body["additional_data"] = {"rate_limit_reason": reason}
    return body


class NotionThrottlingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAY)
        for sibling in SIBLINGS:
            assert overlay_pin(ROOT / sibling)[0] == url
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.composed = copy.deepcopy(cls.original)
        apply(cls.composed, yaml.safe_load((ROOT / OVERLAY).read_text()))

    def classify(self, status, headers, body):
        return throttling.classify(self.composed, status, headers, body, NOW)

    def test_composition_is_valid_and_adds_only_x_throttling(self):
        throttling.validate(self.composed)
        standard = copy.deepcopy(self.composed)
        standard.pop("x-throttling")
        self.assertEqual(standard, self.original)
        self.assertNotIn("limits", self.composed["x-throttling"])

    def test_composes_with_the_catalogued_overlays_in_either_order(self):
        overlay = yaml.safe_load((ROOT / OVERLAY).read_text())
        siblings = [yaml.safe_load((ROOT / s).read_text()) for s in SIBLINGS]
        first, second = copy.deepcopy(self.original), copy.deepcopy(self.original)
        for s in siblings:
            apply(first, s)
        apply(first, overlay)
        apply(second, overlay)
        for s in siblings:
            apply(second, s)
        self.assertEqual(first, second)
        throttling.validate(first)

    def test_documented_429(self):
        for reason in (None, "public_api_request_rate_limit", "public_api_space_request_rate_limit"):
            with self.subTest(reason=reason):
                self.assertEqual(self.classify(429, {"Retry-After": "2"}, error("rate_limited", reason)),
                                 {"meaning": "throttled", "bucket": None, "retryAt": NOW + 2})
        # Without Retry-After the consumer's own backoff applies; an HTTP date is not the documented unit.
        self.assertIsNone(self.classify(429, {}, error("rate_limited"))["retryAt"])
        self.assertIsNone(self.classify(429, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"},
                                        error("rate_limited"))["retryAt"])
        # The known gap: a blocked request is a 429 as well, so it classifies as throttled.
        self.assertEqual(self.classify(429, {}, error("rate_limited", "public_api_request_blocked"))["meaning"],
                         "throttled")

    def test_other_errors_are_not_throttling(self):
        body = {"object": "error", "status": 503, "code": "service_unavailable", "additional_data": {}}
        self.assertIsNone(self.classify(503, {"Retry-After": "5"}, body))
        self.assertIsNone(self.classify(400, {}, {"object": "error", "status": 400, "code": "rate_limited"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
