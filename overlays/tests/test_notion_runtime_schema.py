"""Notion page properties as a Runtime Schemas 0.1.0-draft x-runtime-schema.

Composes the pinned 2026-03-11 Notion OAD with the published overlays in the
order the dated catalogs list them, then the unpublished runtime-schema
overlay. Checks that the result is valid OpenAPI, that the Runtime Schemas
reference validator accepts it with the describer's read operation present,
that it describes the same property types the Notion app's lens projects,
and reads a synthetic data source and page shaped like Notion's documented
objects. No provider requests are made.

Use --directory for an openapi-directory checkout that has the pinned
commit (a blobless clone is enough); otherwise the pinned raw URL is
downloaded.
"""
import argparse
import copy
from pathlib import Path
import re
import subprocess
import sys
import unittest
import urllib.request

import yaml
from openapi_spec_validator import validate as validate_openapi

ROOT = Path(__file__).resolve().parents[1]
PIN = "0c8e229623efdcc1d4ab50111d17bcca3214a899"
SOURCE_PATH = "APIs/notion.com/2026-03-11/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
FOLDER = ROOT / "APIs/notion.com/2026-03-11"
PUBLISHED = ("auth", "pagination", "crud-causality")
OVERLAY = f"runtime-schema-{PIN}-overlay.yaml"
LENS = ROOT.parent / "integrations/notion/devonian/notion/lens/projection.ts"
DIRECTORY = None

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay  # noqa: E402

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "runtime-schemas"))
from validate import derive_class, read_members, validate as validate_runtime  # noqa: E402

DATA_SOURCE = {
    "object": "data_source",
    "id": "248104cd-477e-80af-bc30-000bc0be0000",
    "properties": {
        "Name": {"id": "title", "name": "Name", "type": "title", "description": None, "title": {}},
        "Hours": {"id": "a%3Ab", "name": "Hours", "type": "number", "description": None,
                  "number": {"format": "number"}},
        "Stage": {"id": "c%3Ad", "name": "Stage", "type": "status", "description": None, "status": {
            "options": [{"id": "s-1", "name": "Not started", "color": "default"},
                        {"id": "s-2", "name": "Done", "color": "green"}],
            "groups": []}},
        "Tags": {"id": "e%3Af", "name": "Tags", "type": "multi_select", "description": None,
                 "multi_select": {"options": [{"id": "t-1", "name": "urgent", "color": "red"}]}},
        "Owner": {"id": "g%3Ah", "name": "Owner", "type": "people", "description": None, "people": {}},
    },
}

PAGE = {
    "object": "page",
    "id": "248104cd-477e-80af-bc30-000bc0be0001",
    "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE["id"]},
    "properties": {
        "Name": {"id": "title", "type": "title", "title": [{"type": "text", "plain_text": "Write spec"}]},
        "Hours": {"id": "a%3Ab", "type": "number", "number": 2.5},
        "Stage": {"id": "c%3Ad", "type": "status", "status": {"id": "s-2", "name": "Done", "color": "green"}},
        "Tags": {"id": "e%3Af", "type": "multi_select", "multi_select": [{"id": "t-1", "name": "urgent"}]},
        "Owner": {"id": "g%3Ah", "type": "people", "people": []},
    },
}


def load_source():
    if DIRECTORY:
        raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", f"{PIN}:{SOURCE_PATH}"])
    else:
        raw = urllib.request.urlopen(OAD, timeout=30).read()
    return yaml.safe_load(raw)


def compose():
    document = load_source()
    for name in [f"{kind}-{PIN}-overlay.yaml" for kind in PUBLISHED] + [OVERLAY]:
        path = FOLDER / name
        document, errors = apply_overlay(document, yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
        if errors:
            raise AssertionError("\n".join(errors))
    return document


class NotionRuntimeSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = compose()
        cls.runtime = cls.document["components"]["crudResources"]["page"]["x-runtime-schema"]

    def test_composed_document_is_valid(self):
        warnings = []
        validate_runtime(self.document, warnings)
        self.assertEqual(warnings, [])  # the describer's GET /data_sources/{data_source_id} is in the document
        standard = copy.deepcopy(self.document)
        for key in ("crudResources", "paginationSchemes"):
            standard["components"].pop(key, None)
        validate_openapi(standard)

    def test_types_are_the_lens_projected_types(self):
        source = LENS.read_text(encoding="utf-8")
        block = re.search(r"notionFieldTypes = \[(.*?)\] as const", source, re.S).group(1)
        self.assertEqual(set(self.runtime["types"]), set(re.findall(r"'([a-z_]+)'", block)))

    def test_reads_a_documented_page_against_its_data_source(self):
        derived = derive_class(self.runtime, DATA_SOURCE)
        self.assertEqual(set(derived["properties"]), {"title", "a%3Ab", "c%3Ad", "e%3Af"})
        self.assertEqual(derived["undescribed"], ["g%3Ah"])
        self.assertEqual(derived["properties"]["c%3Ad"]["options"], {"s-1": "Not started", "s-2": "Done"})
        result = read_members(self.runtime, derived, PAGE)
        self.assertEqual(result["values"]["a%3Ab"], 2.5)
        self.assertEqual(result["values"]["c%3Ad"], "s-2")
        self.assertEqual(result["values"]["e%3Af"], ["t-1"])
        self.assertEqual(result["undescribed"], ["Owner"])
        self.assertEqual(result["unmatched"], [])

    def test_renamed_column_keeps_its_values(self):
        source = copy.deepcopy(DATA_SOURCE)
        source["properties"]["Effort"] = dict(source["properties"].pop("Hours"), name="Effort")
        page = copy.deepcopy(PAGE)
        page["properties"]["Effort"] = page["properties"].pop("Hours")
        derived = derive_class(self.runtime, source)
        self.assertEqual(derived["properties"]["a%3Ab"]["name"], "Effort")
        self.assertEqual(read_members(self.runtime, derived, page)["values"]["a%3Ab"], 2.5)

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
