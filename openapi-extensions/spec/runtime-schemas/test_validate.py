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
        warnings = []
        validate(document, warnings)
        self.assertEqual(len(warnings), 1)
        self.assertIn("races renames", warnings[0])

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

    def test_malformed_references_or_path_items_do_not_crash(self):
        document = example()
        document["components"]["crudResources"]["row"]["references"] = ["table"]
        self.assertInvalid(document, "has no 'table'")
        document = example()
        document["paths"]["/tables/{tableId}"] = "not a path item"
        self.assertInvalid(document, "has no get operation")
        document = example()
        document["components"]["crudResources"]["table"]["identity"] = "nope"
        warnings = []
        validate(document, warnings)
        self.assertEqual(len(warnings), 1)

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

    def test_wrong_option_shapes_are_invalid_not_values(self):
        # Review of #398: no sentinel stored as a value, no iterating a dict's keys.
        derived = derive_class(self.runtime, TABLE)
        for stage, tags in (({"name": "Doing"}, [{"id": "tag-1"}]),          # option ref without an id
                            ("opt-1", [{"id": "tag-1"}]),                    # not an object
                            ({"id": "opt-1"}, {"id": "tag-1"}),              # multiple, but not an array
                            ({"id": "opt-1"}, [{"id": "tag-1"}, {"x": 1}]),  # one ref without an id
                            ({"id": "opt-1"}, [{"id": 7}])):                 # an id that is not a string
            row = copy.deepcopy(ROW)
            row["properties"]["Stage"]["select"] = stage
            row["properties"]["Tags"]["multi_select"] = tags
            with self.subTest(stage=stage, tags=tags):
                result = read_members(self.runtime, derived, row)
                for value in result["values"].values():
                    self.assertIsInstance(value, (int, float, str, list, type(None)))
                expected = [k for k, bad in (("Stage", not isinstance(stage, dict) or "id" not in stage),
                                             ("Tags", tags != [{"id": "tag-1"}])) if bad]
                self.assertEqual(result["invalid"], expected)
                for key, identifier in (("Stage", "c%3Ad"), ("Tags", "e%3Af")):
                    if key in expected:
                        self.assertNotIn(identifier, result["values"])

    def test_member_without_value_path_has_no_value(self):
        row = copy.deepcopy(ROW)
        del row["properties"]["Estimate"]["number"]
        result = read_members(self.runtime, derive_class(self.runtime, TABLE), row)
        self.assertNotIn("a%3Ab", result["values"])
        self.assertEqual((result["unmatched"], result["invalid"]), ([], []))

    def test_duplicate_definition_ids_get_no_property(self):
        table = copy.deepcopy(TABLE)
        table["properties"]["Copy"] = dict(table["properties"]["Estimate"], name="Copy")
        derived = derive_class(self.runtime, table)
        self.assertEqual(derived["duplicates"], ["a%3Ab"])
        self.assertNotIn("a%3Ab", derived["properties"])
        result = read_members(self.runtime, derived, ROW)
        self.assertNotIn("a%3Ab", result["values"])
        self.assertIn("Estimate", result["undescribed"])

    def test_no_describer_gives_an_empty_class(self):
        # A reference that identifies no describer (absent parent, 404): no class (§5.5).
        derived = derive_class(self.runtime, {})
        self.assertEqual((derived["properties"], derived["undescribed"], derived["duplicates"]), ({}, [], []))
        result = read_members(self.runtime, derived, ROW)
        self.assertEqual(result["values"], {})
        self.assertEqual(sorted(result["unmatched"]), ["Due", "Estimate", "Stage", "Tags"])

    def test_option_without_a_name_is_kept_with_none(self):
        # Review of #398: no MISSING sentinel as an option name.
        table = copy.deepcopy(TABLE)
        table["properties"]["Stage"]["select"]["options"].append({"id": "opt-3"})
        options = derive_class(self.runtime, table)["properties"]["c%3Ad"]["options"]
        self.assertIsNone(options["opt-3"])
        self.assertEqual(options["opt-1"], "Doing")

    def test_duplicate_option_ids_keep_the_first_and_are_reported(self):
        table = copy.deepcopy(TABLE)
        table["properties"]["Stage"]["select"]["options"].append({"id": "opt-1", "name": "Again"})
        derived = derive_class(self.runtime, table)
        self.assertEqual(derived["properties"]["c%3Ad"]["options"]["opt-1"], "Doing")
        self.assertEqual(derived["duplicateOptions"], {"c%3Ad": ["opt-1"]})

    def test_two_members_matching_one_definition_conflict(self):
        row = copy.deepcopy(ROW)
        row["properties"]["Old estimate"] = {"id": "a%3Ab", "type": "number", "number": 5}
        result = read_members(self.runtime, derive_class(self.runtime, TABLE), row)
        self.assertEqual(sorted(result["conflicting"]), ["Estimate", "Old estimate"])
        self.assertNotIn("a%3Ab", result["values"])

    def test_key_matching_by_name_reports_undescribed_and_duplicate_names(self):
        runtime = dict(self.runtime, match="key")
        del runtime["memberId"]
        del runtime["memberType"]
        result = read_members(runtime, derive_class(runtime, TABLE), ROW)
        # Due is a formula: undescribed, not unmatched, so no needless describer re-read.
        self.assertEqual(result["undescribed"], ["Due"])
        self.assertEqual(result["unmatched"], [])
        runtime["describedBy"] = dict(runtime["describedBy"], shape="array")
        table = {"properties": [{"id": "x1", "name": "Points", "type": "number"},
                                {"id": "x2", "name": "Points", "type": "number"}]}
        derived = derive_class(runtime, table)
        self.assertEqual(derived["duplicateNames"], ["Points"])
        result = read_members(runtime, derived, {"properties": {"Points": {"number": 3}}})
        self.assertEqual((result["unmatched"], result["values"]), (["Points"], {}))

    def test_repeated_id_with_another_name_is_undescribed_under_key_matching(self):
        runtime = dict(self.runtime, match="key")
        del runtime["memberId"]
        del runtime["memberType"]
        runtime["describedBy"] = dict(runtime["describedBy"], shape="array")
        table = {"properties": [{"id": "x1", "name": "Points", "type": "number"},
                                {"id": "x1", "name": "Score", "type": "number"}]}
        derived = derive_class(runtime, table)
        self.assertEqual(derived["duplicates"], ["x1"])
        result = read_members(runtime, derived, {"properties": {"Points": {"number": 1}, "Score": {"number": 2}}})
        self.assertEqual(sorted(result["undescribed"]), ["Points", "Score"])
        self.assertEqual(result["unmatched"], [])

    def test_a_name_that_is_not_a_string_does_not_crash(self):
        table = copy.deepcopy(TABLE)
        table["properties"]["Estimate"]["name"] = {"text": "Estimate"}
        derived = derive_class(self.runtime, table)
        self.assertEqual(derived["properties"]["a%3Ab"]["name"], "Estimate")  # the map key
        self.assertEqual(read_members(self.runtime, derived, ROW)["values"]["a%3Ab"], 3)

    def test_member_id_that_is_not_a_string_is_invalid(self):
        derived = derive_class(self.runtime, TABLE)
        for value in ({"nested": "a%3Ab"}, ["a%3Ab"], 7):
            row = copy.deepcopy(ROW)
            row["properties"]["Estimate"]["id"] = value
            with self.subTest(value=value):
                result = read_members(self.runtime, derived, row)
                self.assertEqual(result["invalid"], ["Estimate"])
                self.assertNotIn("a%3Ab", result["values"])

    def test_option_name_that_is_not_a_string_is_no_name(self):
        table = copy.deepcopy(TABLE)
        table["properties"]["Stage"]["select"]["options"].append({"id": "opt-3", "name": {"text": "Later"}})
        self.assertIsNone(derive_class(self.runtime, table)["properties"]["c%3Ad"]["options"]["opt-3"])

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
        self.assertEqual(result, {"values": {"f1": "Ada"}, "unmatched": ["f9"], "undescribed": ["f2"], "invalid": [], "conflicting": []})


if __name__ == "__main__":
    unittest.main()
