"""Check the Throttling 0.2.0-draft overlays against their exact source OADs.

Each overlay is applied to its pinned OAD, the composed document must pass the
throttling reference validator, and synthetic responses shaped as the
provider documents them must classify as the overlay intends. No provider is
called. Use --directory for a full-history openapi-directory checkout;
otherwise the full-SHA source URLs are downloaded.
"""
import argparse
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT, apply, fetch

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "throttling"))
from validate import classify, validate as validate_throttling

DIRECTORY = None
NOW = 1_800_000_000
OVERLAYS = {
    "github": "APIs/github.com/api.github.com.2022-11-28/1.1.4/throttling-7782419eb8c981c9dd28379e41a43ca3186f4758-overlay.yaml",
    "google_tasks": "APIs/googleapis.com/tasks/v1/throttling-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml",
    "moneybird": "APIs/moneybird.com/v2-readonly/throttling-v2-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml",
    "github_issues": "APIs/github.com/github-issues/1.1.4/throttling-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml",
}


class ThrottlingOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.documents = {}
        with tempfile.TemporaryDirectory() as cache:
            for name, relative in OVERLAYS.items():
                path = ROOT / relative
                url, sha, source = overlay_pin(path)
                if DIRECTORY:
                    raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
                else:
                    raw, _ = fetch(url, Path(cache))
                original = yaml.safe_load(raw)
                composed = copy.deepcopy(original)
                apply(composed, yaml.safe_load(path.read_text()))
                cls.documents[name] = (original, composed)

    def test_composed_documents_pass_the_validator_and_change_only_x_throttling(self):
        for name, (original, composed) in self.documents.items():
            with self.subTest(provider=name):
                validate_throttling(composed)
                standard = copy.deepcopy(composed)
                standard.pop("x-throttling")
                original = copy.deepcopy(original)
                original.pop("x-throttling", None)
                self.assertEqual(standard, original)

    def classify(self, name, status, headers=None, body=None):
        return classify(self.documents[name][1], status, headers or {}, body, NOW)

    def test_github_primary_secondary_and_permission_responses(self):
        primary = self.classify("github", 403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(NOW + 1800),
                                                "x-ratelimit-resource": "core"})
        self.assertEqual(primary, {"meaning": "quotaExhausted", "bucket": None, "retryAt": NOW + 1800})
        with_header = self.classify("github", 429, {"x-ratelimit-remaining": "12", "retry-after": "30"})
        self.assertEqual(with_header, {"meaning": "throttled", "bucket": None, "retryAt": NOW + 30})
        message = {"message": "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}
        self.assertEqual(self.classify("github", 403, {"x-ratelimit-remaining": "12"}, message)["retryAt"], NOW + 60)
        permission = {"message": "Resource not accessible by integration"}
        self.assertIsNone(self.classify("github", 403, {"x-ratelimit-remaining": "4990"}, permission))

    def test_github_issues_declares_the_same_as_the_versioned_rest_overlay(self):
        # Same REST API, same limits: the github-issues subset (the issue-tracker app's platform) declares the same.
        self.assertEqual(self.documents["github_issues"][1]["x-throttling"], self.documents["github"][1]["x-throttling"])
        primary = self.classify("github_issues", 429, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(NOW + 60)})
        self.assertEqual(primary, {"meaning": "quotaExhausted", "bucket": None, "retryAt": NOW + 60})
        app = (ROOT.parent / "integrations/issue-tracker/app/rateLimit.ts").read_text()
        self.assertIn("secondary rate limit", app)

    def test_google_tasks_reasons_and_other_403s(self):
        for status in (403, 429):
            for reason in ("rateLimitExceeded", "userRateLimitExceeded"):
                body = {"error": {"errors": [{"domain": "usageLimits", "reason": reason, "message": "Rate Limit Exceeded"}],
                                  "code": status, "message": "Rate Limit Exceeded"}}
                with self.subTest(status=status, reason=reason):
                    self.assertEqual(self.classify("google_tasks", status, body=body),
                                     {"meaning": "throttled", "bucket": None, "retryAt": None})
        forbidden = {"error": {"errors": [{"domain": "global", "reason": "insufficientPermissions"}], "code": 403}}
        self.assertIsNone(self.classify("google_tasks", 403, body=forbidden))

    def test_moneybird_429_exhausts_the_source_ip_bucket(self):
        result = self.classify("moneybird", 429, {"Retry-After": "42", "RateLimit-Remaining": "42"})
        self.assertEqual(result, {"meaning": "quotaExhausted", "bucket": "apiRequests", "retryAt": NOW + 42})
        self.assertEqual(set(self.documents["moneybird"][1]["x-throttling"]["headers"]), {"Retry-After"})
        # Without Retry-After, the 300-second window is the floor.
        self.assertEqual(self.classify("moneybird", 429)["retryAt"], NOW + 300)
        # The bucket is only unambiguous while the pinned OAD has no /reports/ endpoints.
        self.assertFalse(any("/reports" in path for path in self.documents["moneybird"][0]["paths"]))
        self.assertIsNone(self.classify("moneybird", 403, {"Retry-After": "42"}))
        # v2 keeps v1's announced limits exactly.
        v1 = yaml.safe_load((ROOT / "APIs/moneybird.com/v2-readonly/throttling-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml").read_text())
        v1_root = v1["actions"][0]["update"]["x-throttling"]
        composed = self.documents["moneybird"][1]["x-throttling"]
        self.assertEqual((composed["limits"], composed["applies"]), (v1_root["limits"], v1_root["applies"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
