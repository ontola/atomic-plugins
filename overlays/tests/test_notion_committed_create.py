"""Check the Notion crud-causality v2 overlay (CRUD Causality 0.8.0 committedErrors).

v2 is composed with its pinned OAD, alone and in either order with the
catalog's other Notion overlays (auth, pagination). It must pass the CRUD
Causality validator, keep v1's schemas and resources, add only the page
create, and bind a synthetic 503 in Notion's documented shape. No provider
is called. Use --directory for a full-history openapi-directory checkout;
otherwise the full-SHA source URL is downloaded.
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

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "crud-causality"))
from validate import committed_identity, created_identity, validate as validate_crud

DIRECTORY = None
NOTION = "APIs/notion.com/2026-03-11/"
V1 = NOTION + "crud-causality-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"
V2 = NOTION + "crud-causality-v2-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"
SIBLINGS = [NOTION + "auth-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml",
            NOTION + "pagination-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"]


def load(path):
    return yaml.safe_load((ROOT / path).read_text())


class NotionCommittedCreateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / V2)
        for path in [V1] + SIBLINGS:
            assert overlay_pin(ROOT / path)[0] == url
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.composed = copy.deepcopy(cls.original)
        apply(cls.composed, load(V2))

    def crud(self):
        return self.composed["paths"]["/pages"]["post"]["x-crud"]

    def test_valid_and_composes_with_the_catalogued_siblings(self):
        validate_crud(self.composed)
        siblings = [load(p) for p in SIBLINGS]
        first, second = copy.deepcopy(self.original), copy.deepcopy(self.original)
        for s in siblings:
            apply(first, s)
        apply(first, load(V2))
        apply(second, load(V2))
        for s in siblings:
            apply(second, s)
        self.assertEqual(first, second)
        validate_crud(first)

    def test_v2_is_v1_plus_the_page_create(self):
        v1, v2 = load(V1), load(V2)
        self.assertEqual(v1["extends"], v2["extends"])
        self.assertEqual(v1["actions"], v2["actions"][:len(v1["actions"])])
        [extra] = v2["actions"][len(v1["actions"]):]
        self.assertEqual(extra["target"], "$.paths['/pages'].post")
        self.assertEqual(set(extra["update"]), {"x-crud"})
        # Only that operation gains an x-crud.
        with_crud = [(path, method) for path, item in self.composed["paths"].items()
                     for method, op in item.items() if isinstance(op, dict) and "x-crud" in op]
        self.assertEqual(with_crud, [("/pages", "post")])

    def test_a_documented_503_binds_the_new_page(self):
        body = {"object": "error", "status": 503, "code": "service_unavailable",
                "message": "The change was saved, but the response could not be built in time.",
                "additional_data": {"retry_guidance": ["Read the object again to confirm the saved change.",
                                                       "Do not repeat the write."],
                                    "committed_resource_id": "59833787-2cf9-4fdf-8782-e53db20768a5"}}
        self.assertEqual(committed_identity(self.composed, self.crud(), 503, body),
                         {"page_id": "59833787-2cf9-4fdf-8782-e53db20768a5"})
        unavailable = {"object": "error", "status": 503, "code": "service_unavailable",
                       "message": "Notion is unavailable, please try again later."}
        self.assertIsNone(committed_identity(self.composed, self.crud(), 503, unavailable))
        self.assertIsNone(committed_identity(self.composed, self.crud(), 502, body))
        # The create's own 200 is bound through the template from the page object's id.
        self.assertEqual(created_identity(self.composed, self.crud(), {"object": "page", "id": "p1"}),
                         {"id": "p1"})

    def test_no_dated_catalog_selects_it(self):
        name = V2.rsplit("/", 1)[1]
        for catalog in (ROOT / "catalog").glob("*.json"):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(name, catalog.read_text())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
