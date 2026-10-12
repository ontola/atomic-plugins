"""Check the Airtable Web API Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD, alone and after the Airtable
overlays of catalog/2026-10-12-box-pagination-v2.json. The result must pass
the throttling reference validator and change nothing but `x-throttling`,
the per-base limit must sit on the operations that address a base, and a
synthetic 429 must classify with Airtable's documented 30-second wait. No
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
OVERLAY = "APIs/airtable.com/1.0-readonly/throttling-1f5368e0251bfbaa233860dc8131507c38a4f8b3-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"
METHODS = ("get", "put", "post", "delete", "patch")


class AirtableThrottlingTests(unittest.TestCase):
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

    def selections(self, document):
        return {
            (path, method): operation["x-throttling"]
            for path, item in document["paths"].items()
            for method, operation in item.items()
            if method in METHODS and isinstance(operation, dict) and "x-throttling" in operation
        }

    def test_composition_is_valid_and_adds_only_x_throttling(self):
        throttling.validate(self.composed)
        standard = copy.deepcopy(self.composed)
        standard.pop("x-throttling")
        for path, method in self.selections(standard):
            standard["paths"][path][method].pop("x-throttling")
        self.assertEqual(standard, self.original)

    def test_composes_after_the_catalogued_airtable_overlays(self):
        airtable = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                        if p["name"] == "airtable")
        document = copy.deepcopy(self.original)
        for url in airtable["overlays"]:
            apply(document, yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8")))
        apply(document, self.overlay)
        throttling.validate(document)
        self.assertEqual(self.selections(document), self.selections(self.composed))

    def test_the_per_base_limit_sits_on_every_operation_that_addresses_a_base(self):
        root = self.composed["x-throttling"]
        self.assertEqual(root["applies"], [])
        self.assertEqual(list(root["limits"]), ["perBase"])
        self.assertEqual(root["limits"]["perBase"]["requests"], 5)
        self.assertEqual(root["limits"]["perBase"]["window"], {"seconds": 1, "kind": "unspecified"})
        addressed = {(path, "get") for path in self.original["paths"] if "{baseId}" in path}
        self.assertEqual(self.selections(self.composed), {key: ["perBase"] for key in addressed})
        self.assertNotIn(("/v0/meta/bases", "get"), self.selections(self.composed))

    def test_429_waits_30_seconds(self):
        body = {"errors": [{"error": "invented"}]}  # the page shows no 429 body
        self.assertEqual(throttling.classify(self.composed, 429, {}, body, NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 30})
        # No Retry-After is declared, so a header does not change the wait.
        self.assertEqual(throttling.classify(self.composed, 429, {"Retry-After": "5"}, None, NOW)["retryAt"], NOW + 30)
        for status in (401, 403, 404, 422, 503):
            with self.subTest(status=status):
                self.assertIsNone(throttling.classify(self.composed, status, {}, None, NOW))

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
