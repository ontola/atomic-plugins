"""Produced Classes 0.1.0-draft: rules 1-6 and the catalog fallback."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import absolute_uri, validate, validate_selection

ROOT = pathlib.Path(__file__).parent
EXAMPLE = yaml.safe_load((ROOT / "examples" / "time-entries.yaml").read_text(encoding="utf-8"))


def example():
    return copy.deepcopy(EXAMPLE)


def produces(document):
    return document["components"]["crudResources"]["timeEntry"]["x-produces"]


class ValidationTests(unittest.TestCase):
    def invalid(self, mutate, fragment):
        document = example()
        mutate(document)
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_example_is_valid(self):
        validate(example())

    def test_example_is_valid_openapi_without_the_extension_members(self):
        document = example()
        document["components"].pop("crudResources")
        for item in document["paths"].values():
            for operation in item.values():
                if isinstance(operation, dict):
                    operation.pop("x-crud", None)
        validate_openapi(document)

    def test_a_document_without_the_extension_is_valid(self):
        validate({"openapi": "3.0.3", "paths": {}})
        document = example()
        for resource in document["components"]["crudResources"].values():
            resource.pop("x-produces")
        validate(document)

    def test_rule_1_only_on_a_resource_object(self):
        entry = [{"class": "https://ontology.example/classes/a"}]
        self.invalid(
            lambda d: d["components"]["crudResources"]["timeEntry"]["collections"]["entries"].update({"x-produces": entry}),
            "components.crudResources.timeEntry.collections.entries.x-produces: x-produces is allowed only",
        )
        self.invalid(lambda d: d["paths"]["/time-entries"]["get"].update({"x-produces": entry}), "paths./time-entries.get.x-produces")
        self.invalid(lambda d: d.update({"x-produces": entry}), "x-produces: x-produces is allowed only")
        self.invalid(lambda d: d["components"].update({"x-produces": entry}), "components.x-produces")

    def test_rule_1_swagger_root_resources(self):
        document = {"swagger": "2.0", "x-crudResources": {"item": {"x-produces": [{"class": "https://o.example/c"}]}}}
        validate(document)
        document["x-crudResources"]["item"]["x-produces"] = []
        with self.assertRaises(ValueError):
            validate(document)

    def test_rule_2_nonempty_array(self):
        self.invalid(lambda d: d["components"]["crudResources"]["timeEntry"].update({"x-produces": []}), "nonempty array")
        self.invalid(
            lambda d: d["components"]["crudResources"]["timeEntry"].update({"x-produces": {"class": "https://o.example/c"}}),
            "nonempty array",
        )

    def test_rule_3_fields(self):
        self.invalid(lambda d: produces(d)[0].pop("class"), "x-produces[0]: class is required")
        self.invalid(lambda d: produces(d)[0].update({"fields": {}}), "x-produces[0].fields: unknown field")
        self.invalid(lambda d: produces(d).append("https://o.example/c"), "x-produces[1]: expected an object")
        document = example()
        produces(document)[0]["x-note"] = {"anything": True}
        validate(document)

    def test_rule_4_absolute_uris(self):
        for bad in ["time-entry-v1", "/classes/time-entry-v1", "https://", "https:///path", "https://a b", "", 7, None]:
            with self.subTest(bad=bad):
                self.invalid(lambda d: produces(d)[0].update({"class": bad}), "x-produces[0].class: expected an absolute URI")
        self.invalid(lambda d: produces(d)[0].update({"lens": "lenses/x"}), "x-produces[0].lens: expected an absolute URI")
        for good in ["https://o.example/c", "http://o.example/c#Thing", "urn:example:c", "did:web:o.example"]:
            with self.subTest(good=good):
                self.assertTrue(absolute_uri(good))

    def test_rule_5_unique_classes(self):
        self.invalid(lambda d: produces(d).append({"class": produces(d)[0]["class"]}), "x-produces[1].class: https://ontology.example/classes/time-entry-v1 appears twice")

    def test_rule_6_description(self):
        self.invalid(lambda d: produces(d)[0].update({"description": ["no"]}), "x-produces[0].description: expected a string")

    def test_every_violation_is_reported(self):
        document = example()
        produces(document)[0]["class"] = "relative"
        document["paths"]["/projects"]["get"]["x-produces"] = []
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertEqual(len(str(raised.exception).splitlines()), 2)


class SelectionTests(unittest.TestCase):
    def test_a_selection_without_the_field_is_valid(self):
        validate_selection({"query_overrides": []}, example())
        validate_selection({}, example())

    def test_a_valid_fallback(self):
        validate_selection({"x-produces": {"project": [{"class": "https://o.example/c"}]}}, example())

    def test_unknown_resource_and_bad_entries(self):
        with self.assertRaises(ValueError) as raised:
            validate_selection({"x-produces": {"invoice": [{"class": "nope"}]}}, example())
        message = str(raised.exception)
        self.assertIn("selection.x-produces.invoice: no such CRUD resource", message)
        self.assertIn("selection.x-produces.invoice[0].class: expected an absolute URI", message)
        for bad in [[], {}, "https://o.example/c"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_selection({"x-produces": bad}, example())


if __name__ == "__main__":
    unittest.main()
