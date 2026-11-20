import copy
import json
from pathlib import Path
import unittest

from validate import validate


def document():
    return json.loads((Path(__file__).parent / "examples/work-records.json").read_text())


class MetadataTests(unittest.TestCase):
    def test_all_worked_examples(self):
        for path in (Path(__file__).parent / "examples").glob("*.json"):
            with self.subTest(path=path.name):
                validate(json.loads(path.read_text()))

    def test_explicit_object_and_discriminated_targets(self):
        doc = document()
        entries = doc["components"]["crudResources"]["issue"]["x-embeddedResources"]
        entries["user"] = {
            "representation": "object", "cardinality": "one",
            "discriminator": {"field": "kind", "mapping": {"Person": "person", "Label": "label"}},
        }
        entries["labels"]["representation"] = "object"
        validate(doc)

    def test_identity_reference_uses_source_bindings_and_composite_target(self):
        doc = document()
        source = doc["components"]["crudResources"]["issue"]
        source["references"] = {"labelById": {
            "resource": "label", "bindings": {"labelId": {"field": "label_id"}},
        }}
        source["x-embeddedResources"] = {"label_id": {
            "representation": "identity", "cardinality": "one", "reference": "labelById",
        }}
        validate(doc)  # owner/repo are inherited context, never source guesses.
        source["references"]["labelById"]["bindings"]["wrong"] = {"field": "id"}
        with self.assertRaisesRegex(ValueError, "not an identity template variable"):
            validate(doc)

    def test_reference_requires_explicit_bindings_even_when_context_only(self):
        doc = document()
        source = doc["components"]["crudResources"]["issue"]
        source["references"] = {"personRef": {"resource": "person", "bindings": {}}}
        source["x-embeddedResources"] = {"person_id": {
            "representation": "identity", "cardinality": "one", "reference": "personRef",
        }}
        validate(doc)
        for bindings in [None, [], "id"]:
            with self.subTest(bindings=bindings):
                source["references"]["personRef"]["bindings"] = bindings
                with self.assertRaisesRegex(ValueError, "bindings must be an object"):
                    validate(doc)
        del source["references"]["personRef"]["bindings"]
        with self.assertRaisesRegex(ValueError, "bindings must be an object"):
            validate(doc)

    def test_new_variants_fail_closed_on_ambiguous_or_unsupported_metadata(self):
        entries = [
            {"representation": "guessed", "resource": "person", "cardinality": "one"},
            {"representation": "identity", "reference": "missing", "cardinality": "one"},
            {"representation": "identity", "reference": "personRef", "cardinality": "many"},
            {"representation": "identity", "reference": "personRef", "resource": "person", "cardinality": "one"},
            {"representation": "object", "reference": "personRef", "resource": "person", "cardinality": "one"},
            {"resource": "person", "discriminator": {"field": "kind", "mapping": {"Person": "person"}}, "cardinality": "one"},
            {"discriminator": {"field": "kind", "mapping": {}}, "cardinality": "one"},
            {"discriminator": {"field": "kind..bad", "mapping": {"Person": "person"}}, "cardinality": "one"},
            {"discriminator": {"field": "kind", "mapping": {"Person": "missing"}}, "cardinality": "one"},
            {"discriminator": {"field": "kind", "mapping": {"": "person"}}, "cardinality": "one"},
            {"discriminator": {"field": "kind", "mapping": {"Person": "person"}, "fallback": "person"}, "cardinality": "one"},
        ]
        for entry in entries:
            with self.subTest(entry=entry):
                doc = document()
                source = doc["components"]["crudResources"]["issue"]
                source["references"] = {"personRef": {"resource": "person", "bindings": {"personId": {"field": "user_id"}}}}
                source["x-embeddedResources"] = {"user": entry}
                with self.assertRaises(ValueError):
                    validate(doc)

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
