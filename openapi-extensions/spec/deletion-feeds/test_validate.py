"""Deletion Feeds 0.3.0-draft: document rules and list tombstones (§4.5)."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import list_tombstone, read_tombstone, tombstone, validate

ROOT = pathlib.Path(__file__).parent


def example():
    return yaml.safe_load((ROOT / "examples" / "list-tombstones.yaml").read_text(encoding="utf-8"))


def declaration(document):
    return document["components"]["crudResources"]["event"]["collections"]["eventsWithDeleted"]["x-list-tombstone"]


class ExampleTests(unittest.TestCase):
    def test_example_is_valid(self):
        validate(example())

    def test_example_is_valid_openapi_without_the_extension_member(self):
        document = example()
        document["components"].pop("crudResources")
        validate_openapi(document)


class DocumentRuleTests(unittest.TestCase):
    def assertInvalid(self, document, fragment):
        with self.assertRaises(ValueError) as caught:
            validate(document)
        self.assertIn(fragment, str(caught.exception))

    def test_values_must_be_nonempty_scalars(self):
        for values in ([], None, [{"x": 1}], "cancelled"):
            document = example()
            declaration(document)["values"] = values
            with self.subTest(values=values):
                self.assertInvalid(document, "x-list-tombstone.values")

    def test_field_must_be_a_dot_path(self):
        for field in ("", "a..b", ".a", 3):
            document = example()
            declaration(document)["field"] = field
            with self.subTest(field=field):
                self.assertInvalid(document, "x-list-tombstone.field")

    def test_except_conditions(self):
        cases = [
            ([], "except: expected a nonempty array"),
            ([{"field": "x"}], "exactly one of values or present"),
            ([{"field": "x", "values": ["a"], "present": True}], "exactly one of values or present"),
            ([{"field": "x", "present": False}], "present: expected true"),
            ([{"field": "x", "values": []}], "except[0].values"),
            ([{"values": ["a"]}], "except[0].field"),
        ]
        for value, fragment in cases:
            document = example()
            declaration(document)["except"] = value
            with self.subTest(value=value):
                self.assertInvalid(document, fragment)

    def test_placement(self):
        document = example()
        document["components"]["crudResources"]["event"]["x-list-tombstone"] = {"field": "status", "values": ["cancelled"]}
        self.assertInvalid(document, "only on a Collection Object or a list operation")
        document = example()
        document["paths"]["/calendars/{calendarId}/events/{eventId}"]["delete"] = {
            "responses": {"204": {"description": "Deleted"}},
            "x-list-tombstone": {"field": "status", "values": ["cancelled"]},
        }
        self.assertInvalid(document, "only on a GET or POST list operation")
        # On the list operation itself it is allowed.
        document = example()
        document["paths"]["/calendars/{calendarId}/events"]["get"]["x-list-tombstone"] = {
            "field": "status", "values": ["cancelled"]}
        validate(document)

    def test_unknown_fields(self):
        document = example()
        declaration(document)["unless"] = []
        self.assertInvalid(document, "unknown fields ['unless']")

    def test_earlier_objects_are_still_checked(self):
        document = example()
        collection = document["components"]["crudResources"]["event"]["collections"]["eventsWithDeleted"]
        collection["x-deletion-feed"] = {"operationId": "missing"}
        self.assertInvalid(document, "names no GET operation")
        document = example()
        document["paths"]["/calendars/{calendarId}/events/{eventId}"]["get"]["x-read-tombstone"] = {
            "field": "status", "values": []}
        self.assertInvalid(document, "x-read-tombstone.values")
        document = example()
        collection = document["components"]["crudResources"]["event"]["collections"]["eventsWithDeleted"]
        collection["x-read-tombstone"] = {"field": "status", "values": ["cancelled"]}
        self.assertInvalid(document, "not on a Collection Object")


class ListTombstoneTests(unittest.TestCase):
    def setUp(self):
        self.declaration = declaration(example())

    def test_a_cancelled_event_is_a_list_tombstone(self):
        self.assertTrue(list_tombstone(self.declaration, {"id": "e1", "status": "cancelled"}))

    def test_a_cancelled_exception_is_a_member(self):
        item = {"id": "e2_20261012", "status": "cancelled", "recurringEventId": "e2"}
        self.assertFalse(list_tombstone(self.declaration, item))
        # present includes null: the field is there.
        item["recurringEventId"] = None
        self.assertFalse(list_tombstone(self.declaration, item))

    def test_other_statuses_and_missing_fields_are_members(self):
        for item in ({"id": "e3", "status": "confirmed"}, {"id": "e4"}, {"id": "e5", "status": None}, "e6"):
            with self.subTest(item=item):
                self.assertFalse(list_tombstone(self.declaration, item))

    def test_values_compare_by_json_type(self):
        declaration = {"field": "deleted", "values": [True]}
        self.assertTrue(list_tombstone(declaration, {"deleted": True}))
        self.assertFalse(list_tombstone(declaration, {"deleted": "true"}))
        self.assertFalse(list_tombstone(declaration, {"deleted": 1}))
        numeric = {"field": "state", "values": [2]}
        self.assertTrue(list_tombstone(numeric, {"state": 2.0}))
        self.assertFalse(list_tombstone(numeric, {"state": "2"}))

    def test_except_with_values_and_nested_fields(self):
        declaration = {
            "field": "meta.status",
            "values": ["deleted"],
            "except": [{"field": "meta.reason", "values": ["archived"]}],
        }
        self.assertTrue(list_tombstone(declaration, {"meta": {"status": "deleted", "reason": "user"}}))
        self.assertFalse(list_tombstone(declaration, {"meta": {"status": "deleted", "reason": "archived"}}))

    def test_a_restore_is_a_member_again(self):
        # The same object in a later read, without the marker (§4.5).
        self.assertTrue(list_tombstone(self.declaration, {"id": "e1", "status": "cancelled"}))
        self.assertFalse(list_tombstone(self.declaration, {"id": "e1", "status": "confirmed"}))


class SharedExceptTests(unittest.TestCase):
    """0.3.0: one Tombstone Object rule for feeds, reads and lists (§4.3)."""

    CALENDAR = {"field": "status", "values": ["cancelled"],
                "except": [{"field": "recurringEventId", "present": True}]}

    def test_read_and_list_give_one_reading(self):
        exception = {"id": "e2_1", "status": "cancelled", "recurringEventId": "e2"}
        deleted = {"id": "e1", "status": "cancelled"}
        self.assertFalse(read_tombstone(self.CALENDAR, exception, "id", "e2_1"))
        self.assertFalse(list_tombstone(self.CALENDAR, exception))
        self.assertTrue(read_tombstone(self.CALENDAR, deleted, "id", "e1"))
        self.assertTrue(list_tombstone(self.CALENDAR, deleted))
        # A read body about another object is never a read tombstone.
        self.assertFalse(read_tombstone(self.CALENDAR, deleted, "id", "e9"))

    def test_except_is_checked_on_read_tombstones_and_feeds(self):
        document = example()
        document["paths"]["/calendars/{calendarId}/events/{eventId}"]["get"]["x-read-tombstone"] = dict(self.CALENDAR)
        validate(document)
        document["paths"]["/calendars/{calendarId}/events/{eventId}"]["get"]["x-read-tombstone"]["except"] = [{"field": "x"}]
        with self.assertRaises(ValueError) as caught:
            validate(document)
        self.assertIn("x-read-tombstone.except[0]", str(caught.exception))
        document = example()
        collection = document["components"]["crudResources"]["event"]["collections"]["eventsWithDeleted"]
        collection["x-deletion-feed"] = {"operationId": "listEvents",
                                         "tombstone": {**self.CALENDAR, "except": []}}
        with self.assertRaises(ValueError) as caught:
            validate(document)
        self.assertIn("tombstone.except: expected a nonempty array", str(caught.exception))
        self.assertTrue(tombstone({"field": "deleted", "values": [True]}, {"deleted": True}))


if __name__ == "__main__":
    unittest.main()
