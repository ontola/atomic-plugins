"""Box 2.0.0 pagination v3: offset lists advance by the limit (Pagination Schemes 0.7.0).

v3 is v2 plus `advance: pageSize` on the `boxOffset` offset field, as Box
documents the next offset (`previous_offset + previous_limit`). Composes
the pinned OAD with v3, validates it with the Pagination Schemes reference
validator, and reads a synthetic offset list with the reference
`read_offsets`: a short and an empty page before `total_count` do not end
the list. The Box platform of catalog/2026-10-12-tasks-box-pages.json
selects v3 (tests/test_google_tasks_empty_lists.py checks that catalog
against its base). No provider is called. Use --directory for an
openapi-directory checkout that has the pinned commit; otherwise the pinned
raw URL is downloaded.
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

ROOT = Path(__file__).resolve().parents[1]
PIN = "dec74da7a6785d5d5b83bc6a4cebc07336d67ec9"
SOURCE_PATH = "APIs/box.com/2.0.0/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
FOLDER = ROOT / "APIs/box.com/2.0.0"
V2 = f"pagination-v2-{PIN}-overlay.yaml"
V3 = f"pagination-v3-{PIN}-overlay.yaml"
PAGES = "https://ontola.github.io/atomic-plugins/overlays/APIs/box.com/2.0.0/"
CATALOG = "2026-10-12-tasks-box-pages.json"
DIRECTORY = None

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay  # noqa: E402

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "pagination-schemes"))
from validate import read_offsets, validate as validate_pagination  # noqa: E402


def load_source():
    if DIRECTORY:
        raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", f"{PIN}:{SOURCE_PATH}"])
    else:
        raw = urllib.request.urlopen(OAD, timeout=60).read()
    return yaml.safe_load(raw)


def compose(original, name):
    path = FOLDER / name
    document, errors = apply_overlay(copy.deepcopy(original), yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
    if errors:
        raise AssertionError("\n".join(errors))
    return document


class BoxPaginationV3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        original = load_source()
        cls.v2 = compose(original, V2)
        cls.v3 = compose(original, V3)

    def test_v3_is_v2_plus_advance_on_the_offset_field(self):
        v2 = yaml.safe_load((FOLDER / V2).read_text(encoding="utf-8"))
        v3 = yaml.safe_load((FOLDER / V3).read_text(encoding="utf-8"))
        offset = v2["actions"][0]["update"]["paginationSchemes"]["boxOffset"]
        offset["request"]["queryParameters"]["offset"]["advance"] = "pageSize"
        offset["description"] = v3["actions"][0]["update"]["paginationSchemes"]["boxOffset"]["description"]
        self.assertEqual(v3["actions"], v2["actions"])
        self.assertEqual(v3["extends"], v2["extends"])

    def test_the_composed_document_passes_the_validator(self):
        validate_pagination(self.v3)
        applied = {path for path, item in self.v3["paths"].items() if "x-pagination" in item.get("get", {})}
        self.assertEqual(len(applied), 41)

    def test_an_offset_list_steps_by_the_limit_to_total_count(self):
        scheme = self.v3["components"]["paginationSchemes"]["boxOffset"]

        def request(values):
            offset = values[("queryParameters", "offset")]
            # 10 entries; offsets 2-7 hold nothing this caller may see.
            entries = [{"id": str(i)} for i in range(offset, min(10, offset + 4)) if not 2 <= i <= 7]
            return {"entries": entries, "offset": offset, "limit": 4, "total_count": 10}

        result = read_offsets(scheme, request)
        self.assertEqual(result["offsets"], [0, 4, 8])
        self.assertEqual([e["id"] for e in result["items"]], ["0", "1", "8", "9"])

    def test_the_catalog_selects_v3_for_box(self):
        box = next(p for p in json.loads((ROOT / "catalog" / CATALOG).read_text(encoding="utf-8"))["platforms"]
                   if p["name"] == "box")
        self.assertEqual(box["overlays"], [PAGES + V3])
        # catalog/2026-10-12-syncables-0.22.json is built on this catalog and
        # keeps v3.
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            if catalog.name not in (CATALOG, "2026-10-12-syncables-0.22.json"):
                with self.subTest(catalog=catalog.name):
                    self.assertNotIn(V3, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
