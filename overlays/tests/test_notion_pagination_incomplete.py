"""Check the Notion pagination v3 overlay (Pagination Schemes 0.8.0 `incomplete`).

v3 is composed with its pinned OAD and must pass the Pagination Schemes
validator; it must be v2 plus the Incomplete Object on bodyCursorPages, and a
synthetic page in Notion's documented capped shape must be marked. No provider
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

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "pagination-schemes"))
from validate import response_incomplete, validate as validate_pagination_schemes

DIRECTORY = None
NOTION = "APIs/notion.com/2026-03-11/"
V2 = NOTION + "pagination-v2-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"
V3 = NOTION + "pagination-v3-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"


class NotionPaginationIncompleteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, sha, source = overlay_pin(ROOT / V3)
        assert overlay_pin(ROOT / V2)[0] == url
        with tempfile.TemporaryDirectory() as cache:
            if DIRECTORY:
                raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
            else:
                raw, _ = fetch(url, Path(cache))
        cls.original = yaml.safe_load(raw)
        cls.v2 = copy.deepcopy(cls.original)
        apply(cls.v2, yaml.safe_load((ROOT / V2).read_text()))
        cls.v3 = copy.deepcopy(cls.original)
        apply(cls.v3, yaml.safe_load((ROOT / V3).read_text()))

    def test_valid_and_v2_plus_incomplete(self):
        validate_pagination_schemes(self.v3)
        v3 = copy.deepcopy(self.v3)
        schemes = v3["components"]["paginationSchemes"]
        marker = schemes["bodyCursorPages"]["response"].pop("incomplete")
        self.assertEqual((marker["field"], marker["equals"]), ("request_status.type", "incomplete"))
        self.assertNotIn("incomplete", schemes["queryCursorPages"]["response"])
        self.assertEqual(v3, self.v2)

    def test_search_and_query_pages_are_marked_when_capped(self):
        scheme = self.v3["components"]["paginationSchemes"]["bodyCursorPages"]
        for path in ("/search", "/data_sources/{data_source_id}/query"):
            self.assertEqual(self.v3["paths"][path]["post"]["x-pagination"], [{"scheme": "bodyCursorPages"}])
        capped = {"object": "list", "results": [], "has_more": False, "next_cursor": None,
                  "request_status": {"type": "incomplete", "incomplete_reason": "query_result_limit_reached"}}
        self.assertTrue(response_incomplete(scheme, capped))
        self.assertFalse(response_incomplete(scheme, {**capped, "request_status": {"type": "complete"}}))
        self.assertFalse(response_incomplete(scheme, {"object": "list", "results": [], "has_more": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
