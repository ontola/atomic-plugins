"""Collection Completeness 0.2.0-draft: notFound, parentAbsent and their reference classification."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import classify_read, members_of_gone_parent, resource_not_found, resource_read_value, validate

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

        # 0.2.0 has no deleted cascade.
        self.invalid(lambda d: completeness(d).update(parentAbsent="deleted"), "expected unavailable")
        # An operation-level declaration counts for its collection.
        document = example()
        document["components"]["crudResources"]["taskList"]["collections"]["shared"] = {"urlTemplate": "/shared/lists"}
        document["paths"]["/shared/lists"] = {"get": {"x-crud": {"action": "list", "resource": "taskList", "collection": "shared"},
                                                      "x-completeness": {"absent": "removed", "notFound": "unavailable"},
                                                      "responses": {"200": {"description": "ok"}}}}
        validate(document)
        # Collections of one resource must agree on notFound.
        document["paths"]["/shared/lists"]["get"]["x-completeness"]["notFound"] = "deleted"
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("different notFound values", str(raised.exception))

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

    def test_defaulted_and_explicit_not_found_do_not_mix(self):
        document = example()
        lists = document["components"]["crudResources"]["taskList"]["collections"]
        lists["archived"] = {"urlTemplate": "/users/me/archived-lists", "x-completeness": {"absent": "removed"}}
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("['archived'] default notFound while another collection states it", str(raised.exception))
        lists["archived"]["x-completeness"]["notFound"] = "unavailable"
        validate(document)

    def test_operation_declaration_does_not_cover_a_fixed_read(self):
        document = example()
        document["components"]["crudResources"]["taskList"]["collections"]["taskLists"].pop("x-completeness")
        document["components"]["crudResources"]["taskList"]["collections"]["taskLists"]["listQuery"] = {"showAll": "true"}
        document["paths"]["/users/me/lists"]["get"]["x-completeness"] = {"absent": "removed", "notFound": "unavailable"}
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("has no collection with x-completeness", str(raised.exception))

    def test_unrecognised_not_found_counts_as_unavailable(self):
        self.assertEqual(self.classify(404, None, {"absent": "removed", "notFound": "purged"}), "unavailable")

    def test_not_found_defaults_to_deleted(self):
        self.assertEqual(self.classify(404, None, {"absent": "removed"}), "deleted")
        self.assertEqual(self.classify(404, None, {"absent": "removed", "notFound": "deleted"}), "deleted")
        self.assertEqual(self.classify(200, {"id": "t1", "deleted": True}, {"absent": "removed"}, None), "present")

    def test_members_of_a_gone_parent(self):
        declaration = completeness(example())
        self.assertEqual(members_of_gone_parent(declaration, "unavailable"), "unavailable")
        # Even a parent concluded deleted only makes its members unavailable in 0.2.0.
        self.assertEqual(members_of_gone_parent(declaration, "deleted"), "unavailable")
        self.assertEqual(members_of_gone_parent(dict(declaration, parentAbsent="cascade"), "deleted"), "unavailable")
        self.assertIsNone(members_of_gone_parent(declaration, "present"))
        self.assertIsNone(members_of_gone_parent(declaration, "unknown"))
        self.assertIsNone(members_of_gone_parent({"absent": "removed"}, "deleted"))

    def test_resource_wide_not_found(self):
        document = example()
        # The task resource states unavailable; a read reached through an undeclared collection uses it.
        document["components"]["crudResources"]["task"]["collections"]["starred"] = {"urlTemplate": "/starred"}
        value = resource_not_found(document, "task")
        self.assertEqual(value, "unavailable")
        self.assertEqual(classify_read(None, TOMBSTONE, "id", "t1", 404, None, value), "unavailable")
        self.assertEqual(classify_read({"absent": "removed"}, TOMBSTONE, "id", "t1", 404, None, value), "unavailable")
        self.assertIsNone(resource_not_found({"components": {"crudResources": {"x": {"collections": {}}}}}, "x"))

    def test_unrecognised_absent_never_yields_the_deleted_default(self):
        # The round-7 probe: a stated notFound is honoured whatever absent says.
        self.assertEqual(classify_read({"absent": "archived", "notFound": "unavailable"}, None, "id", "t1", 404, None), "unavailable")
        self.assertEqual(classify_read({"absent": "archived", "notFound": "deleted"}, None, "id", "t1", 410, None), "deleted")
        self.assertEqual(classify_read({"absent": "archived"}, None, "id", "t1", 404, None), "unavailable")
        self.assertEqual(classify_read({"absent": ["removed"]}, None, "id", "t1", 404, None), "unavailable")
        self.assertIsNone(members_of_gone_parent({"absent": "archived", "parentAbsent": "unavailable"}, "deleted"))
        document = example()
        document["components"]["crudResources"]["task"]["collections"]["listTasks"]["x-completeness"]["absent"] = "archived"
        self.assertEqual(resource_not_found(document, "task"), "unavailable")

    def test_malformed_values_are_errors_not_crashes(self):
        for field, value in (("notFound", ["unavailable"]), ("absent", ["removed"]), ("notFound", {"a": 1})):
            document = example()
            completeness(document)[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate(document)

class GoneTests(unittest.TestCase):
    """0.3.0: gone classifies a 410 separately from a 404."""

    def github_shaped(self):
        document = example()
        for resource, collection in (("task", "listTasks"), ("taskList", "taskLists")):
            completeness(document, resource, collection)["gone"] = "deleted"
        return document

    def test_gone_deleted_with_not_found_unavailable(self):
        document = self.github_shaped()
        validate(document)
        declaration = completeness(document)
        not_found = resource_not_found(document, "task")
        gone = resource_read_value(document, "task", "gone")
        self.assertEqual((not_found, gone), ("unavailable", "deleted"))
        self.assertEqual(classify_read(declaration, None, "id", "t1", 404, None, not_found, gone), "unavailable")
        self.assertEqual(classify_read(declaration, None, "id", "t1", 410, None, not_found, gone), "deleted")
        # Through a collection with no declaration, the resource-wide value still applies.
        self.assertEqual(classify_read(None, None, "id", "t1", 410, None, not_found, gone), "deleted")

    def test_without_gone_a_410_is_classified_like_a_404(self):
        declaration = {"absent": "removed", "notFound": "unavailable"}
        self.assertEqual(classify_read(declaration, None, "id", "t1", 410, None), "unavailable")
        self.assertEqual(classify_read({"absent": "removed"}, None, "id", "t1", 410, None), "deleted")
        self.assertEqual(classify_read(dict(declaration, gone="purged"), None, "id", "t1", 410, None), "unavailable")

    def test_gone_rules(self):
        document = self.github_shaped()
        document["components"]["crudResources"]["task"]["collections"]["starred"] = {
            "urlTemplate": "/starred", "x-completeness": {"absent": "removed", "notFound": "unavailable", "gone": "deleted"}}
        validate(document)
        completeness(document)["gone"] = "unavailable"
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("different gone values", str(raised.exception))
        document = self.github_shaped()
        document["components"]["crudResources"]["task"]["collections"]["starred"] = {
            "urlTemplate": "/starred", "x-completeness": {"absent": "removed", "notFound": "unavailable"}}
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("['starred'] default gone", str(raised.exception))
        for value, fragment in (("later", "gone: expected deleted or unavailable"), (["deleted"], "gone: expected")):
            document = self.github_shaped()
            completeness(document)["gone"] = value
            with self.subTest(value=value), self.assertRaises(ValueError) as raised:
                validate(document)
            self.assertIn(fragment, str(raised.exception))
        document = example()
        completeness(document).pop("notFound")
        completeness(document)["absent"] = "deleted"
        completeness(document)["gone"] = "deleted"
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("gone: not allowed with absent: deleted", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
