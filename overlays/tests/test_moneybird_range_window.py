"""Moneybird's financial mutations as a Pagination Schemes 0.5.0 rangeWindow.

Composes the pinned read-only OAD with the published Moneybird overlays, in
the order the dated catalogs list them, and then the unpublished
pagination-range-window overlay. Checks that the result is a valid OpenAPI
document, that the Pagination Schemes reference validator accepts it, and
that the reference read_range splits windows as the Money app's reader does
(integrations/money/moneybird/read.ts). No provider requests are made.

Use --directory for an openapi-directory checkout that has the pinned
commit (a blobless clone is enough); otherwise the pinned raw URL is
downloaded.
"""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
import urllib.request

import yaml
from openapi_spec_validator import validate as validate_openapi

ROOT = Path(__file__).resolve().parents[1]
PIN = "85a6105220036a98ef0d7cd6f228d4aae0036508"
SOURCE_PATH = "APIs/moneybird.com/v2-readonly/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
FOLDER = ROOT / "APIs/moneybird.com/v2-readonly"
PUBLISHED = ("auth", "pagination", "crud-causality", "throttling")
OVERLAY = f"pagination-range-window-{PIN}-overlay.yaml"
MUTATIONS = "/{administration_id}/financial_mutations.json"
DIRECTORY = None

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay  # noqa: E402

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "pagination-schemes"))
from validate import WindowReadError, read_range, validate as validate_pagination  # noqa: E402


def load_source():
    if DIRECTORY:
        raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", f"{PIN}:{SOURCE_PATH}"])
    else:
        raw = urllib.request.urlopen(OAD, timeout=30).read()
    return yaml.safe_load(raw)


def compose():
    original = load_source()
    document = copy.deepcopy(original)
    for name in [f"{kind}-{PIN}-overlay.yaml" for kind in PUBLISHED] + [OVERLAY]:
        path = FOLDER / name
        document, errors = apply_overlay(document, yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
        if errors:
            raise AssertionError("\n".join(errors))
    return original, document


class MoneybirdRangeWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original, cls.document = compose()
        cls.scheme = cls.document["components"]["paginationSchemes"]["periodWindows"]

    def test_composed_document_is_valid_openapi_and_pagination_schemes(self):
        validate_pagination(self.document)
        standard = copy.deepcopy(self.document)
        for key in ("paginationSchemes", "crudResources"):
            standard["components"].pop(key, None)
        validate_openapi(standard)

    def test_only_the_mutations_list_gets_the_scheme(self):
        applied = {
            path for path, item in self.document["paths"].items()
            if any(a.get("scheme") == "periodWindows" for a in item.get("get", {}).get("x-pagination", []))
        }
        self.assertEqual(applied, {MUTATIONS})
        self.assertEqual(self.document["paths"][MUTATIONS]["get"]["x-pagination"], [{"scheme": "periodWindows"}])
        # The pageNumber scheme of the published pagination overlay is unchanged.
        self.assertEqual(self.document["components"]["paginationSchemes"]["pageNumber"]["type"], "pageNumber")

    def test_the_pinned_document_still_says_what_the_overlay_relies_on(self):
        operation = self.original["paths"][MUTATIONS]["get"]
        self.assertIn("Limited to 100 financial mutations", operation["description"])
        names = {p.get("name") for p in operation["parameters"]}
        self.assertNotIn("page", names)
        self.assertNotIn("per_page", names)
        described = next(p for p in operation["parameters"] if p.get("name") == "filter")["description"]
        self.assertIn("20130101..20130131", described)
        self.assertIn("replaces the defaults below entirely", described)

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))

    def provider(self, dates):
        """A synthetic list that answers at most 100 mutations of a closed period."""
        calls = []

        def request(values):
            value = values[("queryParameters", "filter")]
            calls.append(value)
            low, high = value.removeprefix("period:").split("..")
            return [{"id": str(i), "date": d} for i, d in enumerate(dates) if low <= d <= high][:100]

        return request, calls

    def test_windows_split_like_the_money_app(self):
        # read.ts halves 20260101..20261231 into ..20260702 and 20260703..
        dates = [f"2026{m:02d}15" for m in range(1, 13) for _ in range(20)]  # 240 mutations
        request, calls = self.provider(dates)
        result = read_range(self.scheme, "20260101", "20261231", request)
        self.assertEqual(len(result["items"]), 240)
        # Depth first, first half first, as read.ts awaits read(split[0]) before read(split[1]).
        self.assertEqual(calls, ["period:20260101..20261231", "period:20260101..20260702",
                                 "period:20260101..20260402", "period:20260403..20260702",
                                 "period:20260703..20261231", "period:20260703..20261001",
                                 "period:20261002..20261231"])

    def test_a_full_day_is_not_a_complete_read(self):
        request, _ = self.provider(["20260415"] * 100)
        with self.assertRaises(WindowReadError):
            read_range(self.scheme, "20260101", "20261231", request)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
