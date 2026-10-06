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
from jsonschema import Draft4Validator
from openapi_spec_validator import validate
from openapi_spec_validator.validation.exceptions import OpenAPIValidationError

from generate_identity_catalog_fixtures import ROOT, apply, fetch, merge

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

DIRECTORY = None
VARIANTS = {
    "confluence": "APIs/atlassian.com/confluence-v2/2.0.0/pagination-5e659825c92ed8d1284b63cdc84a94a0c51d7217-overlay.yaml",
    "figma": "APIs/figma.com/0.43.0/pagination-f9b511f8ad2a8c19004af2a38815ab808dd18a98-overlay.yaml",
    "clickup": "APIs/clickup.com/v3/version/pagination-88ea4994e816563201c2069526252475d77e853f-overlay.yaml",
    "slack": "APIs/slack.com/1.7.0/pagination-v2-4d66b23dc5948016b50e79b944a0b084c7000da7-overlay.yaml",
    "digitalocean": "APIs/digitalocean.com/2.0/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml",
    "notion": "APIs/notion.com/2026-03-11/pagination-v2-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml",
    "spotify": "APIs/spotify.com/1.0.0/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml",
    "intercom": "APIs/intercom.com/2.16/pagination-4a302a4352fcb52ab0735f4781376c28913d8028-overlay.yaml",
    "mailchimp": "APIs/mailchimp.com/3.0.91/pagination-b6b0af39fa9d35f81fbea6b7962cc6dea857e889-overlay.yaml",
    "hubspot": "APIs/hubspot.com/crm-owners/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
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


def schema_types(document, schema):
    """Read wire types, including arrays selected by a oneOf/anyOf schema."""
    schema = resolve(document, schema)
    if "type" in schema:
        return {schema["type"]}
    types = set()
    for keyword in ("allOf", "anyOf", "oneOf"):
        for branch in schema.get(keyword, []):
            types.update(schema_types(document, branch))
    return types


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
                    self.assertIn(method, ("get", "post"))
                    self.assertFalse(scheme["autoDetect"])
                    parameters = [resolve(document, p) for p in item.get("parameters", []) + operation.get("parameters", [])]
                    query = {p["name"]: p for p in parameters if p["in"] == "query"}
                    request = scheme["request"]
                    self.assertLessEqual(set(request.get("queryParameters", {})), set(query))
                    for field, metadata in request.get("queryParameters", {}).items():
                        if metadata.get("schema"):
                            self.assertEqual(schema_types(document, query[field]["schema"]), {metadata["schema"]["type"]})
                    if request.get("bodyFields"):
                        body = resolve(document, operation["requestBody"])
                        body_schema = body["content"]["application/json"]["schema"]
                        for field, metadata in request["bodyFields"].items():
                            expected = "integer" if metadata["role"] == "pageSize" else "string"
                            self.assertEqual(field_schema(document, body_schema, field)["type"], expected)
                    response = resolve(document, operation["responses"]["200"])
                    schema = response["content"]["application/json"]["schema"]
                    for field, metadata in scheme["response"].get("bodyFields", {}).items():
                        expected = metadata.get("schema", {}).get("type", "integer" if metadata["role"] == "totalCount" else "string")
                        self.assertEqual(schema_types(document, field_schema(document, schema, field)), {expected})
                    for field, metadata in scheme["response"].get("headers", {}).items():
                        header = resolve(document, response["headers"][field])
                        self.assertEqual(metadata["role"], "nextLink")
                        self.assertEqual(schema_types(document, header["schema"]), {"string"})
                    envelope = scheme["response"]["envelope"]["itemsField"]
                    self.assertEqual(schema_types(document, field_schema(document, schema, envelope)), {"array"})

    def test_api_contract_only_changes_in_documented_schema_enrichments(self):
        for name, (original, document) in self.documents.items():
            with self.subTest(provider=name):
                standard = copy.deepcopy(document)
                standard["components"].pop("paginationSchemes")
                if name != "mailchimp":
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
                if name == "notion":
                    standard["components"]["schemas"].pop("NotionCursorListBody")
                    standard["components"]["requestBodies"].pop("NotionCursorListRequest")
                    for path in ("/search", "/data_sources/{data_source_id}/query"):
                        standard["paths"][path]["post"]["requestBody"] = copy.deepcopy(original["paths"][path]["post"]["requestBody"])
                if name == "spotify":
                    standard["components"]["schemas"].pop("SpotifyPagingCategories")
                    standard["components"]["responses"]["PagedCategories"] = copy.deepcopy(original["components"]["responses"]["PagedCategories"])
                for _, _, _, operation, _ in list(applications(standard)):
                    operation.pop("x-pagination", None)
                self.assertEqual(standard, original)
                if name == "mailchimp":
                    # The source OAD has a boolean default on a string field.
                    # Preserve it: this metadata overlay must not silently
                    # repair unrelated provider request/response contracts.
                    errors = []
                    for source in (original, standard):
                        with self.assertRaises(OpenAPIValidationError) as raised:
                            validate(source)
                        errors.append(raised.exception)
                    self.assertEqual(errors[0].message, "False is not of type 'string'")
                    self.assertEqual(errors[1].message, errors[0].message)
                    self.assertEqual(list(errors[1].absolute_path), list(errors[0].absolute_path))

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


    def test_notion_body_and_query_cursors_have_distinct_locations(self):
        document = self.documents["notion"][1]
        selected = {(path, method): application["scheme"]
                    for path, method, _, _, application in applications(document)}
        self.assertEqual(selected, {
            ("/search", "post"): "bodyCursorPages",
            ("/data_sources/{data_source_id}/query", "post"): "bodyCursorPages",
            ("/views", "get"): "queryCursorPages",
        })
        schemes = document["components"]["paginationSchemes"]
        for name, location in (("bodyCursorPages", "bodyFields"), ("queryCursorPages", "queryParameters")):
            self.assertEqual(set(schemes[name]["request"]), {location})
            self.assertEqual(set(schemes[name]["request"][location]), {"start_cursor", "page_size"})
            self.assertEqual(schemes[name]["response"]["envelope"]["itemsField"], "results")
        self.assertNotIn("x-pagination", document["paths"]["/pages"]["post"])
        self.assertNotIn("x-pagination", document["paths"]["/pages/{page_id}"]["get"])

    def test_notion_body_schema_accepts_filters_and_checks_pagination_types(self):
        document = self.documents["notion"][1]
        for path in ("/search", "/data_sources/{data_source_id}/query"):
            with self.subTest(path=path):
                body = resolve(document, document["paths"][path]["post"]["requestBody"])
                self.assertFalse(body["required"])
                validator = Draft4Validator({
                    "$ref": body["content"]["application/json"]["schema"]["$ref"],
                    "components": document["components"],
                })
                for payload in ({}, {"page_size": 1}, {"page_size": 100}, {
                    "start_cursor": "opaque-next/==", "page_size": 10,
                    "filter": {"property": "Sample", "checkbox": {"equals": True}},
                    "sorts": [{"property": "Sample", "direction": "ascending"}],
                }):
                    self.assertTrue(validator.is_valid(payload), payload)
                for payload in ({"page_size": 0}, {"page_size": 101}, {"page_size": "10"}, {"start_cursor": 123}):
                    self.assertFalse(validator.is_valid(payload), payload)

    def test_spotify_nested_envelopes_and_returned_urls(self):
        document = self.documents["spotify"][1]
        schemes = document["components"]["paginationSchemes"]
        selected = {path: schemes[application["scheme"]]
                    for path, method, _, _, application in applications(document)
                    if method == "get"}
        self.assertEqual(len(selected), 19)
        for path, prefix in {
            "/me/playlists": "", "/browse/categories": "categories.",
            "/browse/featured-playlists": "playlists.", "/browse/new-releases": "albums.",
            "/me/following": "artists.", "/me/player/recently-played": "",
        }.items():
            with self.subTest(path=path):
                scheme = selected[path]
                self.assertEqual(scheme["type"], "nextLink")
                self.assertEqual(scheme["response"]["envelope"]["itemsField"], prefix + "items")
                self.assertEqual(scheme["response"]["bodyFields"], {prefix + "next": {"role": "nextLink"}})
                self.assertEqual(set(scheme["request"]["queryParameters"]), {"limit"})
        # Multiple independent search collections need a consumer selection;
        # recommendations use limit but do not supply a continuation URL.
        for path in ("/search", "/recommendations"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])

    def test_spotify_categories_repair_is_local_to_its_response(self):
        original, document = self.documents["spotify"]
        self.assertEqual(document["components"]["schemas"]["PagingObject"], original["components"]["schemas"]["PagingObject"])
        response = resolve(document, document["paths"]["/browse/categories"]["get"]["responses"]["200"])
        schema = response["content"]["application/json"]["schema"]
        items = field_schema(document, schema, "categories.items")
        self.assertEqual(items["items"]["$ref"], "#/components/schemas/CategoryObject")

    def test_intercom_query_and_nested_body_cursors(self):
        document = self.documents["intercom"][1]
        selected = {(path, method): (application["scheme"], application["overrides"]["response"]["envelope"]["itemsField"])
                    for path, method, _, _, application in applications(document)}
        self.assertEqual(selected, {
            ("/macros", "get"): ("queryCursorPages", "data"),
            ("/conversations", "get"): ("queryCursorPages", "conversations"),
            ("/data_connectors", "get"): ("queryCursorPages", "data"),
            ("/data_connectors/{data_connector_id}/execution_results", "get"): ("queryCursorPages", "data"),
            ("/messages/status", "get"): ("queryCursorPages", "events"),
            ("/contacts/search", "post"): ("bodyCursorPages", "data"),
            ("/conversations/search", "post"): ("bodyCursorPages", "conversations"),
            ("/tickets/search", "post"): ("bodyCursorPages", "tickets"),
        })
        schemes = document["components"]["paginationSchemes"]
        self.assertEqual(schemes["bodyCursorPages"]["request"], {"bodyFields": {
            "pagination.starting_after": {"role": "cursor"}, "pagination.per_page": {"role": "pageSize"},
        }})
        self.assertEqual(set(schemes["queryCursorPages"]["request"]), {"queryParameters"})
        for scheme in schemes.values():
            self.assertEqual(scheme["response"]["bodyFields"], {"pages.next.starting_after": {"role": "nextCursor"}})
        # Contacts omit the request parameters in the source. Company reads
        # and activity-log search use different pagination request shapes.
        for path, method in (("/contacts", "get"), ("/companies", "get"),
                             ("/admins/activity_logs/search", "post"), ("/calls/search", "post")):
            self.assertNotIn("x-pagination", document["paths"][path][method])

    def test_mailchimp_offset_envelopes_and_totals(self):
        document = self.documents["mailchimp"][1]
        selected = {path: application["overrides"]["response"]["envelope"]["itemsField"]
                    for path, _, _, _, application in applications(document)}
        self.assertEqual(len(selected), 56)
        for path, envelope in {
            "/lists": "lists", "/lists/{list_id}/members": "members", "/campaigns": "campaigns",
            "/reports/{campaign_id}/click-details": "urls_clicked", "/ecommerce/stores": "stores",
            "/lists/{list_id}/growth-history": "history", "/reporting/surveys": "surveys",
        }.items():
            self.assertEqual(selected[path], envelope)
        scheme = document["components"]["paginationSchemes"]["offsetPages"]
        self.assertEqual(scheme["type"], "pageNumber")
        self.assertEqual(scheme["request"], {"queryParameters": {
            "offset": {"role": "offset"}, "count": {"role": "pageSize"},
        }})
        self.assertEqual(scheme["response"]["bodyFields"], {"total_items": {"role": "totalCount"}})
        # A cursor collection, a single read with offset/count, a collection
        # lacking total_items, and count without offset are distinct cases.
        for path in ("/audiences/{audience_id}/contacts", "/lists/{list_id}/abuse-reports/{report_id}",
                     "/lists/{list_id}/members/{subscriber_hash}/activity-feed", "/landing-pages"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])

    def test_hubspot_owner_cursor_and_individual_read(self):
        document = self.documents["hubspot"][1]
        selected = [(path, method) for path, method, _, _, _ in applications(document)]
        self.assertEqual(selected, [("/crm/owners/2026-03", "get")])
        scheme = document["components"]["paginationSchemes"]["ownerCursorPages"]
        self.assertEqual(scheme["type"], "pageToken")
        self.assertEqual(scheme["request"], {"queryParameters": {
            "after": {"role": "cursor"}, "limit": {"role": "pageSize"},
        }})
        self.assertEqual(scheme["response"]["bodyFields"], {"paging.next.after": {"role": "nextCursor"}})
        self.assertNotIn("x-pagination", document["paths"]["/crm/owners/2026-03/{ownerId}"]["get"])

    def test_confluence_link_headers_and_collection_scope(self):
        document = self.documents["confluence"][1]
        selected = {(path, method) for path, method, _, _, _ in applications(document)}
        self.assertEqual(len(selected), 67)
        self.assertTrue(all(method == "get" for _, method in selected))
        for path in ("/pages", "/spaces", "/attachments", "/tasks", "/pages/{id}/versions",
                     "/pages/{id}/descendants", "/spaces/{id}/pages", "/inline-comments/{id}/children"):
            self.assertIn((path, "get"), selected)
        scheme = document["components"]["paginationSchemes"]["linkedResults"]
        self.assertEqual(scheme["type"], "nextLink")
        self.assertEqual(scheme["response"], {
            "envelope": {"itemsField": "results"}, "headers": {"Link": {"role": "nextLink"}},
        })
        self.assertEqual(scheme["request"], {"queryParameters": {"limit": {"role": "pageSize"}}})
        # Ancestors have an array and limit but no declared Link header. A
        # single page can include nested collections; neither is a top-level
        # collection served by this scheme.
        for path in ("/pages/{id}/ancestors", "/pages/{id}"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])
        self.assertNotIn("x-pagination", document["paths"]["/pages"]["post"])

    def test_figma_distinct_cursor_types_and_envelopes(self):
        document = self.documents["figma"][1]
        schemes = document["components"]["paginationSchemes"]
        selected = {path: merge(copy.deepcopy(schemes[application["scheme"]]), application.get("overrides", {}))
                    for path, _, _, _, application in applications(document)}
        self.assertEqual(len(selected), 13)
        for collection in ("components", "component_sets", "styles"):
            scheme = selected["/v1/teams/{team_id}/" + collection]
            self.assertEqual(scheme["response"]["envelope"]["itemsField"], "meta." + collection)
            self.assertEqual(scheme["response"]["bodyFields"], {
                "meta.cursor.after": {"role": "nextCursor", "schema": {"type": "number"}},
            })
            self.assertEqual(set(scheme["request"]["queryParameters"]), {"after", "page_size"})
        for path, envelope in {
            "/v1/files/{file_key}/versions": "versions", "/v2/webhooks": "webhooks",
            "/v1/files/{file_key}/comments/{comment_id}/reactions": "reactions",
        }.items():
            scheme = selected[path]
            self.assertEqual(scheme["type"], "nextLink")
            self.assertEqual(scheme["response"]["envelope"]["itemsField"], envelope)
            self.assertEqual(scheme["response"]["bodyFields"], {"pagination.next_page": {"role": "nextLink"}})
        self.assertEqual(selected["/v1/files/{file_key}/versions"]["request"], {
            "queryParameters": {"page_size": {"role": "pageSize"}},
        })
        self.assertEqual(selected["/v1/ai_usage/daily"]["response"], {
            "envelope": {"itemsField": "rows"}, "bodyFields": {"next_cursor": {"role": "nextCursor"}},
        })
        for asset in ("component", "style", "variable"):
            for action in ("actions", "usages"):
                scheme = selected["/v1/analytics/libraries/{file_key}/" + asset + "/" + action]
                self.assertEqual(scheme["response"], {
                    "envelope": {"itemsField": "rows"}, "bodyFields": {"cursor": {"role": "nextCursor"}},
                })
        # Activity logs lack a declared cursor request field in this OAD.
        # File components return a complete array without a page cursor.
        for path in ("/v1/activity_logs", "/v1/files/{file_key}/components", "/v1/files/{file_key}/comments"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])

    def test_clickup_v3_cursor_scope_and_docs_parameter(self):
        document = self.documents["clickup"][1]
        selected = {path: application["overrides"]["response"]["envelope"]["itemsField"]
                    for path, _, _, _, application in applications(document)}
        base = "/api/v3/workspaces/{workspace_id}"
        self.assertEqual(selected, {
            base + "/chat/channels": "data",
            base + "/chat/channels/{channel_id}/followers": "data",
            base + "/chat/channels/{channel_id}/members": "data",
            base + "/chat/channels/{channel_id}/messages": "data",
            base + "/chat/messages/{message_id}/reactions": "data",
            base + "/chat/messages/{message_id}/replies": "data",
            base + "/chat/messages/{message_id}/tagged_users": "data",
            base + "/{entity_type}/{entity_id}/attachments": "data",
            base + "/docs": "docs",
        })
        scheme = document["components"]["paginationSchemes"]["cursorPages"]
        self.assertEqual(scheme["request"], {"queryParameters": {
            "cursor": {"role": "cursor"}, "limit": {"role": "pageSize"},
        }})
        self.assertEqual(scheme["response"]["bodyFields"], {"next_cursor": {"role": "nextCursor"}})
        self.assertNotIn("next_cursor", scheme["request"]["queryParameters"])
        self.assertNotIn("x-pagination", document["paths"][base + "/docs/{doc_id}"]["get"])
        self.assertNotIn("x-pagination", document["paths"][base + "/chat/channels/{channel_id}/messages"]["post"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
