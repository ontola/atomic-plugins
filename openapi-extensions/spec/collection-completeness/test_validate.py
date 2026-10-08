"""Collection Completeness 0.2.0-draft: notFound, parentAbsent and their reference classification."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import classify_read, members_of_gone_parent, validate

ROOT = pathlib.Path(__file__).parent
TOMBSTONE = {"field": "deleted", "values": [True]}


def example():
    return yaml.safe_load((ROOT / "examples" / "nested-tasks.yaml").read_text(encoding="utf-8"))


def completeness(document, resource="task", collection="listTasks"):
    return document["components"]["crudResources"][resource]["collections"][collection]["x-completeness"]


class ValidationTests(unittest.TestCase):
    def invalid(self, mutate, fragment):
        document = example()
        mutate(document)
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_example_is_valid(self):
        validate(example())

    def test_example_is_valid_openapi_without_the_extension_member(self):
        document = example()
        document.pop("components")
        validate_openapi(document)

    def test_0_1_declarations_stay_valid(self):
        document = example()
        for resource, collection in (("task", "listTasks"), ("taskList", "taskLists")):
            declaration = completeness(document, resource, collection)
            declaration.pop("notFound")
            declaration.pop("parentAbsent", None)
        completeness(document)["absent"] = "deleted"
        document["paths"]["/lists/{listId}/tasks"]["get"]["x-completeness"] = {"absent": "removed"}
        validate(document)

    def test_values(self):
        self.invalid(lambda d: completeness(d).update(absent="gone"), "absent: expected")
        self.invalid(lambda d: completeness(d).update(notFound="removed"), "notFound: expected")
        self.invalid(lambda d: completeness(d).update(parentAbsent="removed"), "parentAbsent: expected")
        self.invalid(lambda d: completeness(d).update(extra=1), "unknown fields")
        document = example()
        completeness(document)["x-note"] = "extensions are fine"
        validate(document)

    def test_not_found_is_not_allowed_with_absent_deleted(self):
        self.invalid(lambda d: completeness(d).update(absent="deleted"), "notFound: not allowed with absent: deleted")

    def test_parent_absent_needs_a_nested_collection_with_a_complete_parent(self):
        self.invalid(lambda d: completeness(d, "taskList", "taskLists").update(parentAbsent="unavailable"), "is not nested")
        self.invalid(lambda d: completeness(d, "taskList", "taskLists").clear() or
                     d["components"]["crudResources"]["taskList"]["collections"]["taskLists"].pop("x-completeness"),
                     "has no collection with x-completeness")

        def second_parent(document):
            document["components"]["crudResources"]["owner"] = {
                "identity": {"urlTemplate": "/owners/{listId}", "bindings": {"listId": {"field": "id"}}},
                "collections": {"owners": {"urlTemplate": "/owners", "x-completeness": {"absent": "removed"}}}}
        self.invalid(second_parent, "more than one parent resource ['owner', 'taskList']")

        def cascade_without_not_found(document):
            completeness(document)["parentAbsent"] = "deleted"
            completeness(document, "taskList", "taskLists").pop("notFound")
        self.invalid(cascade_without_not_found, "deleted needs an explicit notFound")
        document = example()
        completeness(document)["parentAbsent"] = "deleted"  # parent (absent: removed) states notFound explicitly
        validate(document)
        # The natural cascade: a parent collection declared absent: deleted needs (and allows) no notFound.
        parent = completeness(document, "taskList", "taskLists")
        parent.pop("notFound")
        parent["absent"] = "deleted"
        validate(document)

        def on_operation(document):
            document["paths"]["/lists/{listId}/tasks"]["get"]["x-completeness"] = copy.deepcopy(completeness(document))
        self.invalid(on_operation, "only on a Collection Object")


class ClassifyTests(unittest.TestCase):
    def classify(self, status, body, declaration=None, tombstone=TOMBSTONE):
        declaration = declaration if declaration is not None else completeness(example())
        return classify_read(declaration, tombstone, "id", "t1", status, body)

    def test_read_outcomes(self):
        self.assertEqual(self.classify(200, {"id": "t1", "title": "x"}), "present")
        self.assertEqual(self.classify(200, {"id": "t1", "deleted": True}), "deleted")
        self.assertEqual(self.classify(200, {"id": "t1", "deleted": "true"}), "present")  # same JSON type only
        self.assertEqual(self.classify(404, None), "unavailable")
        self.assertEqual(self.classify(410, None), "unavailable")
        for status, body in ((500, None), (403, None), (200, {"id": "other"}), (200, None), (None, None)):
            self.assertEqual(self.classify(status, body), "unknown")

    def test_not_found_defaults_to_deleted(self):
        self.assertEqual(self.classify(404, None, {"absent": "removed"}), "deleted")
        self.assertEqual(self.classify(404, None, {"absent": "removed", "notFound": "deleted"}), "deleted")
        self.assertEqual(self.classify(200, {"id": "t1", "deleted": True}, {"absent": "removed"}, None), "present")

    def test_members_of_a_gone_parent(self):
        declaration = completeness(example())
        self.assertEqual(members_of_gone_parent(declaration, "unavailable"), "unavailable")
        self.assertEqual(members_of_gone_parent(declaration, "deleted"), "unavailable")
        self.assertIsNone(members_of_gone_parent(declaration, "present"))
        self.assertIsNone(members_of_gone_parent(declaration, "unknown"))
        cascade = dict(declaration, parentAbsent="deleted")
        self.assertEqual(members_of_gone_parent(cascade, "deleted"), "deleted")
        self.assertEqual(members_of_gone_parent(cascade, "unavailable"), "unavailable")
        self.assertIsNone(members_of_gone_parent({"absent": "removed"}, "deleted"))


if __name__ == "__main__":
    unittest.main()
