"""Clockify's time-entry list bounds as Filtering 0.2.0-draft x-time-zone.

Composes the pinned read-only Clockify OAD with the published overlays in the
order the dated catalogs list them, then the unpublished time-zone overlay.
Checks that the result is valid OpenAPI, that the Filtering reference
validator accepts it (the zone operation, GET /v1/user, is a get with no
required parameters), and that the reference conversion gives the bounds the
timesheets app sends (integrations/timesheets/app/timeZone.ts). No provider
requests are made.

Use --directory for an openapi-directory checkout that has the pinned
commit (a blobless clone is enough); otherwise the pinned raw URL is
downloaded.
"""
import argparse
import copy
import datetime
from pathlib import Path
import subprocess
import sys
import unittest
import urllib.request

import yaml
from openapi_spec_validator import validate as validate_openapi

ROOT = Path(__file__).resolve().parents[1]
PIN = "dd34a70a45c5109479068b4b5d91337baf8822cd"
SOURCE_PATH = "APIs/clockify.me/1.0.0-readonly/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
FOLDER = ROOT / "APIs/clockify.me/1.0.0-readonly"
PUBLISHED = ("crud-causality", "auth", "pagination", "time-entry-write")
OVERLAY = f"time-zone-{PIN}-overlay.yaml"
LIST = "/v1/workspaces/{workspaceId}/user/{userId}/time-entries"
UTC = datetime.timezone.utc
DIRECTORY = None

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay  # noqa: E402

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "filtering"))
from validate import covered_span, validate as validate_filtering, wall_clock_param  # noqa: E402


def load_source():
    if DIRECTORY:
        raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", f"{PIN}:{SOURCE_PATH}"])
    else:
        raw = urllib.request.urlopen(OAD, timeout=30).read()
    return yaml.safe_load(raw)


def compose(names):
    document = load_source()
    for name in names:
        path = FOLDER / name
        document, errors = apply_overlay(document, yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
        if errors:
            raise AssertionError("\n".join(errors))
    return document


class ClockifyTimeZoneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = compose([f"{kind}-{PIN}-overlay.yaml" for kind in PUBLISHED] + [OVERLAY])

    def test_composed_document_is_valid(self):
        validate_filtering(self.document)
        standard = copy.deepcopy(self.document)
        for key in ("paginationSchemes", "crudResources"):
            standard["components"].pop(key, None)
        validate_openapi(standard)

    def test_the_list_takes_both_bounds_in_the_profile_zone(self):
        parameters = {}
        for raw in self.document["paths"][LIST]["get"]["parameters"]:
            ref = raw.get("$ref", "")
            parameter = self.document["components"]["parameters"][ref.rsplit("/", 1)[-1]] if ref else raw
            parameters[parameter["name"]] = parameter
        for name, operator in (("start", "gte"), ("end", "lt")):
            zone = parameters[name]["x-time-zone"]
            self.assertEqual(zone["zone"], {"operationId": "getClockifyCurrentUser", "pointer": "/settings/timeZone"})
            self.assertEqual(zone["suffix"], "Z")
            self.assertEqual(parameters[name]["x-filter"], {"field": "/timeInterval/start", "operator": operator})
        user = self.document["components"]["schemas"]["CurrentUser"]["properties"]
        self.assertEqual(user["settings"]["properties"]["timeZone"]["type"], "string")
        self.assertIn("id", user)  # the crud-causality fields are kept

    def test_overlay_resolves_on_the_bare_oad(self):
        compose([OVERLAY])

    def test_bounds_match_the_timesheets_app(self):
        # timeZone.ts: wallClockParam(at, zone) is the wall-clock digits with a Z.
        at = datetime.datetime(2026, 9, 24, 7, 0, tzinfo=UTC)
        self.assertEqual(wall_clock_param(at, "Europe/Amsterdam"), "2026-09-24T09:00:00Z")
        # clockifyObserve.ts rangeBounds with no zone: from + 14 h, to - 14 h.
        start, end = covered_span(datetime.datetime(2026, 9, 1), datetime.datetime(2026, 9, 30), None)
        self.assertEqual((start, end), (datetime.datetime(2026, 9, 1, 14, tzinfo=UTC),
                                        datetime.datetime(2026, 9, 29, 10, tzinfo=UTC)))

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
