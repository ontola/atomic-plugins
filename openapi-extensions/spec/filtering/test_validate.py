"""Filtering 0.2.0-draft: x-time-zone and x-filter validation, and wall-clock conversion."""
import copy
import datetime
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import covered_span, instants_of, validate, wall_clock_param

ROOT = pathlib.Path(__file__).parent
UTC = datetime.timezone.utc
ENTRIES = "/workspaces/{workspaceId}/users/{userId}/entries"


def example():
    return yaml.safe_load((ROOT / "examples" / "wall-clock-zone.yaml").read_text(encoding="utf-8"))


def naive(text):
    return datetime.datetime.fromisoformat(text)


def utc(text):
    return datetime.datetime.fromisoformat(text).replace(tzinfo=UTC)


class ValidationTests(unittest.TestCase):
    def zone(self, document, name="Start"):
        return document["components"]["parameters"][name]["x-time-zone"]

    def assertInvalid(self, document, fragment):
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_example_is_valid(self):
        validate(example())

    def test_example_is_valid_openapi(self):
        validate_openapi(example())

    def test_interpretation_suffix_and_ambiguous(self):
        for key, value, fragment in (("interpretation", "utc", "interpretation"), ("suffix", "UTC", "suffix"),
                                     ("ambiguous", "first", "ambiguous"), ("extra", 1, "unknown member")):
            document = example()
            self.zone(document)[key] = value
            with self.subTest(key=key):
                self.assertInvalid(document, fragment)
        document = example()
        self.zone(document)["suffix"] = "+00:00"
        validate(document)
        del self.zone(document)["interpretation"]
        self.assertInvalid(document, "interpretation")

    def test_zone_source_is_exactly_one(self):
        for zone, fragment in (({}, "exactly one"),
                               ({"name": "UTC", "operationId": "getCurrentUser", "pointer": "/x"}, "exactly one"),
                               ({"operationId": "getCurrentUser"}, "zone.pointer"),
                               ({"operationId": "getCurrentUser", "pointer": "settings/timeZone"}, "zone.pointer"),
                               ({"name": "UTC", "pointer": "/x"}, "allowed only with operationId"),
                               ({"name": ""}, "zone.name")):
            document = example()
            self.zone(document)["zone"] = zone
            with self.subTest(zone=zone):
                self.assertInvalid(document, fragment)

    def test_zone_operation_must_exist_be_a_get_and_need_no_other_parameter(self):
        document = example()
        self.zone(document)["zone"]["operationId"] = "missing"
        self.assertInvalid(document, "no operation 'missing'")
        document = example()
        document["paths"]["/user"]["post"] = document["paths"]["/user"].pop("get")
        self.assertInvalid(document, "is a post, not a get")
        document = example()
        document["paths"]["/user"]["get"]["parameters"] = [
            {"name": "workspaceId", "in": "path", "required": True, "schema": {"type": "string"}}]
        validate(document)  # the list request has workspaceId
        document["paths"]["/user"]["get"]["parameters"].append(
            {"name": "include", "in": "query", "required": True, "schema": {"type": "string"}})
        self.assertInvalid(document, "requires parameters ['include']")

    def test_only_date_time_parameters(self):
        document = example()
        document["components"]["parameters"]["Start"]["schema"]["format"] = "date"
        self.assertInvalid(document, "not 'date-time'")

    def test_only_on_parameter_objects(self):
        document = example()
        document["paths"][ENTRIES]["get"]["x-time-zone"] = copy.deepcopy(self.zone(document))
        self.assertInvalid(document, "allowed only on a Parameter Object")
        document = example()
        document["components"]["schemas"] = {"T": {"type": "string", "x-time-zone": {}}}
        self.assertInvalid(document, "allowed only on a Parameter Object")

    def test_filter_shape(self):
        for value, fragment in (({"field": "timeInterval/start", "operator": "gte"}, "field"),
                                ({"field": "/a", "operator": "between"}, "operator"), ("gte", "expected an object")):
            document = example()
            document["components"]["parameters"]["End"]["x-filter"] = value
            with self.subTest(value=value):
                self.assertInvalid(document, "x-filter")


class WallClockTests(unittest.TestCase):
    def test_wall_clock_digits_with_suffix(self):
        self.assertEqual(wall_clock_param(utc("2026-01-15T09:30:00"), "Europe/Amsterdam"), "2026-01-15T10:30:00Z")
        self.assertEqual(wall_clock_param(utc("2026-07-15T09:30:00"), "Europe/Amsterdam"), "2026-07-15T11:30:00Z")
        self.assertEqual(wall_clock_param(utc("2026-07-15T09:30:00"), "America/New_York", "+00:00"),
                         "2026-07-15T05:30:00+00:00")
        self.assertEqual(wall_clock_param(utc("2026-07-15T09:30:00"), "Pacific/Kiritimati", None), "2026-07-15T23:30:00")

    def test_ordinary_bounds_cover_exactly(self):
        span = covered_span(naive("2026-01-01T00:00:00"), naive("2026-02-01T00:00:00"), "Europe/Amsterdam")
        self.assertEqual(span, (utc("2025-12-31T23:00:00"), utc("2026-01-31T23:00:00")))

    def test_repeated_hour_takes_the_reading_that_covers_least(self):
        # 2026-10-25 02:30 happens twice in Amsterdam: 00:30Z and 01:30Z.
        wall = naive("2026-10-25T02:30:00")
        self.assertEqual(instants_of(wall, "Europe/Amsterdam"), [utc("2026-10-25T00:30:00"), utc("2026-10-25T01:30:00")])
        start, _ = covered_span(wall, naive("2026-11-01T00:00:00"), "Europe/Amsterdam")
        self.assertEqual(start, utc("2026-10-25T01:30:00"))
        _, end = covered_span(naive("2026-10-01T00:00:00"), wall, "Europe/Amsterdam")
        self.assertEqual(end, utc("2026-10-25T00:30:00"))
        self.assertEqual(covered_span(wall, wall, "Europe/Amsterdam", "earlier")[0], utc("2026-10-25T00:30:00"))
        self.assertEqual(covered_span(wall, wall, "Europe/Amsterdam", "later")[0], utc("2026-10-25T01:30:00"))

    def test_skipped_hour_gives_both_offsets(self):
        # 2026-03-29 02:30 does not exist in Amsterdam.
        self.assertEqual(instants_of(naive("2026-03-29T02:30:00"), "Europe/Amsterdam"),
                         [utc("2026-03-29T00:30:00"), utc("2026-03-29T01:30:00")])

    def test_unknown_zone_narrows_each_bound_by_14_hours(self):
        span = covered_span(naive("2026-01-10T00:00:00"), naive("2026-01-20T00:00:00"), None)
        self.assertEqual(span, (utc("2026-01-10T14:00:00"), utc("2026-01-19T10:00:00")))


if __name__ == "__main__":
    unittest.main()
