"""Check the Box Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD and, in the other order too, with
each Box pagination overlay a dated catalog selects (v3 in the newest). The result must pass the
throttling validator, each documented limit must sit on the operations it
names, and a synthetic 429 in Box's documented form must classify with its
retry-after delay. No provider is called. Use --directory for a full-history
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
BOX = "APIs/box.com/2.0.0/"
OVERLAY = BOX + "throttling-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml"
# v3 is what the newest catalog selects (catalog/2026-10-12-tasks-box-pages.json); v2
# (catalog/2026-10-12-box-pagination-v2.json) and v1 are checked too.
PAGINATIONS = [BOX + "pagination-v3-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml",
               BOX + "pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml",
               BOX + "pagination-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml"]
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


class BoxThrottlingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / OVERLAY)
        for pagination in PAGINATIONS:
            assert overlay_pin(ROOT / pagination)[0] == url
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.composed = copy.deepcopy(cls.original)
        apply(cls.composed, yaml.safe_load((ROOT / OVERLAY).read_text()))

    def selections(self, document):
        found = {}
        for path, item in document["paths"].items():
            for method in METHODS:
                operation = item.get(method)
                if isinstance(operation, dict) and "x-throttling" in operation:
                    found[(path, method)] = operation["x-throttling"]
        return found

    def test_composition_is_valid_and_adds_only_x_throttling(self):
        throttling.validate(self.composed)
        standard = copy.deepcopy(self.composed)
        standard.pop("x-throttling")
        for operation in self.selections(standard):
            standard["paths"][operation[0]][operation[1]].pop("x-throttling")
        self.assertEqual(standard, self.original)

    def test_composes_with_the_catalogued_pagination_overlay_in_either_order(self):
        overlay = yaml.safe_load((ROOT / OVERLAY).read_text())
        for name in PAGINATIONS:
            with self.subTest(pagination=name):
                pagination = yaml.safe_load((ROOT / name).read_text())
                first, second = copy.deepcopy(self.original), copy.deepcopy(self.original)
                apply(first, pagination)
                apply(first, overlay)
                apply(second, overlay)
                apply(second, pagination)
                self.assertEqual(first, second)
                throttling.validate(first)
                # Pagination stays as the pagination overlay alone makes it.
                alone = copy.deepcopy(self.original)
                apply(alone, pagination)
                self.assertEqual(first["components"].get("paginationSchemes"), alone["components"].get("paginationSchemes"))
                for path, item in alone["paths"].items():
                    for method, operation in item.items():
                        if isinstance(operation, dict) and "x-pagination" in operation:
                            self.assertEqual(first["paths"][path][method]["x-pagination"], operation["x-pagination"])

    def test_documented_limits_sit_on_their_operations(self):
        root = self.composed["x-throttling"]
        self.assertEqual(root["applies"], ["perUser"])
        counts = {name: (limit["requests"], limit["window"]["seconds"], limit["partitionBy"])
                  for name, limit in root["limits"].items()}
        self.assertEqual(counts, {
            "perUser": (1000, 60, ["user"]),
            "uploadsPerUser": (240, 60, ["user"]),
            "searchesPerUserSecond": (6, 1, ["user"]),
            "searchesPerUserMinute": (60, 60, ["user"]),
            "searchesPerEnterprise": (12, 1, ["account"]),
            "signWritesPerUser": (100, 60, ["user"]),
            "signReadsPerUser": (1000, 60, ["user"]),
        })
        self.assertTrue(all(limit["window"]["kind"] == "unspecified" for limit in root["limits"].values()))
        self.assertEqual(self.selections(self.composed), {
            ("/files/content", "post"): ["perUser", "uploadsPerUser"],
            ("/files/{file_id}/content", "post"): ["perUser", "uploadsPerUser"],
            ("/search", "get"): ["perUser", "searchesPerUserSecond", "searchesPerUserMinute", "searchesPerEnterprise"],
            ("/sign_requests", "post"): ["perUser", "signWritesPerUser"],
            ("/sign_requests/{sign_request_id}/resend", "post"): ["perUser", "signWritesPerUser"],
            ("/sign_requests", "get"): ["perUser", "signReadsPerUser"],
            ("/sign_requests/{sign_request_id}", "get"): ["perUser", "signReadsPerUser"],
        })
        # Every selection keeps the general per-user bucket (see the overlay's header).
        self.assertTrue(all(s[0] == "perUser" for s in self.selections(self.composed).values()))

    def test_429_with_retry_after(self):
        body = {"type": "error", "status": 429, "code": "rate_limit_exceeded",
                "message": "Request rate limit exceeded, please try again later"}
        self.assertEqual(throttling.classify(self.composed, 429, {"Retry-After": "100"}, body, NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 100})
        self.assertEqual(throttling.classify(self.composed, 429, {}, body, NOW)["retryAt"], None)
        # An HTTP date is not Box's documented unit, so it is ignored.
        self.assertEqual(throttling.classify(self.composed, 429, {"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"},
                                             body, NOW)["retryAt"], None)
        # Other statuses are not throttling: no signals are declared beyond the 429 default.
        self.assertIsNone(throttling.classify(self.composed, 503, {"retry-after": "5"}, None, NOW))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
