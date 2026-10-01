"""Validate this proposal's JSON Schema and checked-in OpenAPI examples."""
import json
import pathlib
import unittest

import jsonschema
import yaml


ROOT = pathlib.Path(__file__).parent
SCHEMA = json.loads((ROOT / "schema.json").read_text())


def example_principal(name, path="/me"):
    document = yaml.safe_load((ROOT / "examples" / name).read_text())
    return document["paths"][path]["get"]["x-authenticated-principal"]


class SchemaTests(unittest.TestCase):
    def test_examples_are_covered_by_the_contract(self):
        for name, path in (("generic.yaml", "/me"), ("google-userinfo.yaml", "/v1/userinfo")):
            jsonschema.validate(example_principal(name, path), SCHEMA)

        overlay = yaml.safe_load((ROOT / "examples" / "generic-overlay.yaml").read_text())
        jsonschema.validate(overlay["actions"][0]["update"]["x-authenticated-principal"], SCHEMA)

    def test_optional_lifecycle_and_escaped_or_root_pointers_are_valid(self):
        base = {"kind": "user", "namespace": "https://identity.example.com", "identifier": {"scope": "provider"}}
        for subject in ("$response.body#", "$response.body#/account~1id"):
            value = dict(base, subject=subject)
            jsonschema.validate(value, SCHEMA)

    def test_rejects_unknown_and_incomplete_identity_metadata(self):
        valid = {"kind": "user", "namespace": "https://identity.example.com", "subject": "$response.body#/id", "identifier": {"scope": "provider", "stable": True, "reassigned": False}}
        for mutate in (
            lambda v: v.update(kind="person"),
            lambda v: v.update(namespace="http://identity.example.com"),
            lambda v: v.update(namespace="https://user@identity.example.com"),
            lambda v: v.update(subject="$request.path.id"),
            lambda v: v.update(subject="$response.body#/id~2"),
            lambda v: v["identifier"].update(scope="tenant"),
        ):
            value = json.loads(json.dumps(valid))
            mutate(value)
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(value, SCHEMA)


if __name__ == "__main__":
    unittest.main()
