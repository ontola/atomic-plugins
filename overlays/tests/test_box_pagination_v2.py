"""Box 2.0.0 pagination v2 and the catalog that selects it.

The published v1 Box pagination overlay declares `type: offset` and the
roles `currentOffset` and `pageTokenMode`, which Pagination Schemes does not
define, so its composition fails the reference validator. v2 declares
offset lists as pageNumber schemes with the `offset` role and marker lists
as pageToken schemes, applied to each list operation explicitly.

Composes the pinned OAD with each revision and checks the v2 result with
the Pagination Schemes reference validator; checks
catalog/2026-10-12-box-pagination-v2.json against
catalog/2026-10-11-gitlab-box.json (only the Box overlay differs) and
validates the Box platform composed from the new catalog. No provider is
called. Use --directory for an openapi-directory checkout that has the
pinned commit (a blobless clone is enough); otherwise the pinned raw URL is
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

ROOT = Path(__file__).resolve().parents[1]
PIN = "dec74da7a6785d5d5b83bc6a4cebc07336d67ec9"
SOURCE_PATH = "APIs/box.com/2.0.0/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
FOLDER = ROOT / "APIs/box.com/2.0.0"
V1 = f"pagination-{PIN}-overlay.yaml"
V2 = f"pagination-v2-{PIN}-overlay.yaml"
PAGES = "https://ontola.github.io/atomic-plugins/overlays/APIs/box.com/2.0.0/"
CATALOG = "2026-10-12-box-pagination-v2.json"
BASE = "2026-10-11-gitlab-box.json"
DIRECTORY = None

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay  # noqa: E402

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "pagination-schemes"))
from validate import validate as validate_pagination  # noqa: E402


def load_source():
    if DIRECTORY:
        raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", f"{PIN}:{SOURCE_PATH}"])
    else:
        raw = urllib.request.urlopen(OAD, timeout=60).read()
    return yaml.safe_load(raw)


def compose(original, names):
    document = copy.deepcopy(original)
    for name in names:
        path = FOLDER / name
        document, errors = apply_overlay(document, yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
        if errors:
            raise AssertionError("\n".join(errors))
    return document


def platforms(name):
    return json.loads((ROOT / "catalog" / name).read_text(encoding="utf-8"))["platforms"]


def parameters(document, path):
    item = document["paths"][path]
    found = set()
    for parameter in item.get("parameters", []) + item["get"].get("parameters", []):
        while "$ref" in parameter:
            node = document
            for part in parameter["$ref"][2:].split("/"):
                node = node[part]
            parameter = node
        found.add(parameter["name"])
    return found


class BoxPaginationV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = load_source()
        cls.v2 = compose(cls.original, [V2])

    def test_v1_fails_the_validator_and_v2_passes(self):
        with self.assertRaises(ValueError) as refused:
            validate_pagination(compose(self.original, [V1]))
        for word in ("currentOffset", "pageTokenMode", "'offset' is not one of"):
            self.assertIn(word, str(refused.exception))
        validate_pagination(self.v2)

    def test_each_application_matches_the_operation_parameters(self):
        applied = {
            path: item["get"]["x-pagination"][0]["scheme"]
            for path, item in self.v2["paths"].items()
            if "x-pagination" in item.get("get", {})
        }
        self.assertEqual(len(applied), 41)
        self.assertNotIn("/events", applied)
        self.assertNotIn("/search", applied)
        schemes = self.v2["components"]["paginationSchemes"]
        for path, scheme in applied.items():
            with self.subTest(path=path):
                names = parameters(self.v2, path)
                declared = set(schemes[scheme]["request"]["queryParameters"])
                self.assertLessEqual(declared, names)
                if "usemarker" in names:
                    # Marker paging there needs usemarker=true; read by offset.
                    self.assertEqual(scheme, "boxOffset")
        self.assertEqual(applied["/files/{file_id}/collaborations"], "boxMarker")
        self.assertEqual(applied["/folders/{folder_id}/items"], "boxOffset")

    def test_each_application_is_the_scheme_its_parameters_call_for(self):
        # Every operation: a marker list without usemarker pages by marker
        # (with or without limit), every other list by offset; one application each.
        for path, item in self.v2["paths"].items():
            if "x-pagination" not in item.get("get", {}):
                continue
            names = parameters(self.v2, path)
            if "marker" in names and "usemarker" not in names:
                expected = "boxMarker" if "limit" in names else "boxMarkerNoLimit"
            else:
                expected = "boxOffset"
                self.assertLessEqual({"offset", "limit"}, names, path)
            with self.subTest(path=path):
                self.assertEqual(item["get"]["x-pagination"], [{"scheme": expected}])

    def test_the_three_schemes_are_exact(self):
        schemes = copy.deepcopy(self.v2["components"]["paginationSchemes"])
        for scheme in schemes.values():
            self.assertTrue(scheme.pop("description"))
        marker = lambda query: {"type": "pageToken", "autoDetect": False,
                                "request": {"queryParameters": query},
                                "response": {"envelope": {"itemsField": "entries"},
                                             "bodyFields": {"next_marker": {"role": "nextCursor"}}}}
        self.assertEqual(schemes, {
            "boxOffset": {"type": "pageNumber", "autoDetect": False,
                          "request": {"queryParameters": {"offset": {"role": "offset"},
                                                          "limit": {"role": "pageSize"}}},
                          "response": {"envelope": {"itemsField": "entries"},
                                       "bodyFields": {"total_count": {"role": "totalCount"},
                                                      "offset": {"role": "offset"},
                                                      "limit": {"role": "pageSize"}}}},
            "boxMarker": marker({"marker": {"role": "cursor"}, "limit": {"role": "pageSize"}}),
            "boxMarkerNoLimit": marker({"marker": {"role": "cursor"}}),
        })

    def test_only_spec_roles_and_types(self):
        for name, scheme in self.v2["components"]["paginationSchemes"].items():
            with self.subTest(scheme=name):
                self.assertIn(scheme["type"], ("pageNumber", "pageToken"))
                self.assertIs(scheme["autoDetect"], False)

    def test_the_catalog_switches_only_the_box_overlay(self):
        base, new = platforms(BASE), platforms(CATALOG)
        self.assertEqual([p["name"] for p in new], [p["name"] for p in base])
        for before, after in zip(base, new):
            with self.subTest(platform=before["name"]):
                if before["name"] != "box":
                    self.assertEqual(after, before)
                    continue
                self.assertEqual(after["overlays"], [PAGES + V2])
                self.assertEqual(before["overlays"], [PAGES + V1])
                self.assertEqual({k: v for k, v in after.items() if k != "overlays"},
                                 {k: v for k, v in before.items() if k != "overlays"})

    def test_the_box_platform_composed_from_the_catalog_passes_the_validator(self):
        box = next(p for p in platforms(CATALOG) if p["name"] == "box")
        self.assertTrue(box["openapi"].endswith(f"/{PIN}/{SOURCE_PATH}"))
        names = [url[len(PAGES):] for url in box["overlays"]]
        validate_pagination(compose(self.original, names))

    def test_no_other_catalog_selects_v2(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            if catalog.name == CATALOG:
                continue
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(V2, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
