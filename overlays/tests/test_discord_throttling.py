"""Check the Discord API v10 Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD, alone and after the Discord
overlays of catalog/2026-10-12-box-pagination-v2.json. The result must pass
the throttling reference validator and change nothing but `x-throttling`,
the declared headers must be ones the pinned OAD declares, and synthetic
responses in Discord's documented form must classify as the overlay
intends, fractions included. No provider is called. Use --directory for a
full-history openapi-directory checkout; otherwise the full-SHA source URL
is downloaded.
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
OVERLAY = "APIs/discord.com/10/throttling-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"


def limited(retry_after):
    return {"message": "You are being rate limited.", "retry_after": retry_after, "global": False}


class DiscordThrottlingTests(unittest.TestCase):
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

    def test_composes_after_the_catalogued_discord_overlays(self):
        discord = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                       if p["name"] == "discord")
        document = copy.deepcopy(self.original)
        for url in discord["overlays"]:
            apply(document, yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8")))
        apply(document, self.overlay)
        throttling.validate(document)
        self.assertEqual(document["x-throttling"], self.composed["x-throttling"])

    def test_the_rate_limit_headers_are_the_pinned_documents(self):
        declared = self.original["components"]["headers"]
        for name in ("X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset-After"):
            with self.subTest(header=name):
                self.assertIn(name, declared)
                self.assertIn(name, self.composed["x-throttling"]["headers"])
        self.assertEqual(declared["X-RateLimit-Reset-After"]["schema"], {"type": "number"})
        retry_after = self.original["components"]["schemas"]["RatelimitedResponse"]["allOf"][1]["properties"]["retry_after"]
        self.assertEqual(retry_after["type"], "number")
        self.assertNotIn("limits", self.composed["x-throttling"])

    def test_429_waits_for_retry_after(self):
        self.assertEqual(throttling.classify(self.composed, 429, {"Retry-After": "65"}, limited(65), NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 65})
        # The page's own example: a fraction does not parse in whole seconds,
        # so the header decides.
        self.assertEqual(throttling.classify(self.composed, 429, {"Retry-After": "65"}, limited(64.57), NOW)["retryAt"],
                         NOW + 65)
        self.assertIsNone(throttling.classify(self.composed, 429, {}, limited(64.57), NOW)["retryAt"])

    def test_an_exhausted_bucket_waits_for_its_reset(self):
        headers = {"X-RateLimit-Limit": "5", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "2",
                   "X-RateLimit-Bucket": "abcd1234"}
        self.assertEqual(throttling.classify(self.composed, 429, headers, limited(2), NOW)["retryAt"], NOW + 2)
        headers["X-RateLimit-Reset-After"] = "1.337"
        self.assertEqual(throttling.classify(self.composed, 429, headers, limited(2), NOW)["retryAt"], NOW + 2)

    def test_other_errors_are_not_throttling(self):
        for status in (400, 401, 403, 404, 500, 502):
            with self.subTest(status=status):
                self.assertIsNone(throttling.classify(self.composed, status, {"X-RateLimit-Remaining": "0"},
                                                      {"message": "x", "code": 0}, NOW))

    def test_only_the_syncables_0_22_catalog_selects_the_overlay(self):
        # catalog/2026-10-12-syncables-0.22.json selects it last for discord.
        name = OVERLAY.rsplit("/", 1)[1]
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                text = catalog.read_text(encoding="utf-8")
                if catalog.name != "2026-10-12-syncables-0.22.json":
                    self.assertNotIn(name, text)
                    continue
                entry = next(p for p in json.loads(text)["platforms"] if p["name"] == "discord")
                self.assertEqual(entry["overlays"][-1].rsplit("/", 1)[1], name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
