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


class ValidatorGapTests(unittest.TestCase):
    """Review of #402: $ref'd and content schemas, unused parameters, webhooks and callbacks."""

    def zone(self):
        return copy.deepcopy(example()["components"]["parameters"]["Start"]["x-time-zone"])

    def test_refd_schema_format_is_checked(self):
        document = example()
        document["components"]["schemas"] = {"Day": {"type": "string", "format": "date"}}
        document["components"]["parameters"]["Start"]["schema"] = {"$ref": "#/components/schemas/Day"}
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("not 'date-time'", str(raised.exception))

    def test_content_parameter_format_is_checked(self):
        document = example()
        start = document["components"]["parameters"]["Start"]
        del start["schema"]
        start["content"] = {"text/plain": {"schema": {"type": "string", "format": "date"}}}
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("not 'date-time'", str(raised.exception))
        start["content"]["text/plain"]["schema"]["format"] = "date-time"
        validate(document)

    def test_unused_component_parameter_zone_operation_is_checked(self):
        document = example()
        unused = copy.deepcopy(document["components"]["parameters"]["Start"])
        unused["x-time-zone"]["zone"]["operationId"] = "missing"
        document["components"]["parameters"]["Unused"] = unused
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("components.parameters.Unused.x-time-zone.zone.operationId", str(raised.exception))

    def test_webhook_and_callback_parameters_are_not_misplaced(self):
        document = example()
        parameter = {"name": "since", "in": "query", "schema": {"type": "string", "format": "date-time"},
                     "x-time-zone": self.zone()}
        operation = {"parameters": [parameter], "responses": {"200": {"description": "ok"}}}
        document["webhooks"] = {"entryChanged": {"post": copy.deepcopy(operation)}}
        document["paths"][ENTRIES]["get"]["callbacks"] = {
            "onDone": {"{$request.query.callback}": {"post": copy.deepcopy(operation)}}}
        validate(document)
        document["webhooks"]["entryChanged"]["post"]["x-time-zone"] = self.zone()
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("webhooks.entryChanged.post.x-time-zone: allowed only on a Parameter Object", str(raised.exception))


class WallClockTests(unittest.TestCase):
    AMS = "Europe/Amsterdam"

    def test_wall_clock_digits_with_suffix(self):
        self.assertEqual(wall_clock_param(utc("2026-01-15T09:30:00"), self.AMS), "2026-01-15T10:30:00Z")
        self.assertEqual(wall_clock_param(utc("2026-07-15T09:30:00"), self.AMS), "2026-07-15T11:30:00Z")
        self.assertEqual(wall_clock_param(utc("2026-07-15T09:30:00"), "America/New_York", "+00:00"),
                         "2026-07-15T05:30:00+00:00")
        self.assertEqual(wall_clock_param(utc("2026-07-15T09:30:00"), "Pacific/Kiritimati", None), "2026-07-15T23:30:00")

    def test_ordinary_bounds_cover_exactly(self):
        span = covered_span(naive("2026-01-01T00:00:00"), naive("2026-02-01T00:00:00"), self.AMS)
        self.assertEqual(span, (utc("2025-12-31T23:00:00"), utc("2026-01-31T23:00:00")))
        for ambiguous in ("earlier", "later"):
            self.assertEqual(covered_span(naive("2026-01-01T00:00:00"), naive("2026-02-01T00:00:00"), self.AMS, ambiguous),
                             span)

    def test_repeated_hour(self):
        # 2026-10-25 02:30 happens twice in Amsterdam: at +02:00 (00:30Z), then at +01:00 (01:30Z).
        wall = naive("2026-10-25T02:30:00")
        self.assertEqual(instants_of(wall, self.AMS),
                         {"earlier": utc("2026-10-25T00:30:00"), "later": utc("2026-10-25T01:30:00")})
        after, before = naive("2026-11-01T00:00:00"), naive("2026-10-01T00:00:00")
        self.assertEqual(covered_span(wall, after, self.AMS)[0], utc("2026-10-25T01:30:00"))
        self.assertEqual(covered_span(before, wall, self.AMS)[1], utc("2026-10-25T00:30:00"))
        self.assertEqual(covered_span(wall, after, self.AMS, "earlier")[0], utc("2026-10-25T00:30:00"))
        self.assertEqual(covered_span(wall, after, self.AMS, "later")[0], utc("2026-10-25T01:30:00"))

    def test_skipped_hour_is_by_offset(self):
        # 2026-03-29 02:30 does not exist in Amsterdam. The offset before the change, +01:00,
        # gives 01:30Z; the one after, +02:00, gives 00:30Z (review of #402).
        wall = naive("2026-03-29T02:30:00")
        self.assertEqual(instants_of(wall, self.AMS),
                         {"earlier": utc("2026-03-29T01:30:00"), "later": utc("2026-03-29T00:30:00")})
        after, before = naive("2026-04-01T00:00:00"), naive("2026-03-01T00:00:00")
        self.assertEqual(covered_span(wall, after, self.AMS, "earlier")[0], utc("2026-03-29T01:30:00"))
        self.assertEqual(covered_span(wall, after, self.AMS, "later")[0], utc("2026-03-29T00:30:00"))
        self.assertEqual(covered_span(before, wall, self.AMS, "earlier")[1], utc("2026-03-29T01:30:00"))
        self.assertEqual(covered_span(before, wall, self.AMS, "later")[1], utc("2026-03-29T00:30:00"))
        # unspecified: the reading that covers least, for a lower and an upper bound.
        self.assertEqual(covered_span(wall, after, self.AMS)[0], utc("2026-03-29T01:30:00"))
        self.assertEqual(covered_span(before, wall, self.AMS)[1], utc("2026-03-29T00:30:00"))

    def test_unknown_zone_narrows_each_bound_by_14_hours(self):
        span = covered_span(naive("2026-01-10T00:00:00"), naive("2026-01-20T00:00:00"), None)
        self.assertEqual(span, (utc("2026-01-10T14:00:00"), utc("2026-01-19T10:00:00")))

    def test_short_window_with_unknown_zone_covers_nothing(self):
        self.assertIsNone(covered_span(naive("2026-01-10T00:00:00"), naive("2026-01-11T03:59:59"), None))
        self.assertIsNone(covered_span(naive("2026-01-10T00:00:00"), naive("2026-01-11T04:00:00"), None))
        self.assertIsNotNone(covered_span(naive("2026-01-10T00:00:00"), naive("2026-01-11T04:00:01"), None))


if __name__ == "__main__":
    unittest.main()
