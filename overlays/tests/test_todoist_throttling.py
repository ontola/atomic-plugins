"""Check the Todoist Throttling 0.3.0-draft overlay against its exact source OAD.

The overlay is composed with its pinned OAD, the result must pass the
throttling validator, and synthetic error bodies in Todoist's documented
format must classify as the overlay intends. No provider is called. Use
--directory for a full-history openapi-directory checkout; otherwise the
full-SHA source URL is downloaded.
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
OVERLAY = "APIs/todoist.com/1/throttling-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml"


class TodoistThrottlingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAY)
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.composed = copy.deepcopy(cls.original)
        apply(cls.composed, yaml.safe_load((ROOT / OVERLAY).read_text()))

    def classify(self, status, body):
        return throttling.classify(self.composed, status, {}, body, NOW)

    def test_composition_is_valid_and_adds_only_x_throttling(self):
        throttling.validate(self.composed)
        standard = copy.deepcopy(self.composed)
        standard.pop("x-throttling")
        original = copy.deepcopy(self.original)
        original.pop("x-throttling", None)
        self.assertEqual(standard, original)
        self.assertNotIn("limits", self.composed["x-throttling"])

    def test_429_with_documented_error_body(self):
        body = {"error": "Too many requests", "error_code": 429, "error_tag": "TOO_MANY_REQUESTS", "http_code": 429,
                "error_extra": {"retry_after": 3, "event_id": "x"}}
        self.assertEqual(self.classify(429, body), {"meaning": "throttled", "bucket": None, "retryAt": NOW + 3})
        body["error_extra"].pop("retry_after")
        self.assertEqual(self.classify(429, body)["retryAt"], None)  # the consumer's own backoff
        body["error_extra"]["retry_after"] = 0
        self.assertEqual(self.classify(429, body)["retryAt"], None)  # a zero body wait counts as absent

    def test_retry_after_on_other_errors_is_not_throttling(self):
        # The documented 404 example carries retry_after too; it is not a rate limit.
        body = {"error": "Task not found", "error_code": 478, "error_extra": {"event_id": "x", "retry_after": 3},
                "error_tag": "NOT_FOUND", "http_code": 404}
        self.assertIsNone(self.classify(404, body))
        self.assertIsNone(self.classify(403, body))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
