import copy
import json
from pathlib import Path
import unittest

from validate import validate


def document():
    return json.loads((Path(__file__).parent / "examples/work-records.json").read_text())


class MetadataTests(unittest.TestCase):
    def test_invented_document_and_empty_declaration(self):
        doc = document()
        validate(doc)
        doc["components"]["crudResources"]["issue"]["x-embeddedResources"] = {}
        validate(doc)

    def test_schema_refs_have_no_resource_semantics(self):
        doc = document()
        del doc["components"]["crudResources"]["issue"]["x-embeddedResources"]
        validate(doc)
        doc["components"]["crudResources"]["issue"]["x-embeddedResources"] = {
            "user": {"resource": "PersonShape", "cardinality": "one"}
        }
        with self.assertRaisesRegex(ValueError, "declared CRUD resource"):
            validate(doc)

    def test_malformed_extensions(self):
        for raw in [None, [], True, {"user": None},
                    {"user": {"resource": "person", "cardinality": "some"}},
                    {"user": {"resource": "person", "cardinality": "one", "nameField": "name"}}]:
            with self.subTest(raw=raw):
                doc = document()
                doc["components"]["crudResources"]["issue"]["x-embeddedResources"] = raw
                with self.assertRaises(ValueError):
                    validate(doc)

    def test_source_paths(self):
        for field in ["", ".user", "user..name", "user[0]", " user", "user.\nname"]:
            with self.subTest(field=field):
                doc = document()
                doc["components"]["crudResources"]["issue"]["x-embeddedResources"] = {
                    field: {"resource": "person", "cardinality": "one"}
                }
                with self.assertRaisesRegex(ValueError, "dot-path"):
                    validate(doc)

    def test_overlapping_source_paths(self):
        doc = document()
        embedded = doc["components"]["crudResources"]["issue"]["x-embeddedResources"]
        embedded["user.details"] = copy.deepcopy(embedded["user"])
        with self.assertRaisesRegex(ValueError, "overlapping source"):
            validate(doc)

    def test_target_schema_and_identity_required(self):
        for field in ["schema", "identity"]:
            with self.subTest(field=field):
                doc = document()
                del doc["components"]["crudResources"]["person"][field]
                with self.assertRaises(ValueError):
                    validate(doc)

    def test_unresolved_or_cyclic_shape_refs(self):
        for ref in ["#/components/schemas/Missing", "https://example.invalid/shape", "#/components/crudResources/person/schema"]:
            with self.subTest(ref=ref):
                doc = document()
                doc["components"]["crudResources"]["person"]["schema"] = {"$ref": ref}
                with self.assertRaisesRegex(ValueError, "resolvable object schema"):
                    validate(doc)

    def test_target_requires_object_shape(self):
        for schema in [{"type": "string", "properties": {}}, {"type": "object", "properties": []}, True, {}]:
            with self.subTest(schema=schema):
                doc = document()
                doc["components"]["crudResources"]["person"]["schema"] = schema
                with self.assertRaisesRegex(ValueError, "resolvable object schema"):
                    validate(doc)

    def test_identity_metadata(self):
        cases = [
            {"urlTemplate": "https://example.invalid/{id}", "bindings": {"id": {"field": "id"}}},
            {"urlTemplate": "/\\example.invalid/{id}", "bindings": {"id": {"field": "id"}}},
            {"urlTemplate": "/people/{id}", "bindings": {"id": {"field": "id..bad"}}},
            {"urlTemplate": "/people/{id}", "bindings": {"wrong": {"field": "id"}}},
            {"urlTemplate": "/people/{id}", "bindings": []},
            {"urlTemplate": "/people/{__proto__}"},
            {"urlTemplate": "/people/{unclosed"},
        ]
        for identity in cases:
            with self.subTest(identity=identity):
                doc = document()
                doc["components"]["crudResources"]["person"]["identity"] = identity
                with self.assertRaises(ValueError):
                    validate(doc)

    def test_misplacement_but_not_named_schema_properties_or_examples(self):
        doc = document()
        doc["x-embeddedResources"] = {}
        with self.assertRaisesRegex(ValueError, "only on a CRUD Resource Object"):
            validate(doc)
        del doc["x-embeddedResources"]
        doc["components"]["schemas"]["PersonShape"]["properties"]["x-embeddedResources"] = {"type": "string"}
        doc["components"]["schemas"]["PersonShape"]["example"] = {"x-embeddedResources": "ordinary data"}
        validate(doc)


if __name__ == "__main__":
    unittest.main()
