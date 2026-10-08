"""Runtime Schemas 0.1.0-draft: schema, document validator, example and member reading."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import derive_class, read_members, segments, validate

ROOT = pathlib.Path(__file__).parent


def example():
    return yaml.safe_load((ROOT / "examples" / "user-defined-columns.yaml").read_text(encoding="utf-8"))


TABLE = {
    "id": "t1",
    "properties": {
        "Estimate": {"id": "a%3Ab", "name": "Estimate", "type": "number", "number": {}},
        "Stage": {"id": "c%3Ad", "name": "Stage", "type": "select", "select": {"options": [
            {"id": "opt-1", "name": "Doing", "color": "blue"},
            {"id": "opt-2", "name": "Done", "color": "green"}]}},
        "Tags": {"id": "e%3Af", "name": "Tags", "type": "multi_select", "multi_select": {"options": [
            {"id": "tag-1", "name": "urgent", "color": "red"}]}},
        "Due": {"id": "g%3Ah", "name": "Due", "type": "formula", "formula": {"expression": "now()"}},
    },
}

ROW = {
    "id": "r1",
    "parent": {"table_id": "t1"},
    "properties": {
        "Estimate": {"id": "a%3Ab", "type": "number", "number": 3},
        "Stage": {"id": "c%3Ad", "type": "select", "select": {"id": "opt-1", "name": "Doing", "color": "blue"}},
        "Tags": {"id": "e%3Af", "type": "multi_select", "multi_select": [{"id": "tag-1", "name": "urgent"}]},
        "Due": {"id": "g%3Ah", "type": "formula", "formula": {"type": "string", "string": "x"}},
    },
}


class ExampleTests(unittest.TestCase):
    def test_example_passes_the_validator(self):
        warnings = []
        validate(example(), warnings)
        self.assertEqual(warnings, [])

    def test_example_is_valid_openapi_without_the_extension_member(self):
        document = example()
        document["components"].pop("crudResources")
        validate_openapi(document)


class SchemaTests(unittest.TestCase):
    def runtime(self, document):
        return document["components"]["crudResources"]["row"]["x-runtime-schema"]

    def assertInvalid(self, document, fragment="x-runtime-schema"):
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_required_fields(self):
        for key in ("field", "keyedBy", "match", "describedBy", "definition", "types"):
            document = example()
            del self.runtime(document)[key]
            with self.subTest(key=key):
                self.assertInvalid(document)
        for key in ("reference", "definitions", "shape"):
            document = example()
            del self.runtime(document)["describedBy"][key]
            with self.subTest(key=key):
                self.assertInvalid(document)
        for key in ("id", "type"):
            document = example()
            del self.runtime(document)["definition"][key]
            with self.subTest(key=key):
                self.assertInvalid(document)

    def test_enumerations_and_unknown_members(self):
        for mutate in (lambda r: r.update(keyedBy="label"), lambda r: r.update(match="name"),
                       lambda r: r["describedBy"].update(shape="list"), lambda r: r.update(writable=True),
                       lambda r: r.update(types={})):
            document = example()
            mutate(self.runtime(document))
            self.assertInvalid(document)
        document = example()
        self.runtime(document)["x-note"] = "extension members are allowed"
        validate(document)

    def test_member_id_required_for_id_matching(self):
        document = example()
        del self.runtime(document)["memberId"]
        self.assertInvalid(document)
        self.runtime(document)["match"] = "key"
        validate(document)

    def test_type_and_options_rules(self):
        for mutate in (lambda t: t["number"].pop("value"), lambda t: t["number"].pop("schema"),
                       lambda t: t["number"].update(multiple=True), lambda t: t["select"]["options"].pop("valueId"),
                       lambda t: t["select"]["options"].pop("field"), lambda t: t["number"].update(schema="number")):
            document = example()
            mutate(self.runtime(document)["types"])
            self.assertInvalid(document)

    def test_dot_paths(self):
        for path in ("", ".a", "a.", "a..b", '["a.b"', "a[0]"):
            document = example()
            self.runtime(document)["field"] = path
            with self.subTest(path=path):
                self.assertInvalid(document)
        document = example()
        self.runtime(document)["field"] = 'data.["user.fields"].values'
        validate(document)
        self.runtime(document)["field"] = 'data["user.fields"].values'
        self.assertInvalid(document)
        self.runtime(document)["field"] = "properties"
        self.assertEqual(segments('data.["user.fields"].values'), ["data", "user.fields", "values"])
        self.runtime(document)["types"]["number"]["value"] = ""
        validate(document)

    def test_reference_must_exist_and_name_a_resource(self):
        document = example()
        self.runtime(document)["describedBy"]["reference"] = "missing"
        self.assertInvalid(document, "has no 'missing'")
        document = example()
        document["components"]["crudResources"]["row"]["references"]["table"]["resource"] = "nothing"
        self.assertInvalid(document, "is not a crudResources key")

    def test_describer_read_operation(self):
        document = example()
        document["paths"]["/tables/{tableId}"]["post"] = document["paths"]["/tables/{tableId}"].pop("get")
        self.assertInvalid(document, "has no get operation")
        document = example()
        del document["paths"]["/tables/{tableId}"]
        warnings = []
        validate(document, warnings)
        self.assertEqual(len(warnings), 1)

    def test_only_on_crud_resources(self):
        document = example()
        document["paths"]["/rows/{rowId}"]["get"]["x-runtime-schema"] = copy.deepcopy(self.runtime(document))
        self.assertInvalid(document, "allowed only on a CRUD Resource Object")
        document = example()
        document["components"]["schemas"]["Row"]["x-runtime-schema"] = {}
        self.assertInvalid(document, "allowed only on a CRUD Resource Object")
        document = example()
        document["components"]["crudResources"]["row"]["collections"]["rows"]["x-runtime-schema"] = {}
        self.assertInvalid(document, "allowed only on a CRUD Resource Object")


class ReadingTests(unittest.TestCase):
    def setUp(self):
        self.runtime = example()["components"]["crudResources"]["row"]["x-runtime-schema"]

    def test_derive_class_keys_by_id_and_skips_undescribed_types(self):
        derived = derive_class(self.runtime, TABLE)
        self.assertEqual(set(derived["properties"]), {"a%3Ab", "c%3Ad", "e%3Af"})
        self.assertEqual(derived["undescribed"], ["g%3Ah"])
        stage = derived["properties"]["c%3Ad"]
        self.assertEqual((stage["name"], stage["type"], stage["multiple"]), ("Stage", "select", False))
        self.assertEqual(stage["options"], {"opt-1": "Doing", "opt-2": "Done"})
        self.assertTrue(derived["properties"]["e%3Af"]["multiple"])

    def test_read_members(self):
        result = read_members(self.runtime, derive_class(self.runtime, TABLE), ROW)
        self.assertEqual(result["values"], {"a%3Ab": 3, "c%3Ad": "opt-1", "e%3Af": ["tag-1"]})
        self.assertEqual(result["undescribed"], ["Due"])
        self.assertEqual(result["unmatched"], [])

    def test_rename_keeps_the_property_and_its_values(self):
        table = copy.deepcopy(TABLE)
        table["properties"]["Points"] = table["properties"].pop("Estimate")
        table["properties"]["Points"]["name"] = "Points"
        row = copy.deepcopy(ROW)
        row["properties"]["Points"] = row["properties"].pop("Estimate")
        derived = derive_class(self.runtime, table)
        self.assertEqual(derived["properties"]["a%3Ab"]["name"], "Points")
        self.assertEqual(read_members(self.runtime, derived, row)["values"]["a%3Ab"], 3)
        # A row read before the rename, under the old key, still matches by id.
        self.assertEqual(read_members(self.runtime, derived, ROW)["values"]["a%3Ab"], 3)

    def test_unknown_member_is_unmatched_not_guessed(self):
        row = copy.deepcopy(ROW)
        row["properties"]["New"] = {"id": "z%3Az", "type": "number", "number": 1}
        result = read_members(self.runtime, derive_class(self.runtime, TABLE), row)
        self.assertEqual(result["unmatched"], ["New"])
        self.assertNotIn("z%3Az", result["values"])

    def test_retyped_definition_leaves_old_members_unmatched(self):
        table = copy.deepcopy(TABLE)
        table["properties"]["Estimate"]["type"] = "checkbox"
        result = read_members(self.runtime, derive_class(self.runtime, table), ROW)
        self.assertIn("Estimate", result["unmatched"])
        self.assertNotIn("a%3Ab", result["values"])

    def test_absent_member_is_no_value_and_null_select_stays_null(self):
        row = copy.deepcopy(ROW)
        del row["properties"]["Estimate"]
        row["properties"]["Stage"]["select"] = None
        values = read_members(self.runtime, derive_class(self.runtime, TABLE), row)["values"]
        self.assertNotIn("a%3Ab", values)
        self.assertIsNone(values["c%3Ad"])

    def test_removed_option_is_kept_as_its_id(self):
        table = copy.deepcopy(TABLE)
        table["properties"]["Stage"]["select"]["options"] = [{"id": "opt-2", "name": "Done"}]
        values = read_members(self.runtime, derive_class(self.runtime, table), ROW)["values"]
        self.assertEqual(values["c%3Ad"], "opt-1")

    def test_array_definitions_and_key_matching(self):
        runtime = {
            "field": "fields", "keyedBy": "id", "match": "key",
            "describedBy": {"reference": "form", "definitions": "fields", "shape": "array"},
            "definition": {"id": "id", "name": "label", "type": "kind"},
            "types": {"text": {"value": "", "schema": {"type": "string"}}},
        }
        form = {"fields": [{"id": "f1", "label": "Name", "kind": "text"}, {"id": "f2", "label": "Photo", "kind": "file"}]}
        derived = derive_class(runtime, form)
        self.assertEqual(derived["properties"]["f1"]["name"], "Name")
        result = read_members(runtime, derived, {"fields": {"f1": "Ada", "f2": "x.png", "f9": "?"}})
        self.assertEqual(result, {"values": {"f1": "Ada"}, "unmatched": ["f9"], "undescribed": ["f2"]})


if __name__ == "__main__":
    unittest.main()
