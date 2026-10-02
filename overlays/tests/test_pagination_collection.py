"""Check reviewed standalone pagination variants against their exact source OADs.

Use --directory for a full-history openapi-directory checkout; otherwise the
same full-SHA source URLs are downloaded. No provider credentials are used.
"""
import argparse
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import unquote

import yaml
from openapi_spec_validator import validate

from generate_identity_catalog_fixtures import ROOT, apply, fetch, merge

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

DIRECTORY = None
VARIANTS = {
    "slack": "APIs/slack.com/1.7.0/pagination-v2-4d66b23dc5948016b50e79b944a0b084c7000da7-overlay.yaml",
    "digitalocean": "APIs/digitalocean.com/2.0/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml",
}


def resolve(document, value):
    seen = set()
    while "$ref" in value:
        reference = value["$ref"]
        if not reference.startswith("#/") or reference in seen:
            raise ValueError(f"Unsupported or cyclic reference: {reference}")
        seen.add(reference)
        value = document
        for key in unquote(reference[2:]).split("/"):
            value = value[int(key) if isinstance(value, list) else key.replace("~1", "/").replace("~0", "~")]
    return value


def properties(document, schema):
    """Find declared fields across the response's schema alternatives."""
    schema = resolve(document, schema)
    fields = dict(schema.get("properties", {}))
    for keyword in ("allOf", "anyOf", "oneOf"):
        for branch in schema.get(keyword, []):
            fields.update(properties(document, branch))
    return fields


def field_schema(document, schema, dotted_path):
    for key in dotted_path.split("."):
        schema = properties(document, schema)[key]
    return resolve(document, schema)


def applications(document):
    for path, item in document["paths"].items():
        for method in ("get", "post", "put", "patch", "delete", "head", "options"):
            operation = item.get(method, {})
            for application in operation.get("x-pagination", []):
                yield path, method, item, operation, application


class PaginationCollectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.documents = {}
        with tempfile.TemporaryDirectory() as cache:
            for name, relative in VARIANTS.items():
                path = ROOT / relative
                url, sha, source = overlay_pin(path)
                if DIRECTORY:
                    raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", sha + ":" + source])
                else:
                    raw, _ = fetch(url, Path(cache))
                original = yaml.safe_load(raw)
                composed = copy.deepcopy(original)
                apply(composed, yaml.safe_load(path.read_text()))
                cls.documents[name] = (original, composed)

    def test_all_declared_fields_exist_in_pinned_operation_schemas(self):
        for name, (_, document) in self.documents.items():
            schemes = document["components"]["paginationSchemes"]
            for path, method, item, operation, application in applications(document):
                with self.subTest(provider=name, path=path, method=method):
                    scheme = merge(copy.deepcopy(schemes[application["scheme"]]), application.get("overrides", {}))
                    self.assertEqual(method, "get")
                    self.assertFalse(scheme["autoDetect"])
                    parameters = [resolve(document, p) for p in item.get("parameters", []) + operation.get("parameters", [])]
                    query = {p["name"] for p in parameters if p["in"] == "query"}
                    self.assertLessEqual(set(scheme["request"]["queryParameters"]), query)
                    response = resolve(document, operation["responses"]["200"])
                    schema = response["content"]["application/json"]["schema"]
                    for field, metadata in scheme["response"]["bodyFields"].items():
                        expected = "integer" if metadata["role"] == "totalCount" else "string"
                        self.assertEqual(field_schema(document, schema, field)["type"], expected)
                    envelope = scheme["response"]["envelope"]["itemsField"]
                    self.assertEqual(field_schema(document, schema, envelope)["type"], "array")

    def test_api_contract_only_changes_in_documented_metadata_repair(self):
        for name, (original, document) in self.documents.items():
            with self.subTest(provider=name):
                standard = copy.deepcopy(document)
                standard["components"].pop("paginationSchemes")
                validate(standard)
                if name == "slack":
                    # Only users.list's malformed metadata reference is repaired;
                    # all other schemas, parameters, operations and security stay.
                    repaired = standard["components"]["schemas"].pop("slackCursorResponseMetadata")
                    self.assertEqual(repaired["type"], "object")
                    self.assertTrue(repaired["properties"]["next_cursor"]["nullable"])
                    response = standard["paths"]["/users.list"]["get"]["responses"]["200"]
                    source = original["paths"]["/users.list"]["get"]["responses"]["200"]
                    response["content"]["application/json"]["schema"]["properties"]["response_metadata"] = copy.deepcopy(
                        source["content"]["application/json"]["schema"]["properties"]["response_metadata"]
                    )
                for _, _, _, operation, _ in list(applications(standard)):
                    operation.pop("x-pagination", None)
                self.assertEqual(standard, original)

    def test_slack_envelopes_and_explicit_cursor_scope(self):
        document = self.documents["slack"][1]
        selected = {path: application["overrides"]["response"]["envelope"]["itemsField"]
                    for path, _, _, _, application in applications(document)}
        self.assertEqual(selected, {
            "/conversations.list": "channels", "/conversations.members": "members",
            "/users.conversations": "channels", "/users.list": "members",
        })
        scheme = document["components"]["paginationSchemes"]["cursorPages"]
        self.assertEqual(scheme["type"], "pageToken")
        self.assertEqual(scheme["response"]["bodyFields"], {
            "response_metadata.next_cursor": {"role": "nextCursor"},
        })
        # These use classic pagination or have no declared cursor response in
        # this OAD. A shared limit parameter must not opt them into this scheme.
        for path in ("/search.messages", "/files.list", "/conversations.history", "/conversations.replies"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])

    def test_digitalocean_links_and_collection_scope(self):
        document = self.documents["digitalocean"][1]
        selected = {path: application["overrides"]["response"]["envelope"]["itemsField"]
                    for path, _, _, _, application in applications(document)}
        self.assertEqual(len(selected), 39)
        self.assertEqual(selected["/v2/droplets"], "droplets")
        self.assertEqual(selected["/v2/projects/{project_id}/resources"], "resources")
        self.assertEqual(selected["/v2/registry/{registry_name}/repositoriesV2"], "repositories")
        scheme = document["components"]["paginationSchemes"]["linkedPages"]
        self.assertEqual(scheme["type"], "nextLink")
        self.assertEqual(scheme["response"]["bodyFields"]["links.pages.next"]["role"], "nextLink")
        self.assertEqual(set(scheme["response"]["bodyFields"]), {"links.pages.next", "meta.total"})
        self.assertNotIn("page", scheme["request"]["queryParameters"])
        # The source OAD lists page/per_page even on this individual read;
        # request parameters alone must not turn it into a paged collection.
        for path in ("/v2/volumes/{volume_id}/actions/{action_id}", "/v2/registry/{registry_name}/garbage-collections"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
