"""Check the plan-tier throttling overlays (Throttling 0.5.0 `tiers`) against their pinned OADs.

Asana throttling-v2, Notion throttling-v3 and Clockify's first throttling
overlay are each composed with their pinned OAD and must pass the throttling
validator and add only x-throttling; their tiers must be the documented
numbers, a consumer without a configured plan must keep within every tier, and each revision must keep what its earlier revision declared. No
dated catalog selects them. No provider is called. Use --directory for a
full-history openapi-directory checkout; otherwise the full-SHA source URLs
are downloaded.
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
ASANA = "APIs/asana.com/1.0/"
NOTION = "APIs/notion.com/2026-03-11/"
CLOCKIFY = "APIs/clockify.me/1.0.0-readonly/"
OVERLAYS = {
    "asana": ASANA + "throttling-v2-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml",
    "notion": NOTION + "throttling-v3-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml",
    "clockify": CLOCKIFY + "throttling-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml",
}
EARLIER = {
    "asana": ASANA + "throttling-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml",
    "notion": NOTION + "throttling-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml",
}


def root_of(path):
    return yaml.safe_load((ROOT / path).read_text())["actions"][0]["update"]["x-throttling"]


def tiers(limit):
    return {tuple(t["plans"]): (t["requests"], t["window"]["seconds"]) for t in limit["tiers"]}


def pairs(entries):
    return sorted((e["requests"], e["window"]["seconds"]) for e in entries)


class PlanTierOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.documents = {}
        with tempfile.TemporaryDirectory() as cache:
            for name, path in OVERLAYS.items():
                url, sha, source = overlay_pin(ROOT / path)
                if name in EARLIER:
                    assert overlay_pin(ROOT / EARLIER[name])[0] == url
                if DIRECTORY:
                    raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
                else:
                    raw, _ = fetch(url, Path(cache))
                original = yaml.safe_load(raw)
                composed = copy.deepcopy(original)
                apply(composed, yaml.safe_load((ROOT / path).read_text()))
                cls.documents[name] = (original, composed)

    def test_valid_and_only_x_throttling(self):
        for name, (original, composed) in self.documents.items():
            with self.subTest(provider=name):
                throttling.validate(composed)
                standard = copy.deepcopy(composed)
                standard.pop("x-throttling")
                for item in standard["paths"].values():
                    for operation in item.values():
                        if isinstance(operation, dict):
                            operation.pop("x-throttling", None)
                self.assertEqual(standard, original)

    def test_documented_tiers_and_the_default(self):
        limits = {name: composed["x-throttling"]["limits"] for name, (_, composed) in self.documents.items()}
        self.assertEqual(tiers(limits["asana"]["perToken"]), {("Free",): (150, 60), ("Paid",): (1500, 60)})
        self.assertEqual(tiers(limits["notion"]["perConnection"]),
                         {("Business", "Enterprise"): (600, 60), ("All other plans",): (180, 60)})
        self.assertEqual(tiers(limits["clockify"]["perWorkspace"]), {("Free",): (30, 3600), ("Paid",): (50, 1)})
        # Without a plan, every tier at once.
        in_force = throttling.limits_in_force
        self.assertEqual(pairs(in_force(limits["asana"]["perToken"])), [(150, 60), (1500, 60)])
        self.assertEqual(pairs(in_force(limits["notion"]["perConnection"], "Plus")), [(180, 60), (600, 60)])
        self.assertEqual(pairs(in_force(limits["clockify"]["perWorkspace"])), [(30, 3600), (50, 1)])
        # With one, its tier; a plan no tier names (a trial) keeps within both.
        self.assertEqual(pairs(in_force(limits["clockify"]["perWorkspace"], "Paid")), [(50, 1)])
        self.assertEqual(pairs(in_force(limits["clockify"]["perWorkspace"], "TRIAL")), [(30, 3600), (50, 1)])
        self.assertEqual(pairs(in_force(limits["notion"]["perConnection"], "Enterprise")), [(600, 60)])
        self.assertEqual(pairs(in_force(limits["asana"]["perToken"], "Paid")), [(1500, 60)])

    def test_asana_v2_is_v1_with_tiers(self):
        v1, v2 = root_of(EARLIER["asana"]), root_of(OVERLAYS["asana"])
        old, new = v1["limits"].pop("perToken"), v2["limits"].pop("perToken")
        self.assertEqual(v1, v2)
        self.assertEqual((old["window"], old["partitionBy"]), (new["tiers"][0]["window"], new["partitionBy"]))
        self.assertNotIn("requests", old)
        selections = lambda p: [a for a in yaml.safe_load((ROOT / p).read_text())["actions"][1:]]
        self.assertEqual(selections(EARLIER["asana"]), selections(OVERLAYS["asana"]))

    def test_notion_v3_is_v1_plus_blocked_and_tiers(self):
        v1, v3 = root_of(EARLIER["notion"]), root_of(OVERLAYS["notion"])
        self.assertEqual(v1["headers"], v3["headers"])
        first, *rest = v3["signals"]
        self.assertEqual((first["meaning"], first["body"]["pointer"]), ("blocked", "/additional_data/rate_limit_reason"))
        strip = lambda signals: [{k: v for k, v in s.items() if k != "description"} for s in signals]
        self.assertEqual(strip(rest), strip(v1["signals"]))
        _, notion = self.documents["notion"]
        blocked = {"object": "error", "status": 429, "code": "rate_limited",
                   "additional_data": {"rate_limit_reason": "public_api_request_blocked"}}
        self.assertEqual(throttling.classify(notion, 429, {"Retry-After": "2"}, blocked, NOW)["meaning"], "blocked")
        limited = dict(blocked, additional_data={"rate_limit_reason": "public_api_request_rate_limit"})
        self.assertEqual(throttling.classify(notion, 429, {"Retry-After": "2"}, limited, NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 2})

    def test_clockify_declares_no_signal_or_header(self):
        _, clockify = self.documents["clockify"]
        self.assertEqual(set(clockify["x-throttling"]), {"limits", "applies"})
        self.assertEqual(clockify["x-throttling"]["applies"], ["perWorkspace"])
        # A 429 is still throttling by the extension's default, with the consumer's own backoff.
        self.assertEqual(throttling.classify(clockify, 429, {}, None, NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": None})

    def test_no_dated_catalog_selects_them(self):
        for path in OVERLAYS.values():
            name = path.rsplit("/", 1)[1]
            for catalog in (ROOT / "catalog").glob("*.json"):
                with self.subTest(overlay=name, catalog=catalog.name):
                    self.assertNotIn(name, catalog.read_text())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
