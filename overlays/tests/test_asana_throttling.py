"""Check the Asana API Throttling overlay against its exact source OAD.

The overlay is composed with its pinned OAD, alone and after the Asana
overlays of catalog/2026-10-12-box-pagination-v2.json. The result must pass
the throttling reference validator and change nothing but `x-throttling`,
the search limit must sit on the task search only, and a synthetic 429 in
Asana's documented form must classify with its Retry-After delay. No
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
OVERLAY = "APIs/asana.com/1.0/throttling-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml"
CATALOG = "2026-10-12-box-pagination-v2.json"
METHODS = ("get", "put", "post", "delete", "patch")


class AsanaThrottlingTests(unittest.TestCase):
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

    def test_composes_after_the_catalogued_asana_overlays(self):
        asana = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                     if p["name"] == "asana")
        document = copy.deepcopy(self.original)
        for url in asana["overlays"]:
            apply(document, yaml.safe_load((ROOT / url.split("/overlays/", 1)[1]).read_text(encoding="utf-8")))
        apply(document, self.overlay)
        throttling.validate(document)
        self.assertEqual(self.selections(document), self.selections(self.composed))

    def test_documented_limits(self):
        root = self.composed["x-throttling"]
        self.assertEqual(root["applies"], ["perToken"])
        self.assertNotIn("requests", root["limits"]["perToken"])
        self.assertEqual(root["limits"]["searchPerToken"]["requests"], 60)
        for limit in root["limits"].values():
            self.assertEqual((limit["window"], limit["partitionBy"]),
                             ({"seconds": 60, "kind": "unspecified"}, ["credential"]))
        self.assertEqual(self.selections(self.composed),
                         {("/workspaces/{workspace_gid}/tasks/search", "get"): ["perToken", "searchPerToken"]})

    def test_the_pinned_document_says_what_the_overlay_relies_on(self):
        raw = json.dumps(self.original)
        self.assertIn("You may receive a `429 Too Many Requests` response if you hit any of our", raw)
        self.assertIn("You have exceeded one of the enforced rate limits in the API.", raw)

    def test_429_with_retry_after(self):
        body = {"errors": [{"message": "You've made too many requests and hit a rate limit. Please retry after the given amount of time."}]}
        self.assertEqual(throttling.classify(self.composed, 429, {"Retry-After": "30"}, body, NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 30})
        self.assertIsNone(throttling.classify(self.composed, 429, {}, body, NOW)["retryAt"])
        for status in (400, 401, 402, 403, 404, 500):
            with self.subTest(status=status):
                self.assertIsNone(throttling.classify(self.composed, status, {"Retry-After": "30"}, None, NOW))

    def test_only_the_syncables_0_22_catalog_selects_the_overlay(self):
        # catalog/2026-10-12-syncables-0.22.json selects it last for asana.
        name = OVERLAY.rsplit("/", 1)[1]
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                text = catalog.read_text(encoding="utf-8")
                if catalog.name != "2026-10-12-syncables-0.22.json":
                    self.assertNotIn(name, text)
                    continue
                asana = next(p for p in json.loads(text)["platforms"] if p["name"] == "asana")
                self.assertEqual(asana["overlays"][-1].rsplit("/", 1)[1], name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
