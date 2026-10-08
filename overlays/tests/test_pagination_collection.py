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
from referencing.exceptions import PointerToNowhere

from generate_identity_catalog_fixtures import ROOT, apply, fetch, merge

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import overlay_pin

DIRECTORY = None
VARIANTS = {
    "hubspot_pages": "APIs/hubspot.com/pages/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_url-redirects": "APIs/hubspot.com/url-redirects/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_user-provisioning": "APIs/hubspot.com/user-provisioning/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_events": "APIs/hubspot.com/events/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_audit-logs": "APIs/hubspot.com/audit-logs/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_sequences": "APIs/hubspot.com/sequences/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_marketing-emails": "APIs/hubspot.com/marketing-emails/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_multicurrency": "APIs/hubspot.com/multicurrency/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_marketing-events": "APIs/hubspot.com/marketing-events/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_campaigns-public-api": "APIs/hubspot.com/campaigns-public-api/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_custom-objects": "APIs/hubspot.com/custom-objects/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_imports": "APIs/hubspot.com/imports/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "google_directory": "APIs/googleapis.com/admin/directory_v1/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml",
    "google_reports": "APIs/googleapis.com/admin/reports_v1/pagination-5e5d2369ea3e91b9b09193dd9928f628612369d3-overlay.yaml",
    "google_vault": "APIs/googleapis.com/vault/v1/pagination-98a453ea8cce0b5723f2f95d376720c304632d23-overlay.yaml",
    "google_drivelabels": "APIs/googleapis.com/drivelabels/v2/pagination-v2-98a453ea8cce0b5723f2f95d376720c304632d23-overlay.yaml",
    "google_businessinfo": "APIs/googleapis.com/mybusinessbusinessinformation/v1/pagination-v2-a68633bd9b84af444f424d6a03f24450b84129ef-overlay.yaml",
    "google_chat": "APIs/googleapis.com/chat/v1/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml",
    "google_classroom": "APIs/googleapis.com/classroom/v1/pagination-v2-780ef441b8d6134229c8b8ef75eb3ec8a0218e7f-overlay.yaml",
    "google_calendar": "APIs/googleapis.com/calendar/v3/pagination-v2-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml",
    "google_blogger": "APIs/googleapis.com/blogger/v3/pagination-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml",
    "google_driveactivity": "APIs/googleapis.com/driveactivity/v2/pagination-2fd9a6a4cccac6dbc988c98fc12bf8b0732015f4-overlay.yaml",
    "google_forms": "APIs/googleapis.com/forms/v1/pagination-v2-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml",
    "google_keep": "APIs/googleapis.com/keep/v1/pagination-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml",
    "google_books": "APIs/googleapis.com/books/v1/pagination-v2-7418a665c934a78c5ef05e66a35d21d6dda87c62-overlay.yaml",
    "box": "APIs/box.com/2026.0/pagination-84d76796923210d5e972c22c22f834a061290fbd-overlay.yaml",
    "github": "APIs/github.com/api.github.com.2022-11-28/1.1.4/pagination-7782419eb8c981c9dd28379e41a43ca3186f4758-overlay.yaml",
    "twilio_conversations": "APIs/twilio.com/twilio_conversations_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml",
    "twilio_messaging": "APIs/twilio.com/twilio_messaging_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml",
    "clockify": "APIs/clockify.me/1.0.0-readonly/pagination-v2-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml",
    "twilio_accounts": "APIs/twilio.com/twilio_accounts_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml",
    "google_drive": "APIs/googleapis.com/drive/v3/pagination-v2-a7dd2d8b4f5f50794e51afd84c539c2e61a182fc-overlay.yaml",
    "google_gmail": "APIs/googleapis.com/gmail/v1/pagination-f34c235dd04bee41b091108dd52c07d1415a54b9-overlay.yaml",
    "google_people": "APIs/googleapis.com/people/v1/pagination-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml",
    "google_tasks": "APIs/googleapis.com/tasks/v1/pagination-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml",
    "google_youtube": "APIs/googleapis.com/youtube/v3/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml",
    "google_storage": "APIs/googleapis.com/storage/v1/pagination-f29c692c20956b05daf223ad8f641e9a9bd6dfb4-overlay.yaml",
    'asana': 'APIs/asana.com/1.0/pagination-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml',
    'zendesk': 'APIs/zendesk.com/support/2.0.0/pagination-bd4e4a2d9aa77933be201b08f290ccc4fbdf6bc8-overlay.yaml',
    'squareup': 'APIs/squareup.com/2.0/pagination-v2-e15e761285c715a9035dee558ff40c8f3bd3f796-overlay.yaml',
    'zoom': 'APIs/zoom.us/meetings/2/pagination-a0a144cfdcb49bbfdc01459d6ca012dcf01307f1-overlay.yaml',
    'mastodon': 'APIs/mastodon.local/1.0/pagination-d8048ab7bf03d49cfc766ce25e7b955f415d5d87-overlay.yaml',
    "hubspot_files": "APIs/hubspot.com/files/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_hubdb": "APIs/hubspot.com/hubdb/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_posts": "APIs/hubspot.com/posts/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_conversations": "APIs/hubspot.com/conversations/v3/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
    "hubspot_lists": "APIs/hubspot.com/lists/v3/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml",
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


def missing_local_references(document):
    """Inventory every dangling local reference, including its exact location."""
    missing = {}

    def visit(value, path):
        if isinstance(value, dict):
            reference = value.get("$ref", "")
            if reference.startswith("#/"):
                try:
                    resolve(document, {"$ref": reference})
                except KeyError:
                    missing.setdefault(reference, []).append(path)
            for key, child in value.items():
                visit(child, path + (key,))
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, path + (index,))

    visit(document, ())
    return missing


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


def json_response_schema(response):
    """Keep the OAD's original media key, including HubSpot's wildcard JSON bodies."""
    content = response["content"]
    return content["application/json" if "application/json" in content else "*/*"]["schema"]


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
                    schema = json_response_schema(response)
                    for field, metadata in scheme.get("response", {}).get("bodyFields", {}).items():
                        expected = metadata.get("schema", {}).get("type", "integer" if metadata["role"] == "totalCount" else "string")
                        self.assertEqual(schema_types(document, field_schema(document, schema, field)), {expected})
                    for field, metadata in scheme.get("response", {}).get("headers", {}).items():
                        header = resolve(document, response["headers"][field])
                        self.assertEqual(metadata["role"], "nextLink")
                        self.assertEqual(schema_types(document, header["schema"]), {"string"})
                    envelope = scheme.get("response", {}).get("envelope", {}).get("itemsField")
                    items_schema = field_schema(document, schema, envelope) if envelope else schema
                    self.assertEqual(schema_types(document, items_schema), {"array"})

    def test_api_contract_only_changes_in_documented_schema_enrichments(self):
        for name, (original, document) in self.documents.items():
            with self.subTest(provider=name):
                standard = copy.deepcopy(document)
                standard["components"].pop("paginationSchemes")
                if name not in ("mailchimp", "hubspot_hubdb", "squareup"):
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
                if name == "mastodon":
                    # Add only the six documented Link headers absent from the
                    # pinned source; bodies, parameters and security stay intact.
                    for path, _, _, _, _ in applications(standard):
                        response = standard["paths"][path]["get"]["responses"]["200"]
                        source = original["paths"][path]["get"]["responses"]["200"]
                        self.assertNotIn("headers", source)
                        self.assertEqual(set(response.pop("headers")), {"Link"})
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
                if name == "hubspot_hubdb":
                    # Two source item schemas point to an absent component.
                    # Check this exact baseline failure on both documents;
                    # the complete standard contract equality above ensures
                    # metadata introduces no new API-schema change.
                    for source in (original, standard):
                        self.assertNotIn("HubDbTableRowV3Wrapper", source["components"]["schemas"])
                        for collection in ("RandomAccessCollectionResponseWithTotalHubDbTableRowV3",
                                           "StreamingCollectionResponseWithTotalHubDbTableRowV3"):
                            items = source["components"]["schemas"][collection]["properties"]["results"]["items"]
                            self.assertEqual(items, {"$ref": "#/components/schemas/HubDbTableRowV3Wrapper"})
                        with self.assertRaises(PointerToNowhere) as raised:
                            validate(source)
                        self.assertEqual(raised.exception.ref, "/components/schemas/HubDbTableRowV3Wrapper")
                if name == "squareup":
                    # The pinned source omits two payment schema components.
                    # Assert all five dangling references and the same validator
                    # failure, rather than accepting arbitrary source errors.
                    expected = {
                        "#/components/schemas/AppFeeAllocation": [
                            ("components", "schemas", schema, "properties", "app_fee_allocations", "items")
                            for schema in ("CreatePaymentRequest", "Payment", "PaymentRefund", "RefundPaymentRequest")
                        ],
                        "#/components/schemas/CurrencyExchange": [
                            ("components", "schemas", "Payment", "properties", "buyer_currency_exchange")
                        ],
                    }
                    for source in (original, standard):
                        self.assertEqual(missing_local_references(source), expected)
                        with self.assertRaises(PointerToNowhere) as raised:
                            validate(source)
                        self.assertEqual(raised.exception.ref, "/components/schemas/AppFeeAllocation")

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

    def test_hubspot_service_collections_and_optional_totals(self):
        expected = {
            "files": {"/files/2026-03/files/search", "/files/2026-03/folders/search"},
            "hubdb": {"/cms/hubdb/2026-03/tables", "/cms/hubdb/2026-03/tables/draft",
                      "/cms/hubdb/2026-03/tables/{tableIdOrName}/rows", "/cms/hubdb/2026-03/tables/{tableIdOrName}/rows/draft"},
            "posts": {"/cms/blogs/2026-03/posts", "/cms/blogs/2026-03/posts/{objectId}/revisions"},
            "conversations": {"/conversations/v3/conversations/" + suffix for suffix in (
                "channel-accounts", "channels", "inboxes", "threads", "threads/{threadId}/messages")},
            "lists": {"/crm/v3/lists/{listId}/memberships", "/crm/v3/lists/{listId}/memberships/join-order"},
        }
        for service, paths in expected.items():
            with self.subTest(service=service):
                document = self.documents["hubspot_" + service][1]
                selected = list(applications(document))
                self.assertEqual({(path, method) for path, method, _, _, _ in selected}, {(path, "get") for path in paths})
                scheme = document["components"]["paginationSchemes"]["cursorResults"]
                self.assertEqual(scheme["request"], {"queryParameters": {"after": {"role": "cursor"}, "limit": {"role": "pageSize"}}})
                self.assertEqual(scheme["response"], {"envelope": {"itemsField": "results"}, "bodyFields": {"paging.next.after": {"role": "nextCursor"}}})
                for path, _, _, operation, application in selected:
                    response = resolve(document, operation["responses"]["200"])
                    schema = json_response_schema(response)
                    fields = merge(copy.deepcopy(scheme), application.get("overrides", {}))["response"]["bodyFields"]
                    # Totals are metadata only where the operation declares them;
                    # thread/message reads and Files must not inherit a total.
                    has_total = service in ("hubdb", "posts", "lists") or (
                        service == "conversations" and path.rsplit("/", 1)[-1] in ("channel-accounts", "channels", "inboxes"))
                    self.assertEqual("total" in fields, has_total)
                    self.assertEqual("total" in properties(document, schema), has_total)
                    if has_total:
                        self.assertEqual(fields["total"], {"role": "totalCount"})
        posts = self.documents["hubspot_posts"][1]
        for path, item in posts["paths"].items():
            if "/cursor" in path:
                self.assertNotIn("x-pagination", item.get("get", {}))
        # The provider's timestamp ordering is a separate traversal mode.
        conversations = self.documents["hubspot_conversations"][1]
        thread = conversations["paths"]["/conversations/v3/conversations/threads"]["get"]["x-pagination"][0]
        self.assertIn("sort=id", thread["description"])
        self.assertIn("outside this scheme", thread["description"])
        self.assertNotIn("x-pagination", self.documents["hubspot_lists"][1]["paths"]["/crm/v3/lists/search"]["post"])

    def test_hubspot_posts_keep_original_wildcard_media(self):
        original, composed = self.documents["hubspot_posts"]
        for path in ("/cms/blogs/2026-03/posts", "/cms/blogs/2026-03/posts/{objectId}/revisions"):
            original_response = original["paths"][path]["get"]["responses"]["200"]
            response = composed["paths"][path]["get"]["responses"]["200"]
            self.assertEqual(response, original_response)
            self.assertEqual(set(response["content"]), {"*/*"})

    def test_asana_cursor_mode_excludes_audit_stream(self):
        document = self.documents["asana"][1]
        selected = {(p, m) for p, m, _, _, _ in applications(document)}
        self.assertEqual(len(selected), 64)
        self.assertTrue(all(m == "get" for _, m in selected))
        for p in ("/tasks", "/projects", "/projects/{project_gid}/tasks", "/tasks/{task_gid}/dependencies", "/workspaces"):
            self.assertIn((p, "get"), selected)
        scheme = document["components"]["paginationSchemes"]["cursorData"]
        self.assertEqual(scheme["request"]["queryParameters"], {"offset": {"role": "cursor"}, "limit": {"role": "pageSize", "required": True}})
        self.assertEqual(scheme["response"], {"envelope": {"itemsField": "data"}, "bodyFields": {"next_page.offset": {"role": "nextCursor"}}})
        # Unlike ordinary lists, audit logs can keep returning a next page
        # on an empty result. An ordinary cursor's terminal rule is unsuitable.
        self.assertNotIn("x-pagination", document["paths"]["/workspaces/{workspace_gid}/audit_log_events"]["get"])
        self.assertNotIn("x-pagination", document["paths"]["/tasks/{task_gid}"]["get"])

    def test_zendesk_offset_links_exclude_exports_and_sideloaded_arrays(self):
        document = self.documents["zendesk"][1]
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual(len(selected), 14)
        activities = selected["/api/v2/activities"]
        self.assertEqual(activities["overrides"]["response"]["envelope"], {"itemsField": "activities"})
        self.assertEqual(document["components"]["paginationSchemes"]["linkedCollections"]["response"]["bodyFields"], {"next_page": {"role": "nextLink"}})
        for path, _, item, operation, _ in applications(document):
            query = {resolve(document, p)["name"] for p in item.get("parameters", []) + operation.get("parameters", [])}
            self.assertTrue({"page", "per_page"} & query)
            self.assertNotIn("/incremental/", path)
        for path in ("/api/v2/incremental/tickets", "/api/v2/routing/agents/instance_values", "/api/v2/views/show_many"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])

    def test_square_query_body_and_integer_merchant_cursors(self):
        document = self.documents["squareup"][1]
        selected = {(p, m): a for p, m, _, _, a in applications(document)}
        self.assertEqual(len(selected), 69)
        for path, method, _, _, application in applications(document):
            self.assertEqual(application["scheme"], "merchantCursor" if path == "/v2/merchants" else "queryCursor" if method == "get" else "bodyCursor")
        schemes = document["components"]["paginationSchemes"]
        self.assertEqual(schemes["queryCursor"]["request"], {"queryParameters": {"cursor": {"role": "cursor"}}})
        self.assertEqual(schemes["bodyCursor"]["request"], {"bodyFields": {"cursor": {"role": "cursor"}}})
        self.assertEqual(schemes["merchantCursor"]["response"], {"envelope": {"itemsField": "merchant"}, "bodyFields": {"cursor": {"role": "nextCursor", "schema": {"type": "integer"}}}})
        for path, envelope in {"/v2/catalog/search": "objects", "/v2/catalog/search-catalog-items": "items", "/v2/events": "events", "/v2/customers/search": "customers"}.items():
            self.assertEqual(selected[(path, "post")]["overrides"]["response"]["envelope"], {"itemsField": envelope})
        # Orders may return orders or order_entries depending on the request;
        # neither errors nor sideloaded references are the primary page.
        self.assertNotIn("x-pagination", document["paths"]["/v2/orders/search"]["post"])
        self.assertNotIn("x-pagination", document["paths"]["/v2/payments"]["post"])
        self.assertNotIn("x-pagination", document["paths"]["/v2/customers"]["post"])

    def test_zoom_tokens_envelopes_and_date_range_limit(self):
        document = self.documents["zoom"][1]
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual(len(selected), 29)
        scheme = document["components"]["paginationSchemes"]["tokenCollections"]
        self.assertEqual(set(scheme["request"]["queryParameters"]), {"next_page_token", "page_size"})
        for path, envelope in {"/users/{userId}/meetings": "meetings", "/devices": "devices", "/past_meetings/{meetingId}/participants": "participants", "/report/operationlogs": "operation_logs"}.items():
            self.assertEqual(selected[path]["overrides"]["response"]["envelope"], {"itemsField": envelope})
        self.assertIn("response to value", selected["/archive_files"]["description"])
        self.assertNotIn("x-pagination", document["paths"]["/past_meetings/{meetingUUID}/archive_files"]["get"])

    def test_mastodon_link_header_enrichment_and_root_arrays(self):
        original, document = self.documents["mastodon"]
        selected = {(p, m) for p, m, _, _, _ in applications(document)}
        self.assertEqual(selected, {(p, "get") for p in ("/api/v1/accounts/{id}/followers", "/api/v1/accounts/{id}/following", "/api/v1/blocks", "/api/v1/mutes", "/api/v1/bookmarks", "/api/v1/favourites")})
        scheme = document["components"]["paginationSchemes"]["linkedArrays"]
        self.assertEqual(scheme["response"], {"headers": {"Link": {"role": "nextLink"}}})
        for path, _ in selected:
            response = document["paths"][path]["get"]["responses"]["200"]
            source = original["paths"][path]["get"]["responses"]["200"]
            self.assertEqual(response["content"], source["content"])
            self.assertEqual(response["headers"]["Link"]["schema"], {"type": "string"})
        for path in ("/api/v1/accounts/relationships", "/api/v1/directory", "/api/v1/instance/peers"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])

    def test_google_pages_keep_sync_checkpoints_and_estimates_separate(self):
        for service in ("drive", "gmail", "people", "tasks", "youtube", "storage"):
            with self.subTest(service=service):
                document = self.documents["google_" + service][1]
                scheme = document["components"]["paginationSchemes"]["forwardPages"]
                self.assertFalse(scheme["autoDetect"])
                self.assertEqual(scheme["request"], {"queryParameters": {"pageToken": {"role": "cursor"}}})
                self.assertIn("short or empty", scheme["description"])
                for _, method, _, _, application in applications(document):
                    self.assertEqual(method, "get")
                    effective = merge(copy.deepcopy(scheme), application["overrides"])
                    # Neither a future-sync checkpoint nor an estimated total
                    # determines continuation within this listing.
                    self.assertEqual(effective["response"]["bodyFields"], {"nextPageToken": {"role": "nextCursor"}})
                    self.assertIn(set(effective["request"]["queryParameters"]),
                                  ({"pageToken", "pageSize"}, {"pageToken", "maxResults"}))

    def test_google_drive_projections_and_ordinary_collection_scope(self):
        document = self.documents["google_drive"][1]
        selected = {p: a for p, _, _, _, a in applications(document)}
        expected = {"/drives": "drives", "/files": "files", "/files/{fileId}/comments": "comments",
                    "/files/{fileId}/comments/{commentId}/replies": "replies", "/files/{fileId}/listLabels": "labels",
                    "/files/{fileId}/permissions": "permissions", "/files/{fileId}/revisions": "revisions"}
        self.assertEqual({p: a["overrides"]["response"]["envelope"]["itemsField"] for p, a in selected.items()}, expected)
        for path in ("/files/{fileId}/comments", "/files/{fileId}/comments/{commentId}/replies"):
            self.assertIn("fields query is required", selected[path]["description"])
            self.assertIn("nextPageToken", selected[path]["description"])
        self.assertEqual(selected["/files/{fileId}/listLabels"]["overrides"]["request"],
                         {"queryParameters": {"maxResults": {"role": "pageSize"}}})
        for path, method in (("/changes", "get"), ("/changes/watch", "post"),
                             ("/teamdrives", "get"), ("/files/{fileId}", "get")):
            self.assertNotIn("x-pagination", document["paths"][path][method])

    def test_google_gmail_collection_envelopes_exclude_history(self):
        document = self.documents["google_gmail"][1]
        base = "/gmail/v1/users/{userId}/"
        expected = {base + suffix: envelope for suffix, envelope in {
            "drafts": "drafts", "messages": "messages", "threads": "threads",
            "settings/cse/identities": "cseIdentities", "settings/cse/keypairs": "cseKeyPairs",
        }.items()}
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual({p: a["overrides"]["response"]["envelope"]["itemsField"] for p, a in selected.items()}, expected)
        for path, app in selected.items():
            size = "pageSize" if "/settings/cse/" in path else "maxResults"
            self.assertEqual(app["overrides"]["request"], {"queryParameters": {size: {"role": "pageSize"}}})
        self.assertNotIn("x-pagination", document["paths"][base + "history"]["get"])
        self.assertNotIn("x-pagination", document["paths"][base + "watch"]["post"])

    def test_google_people_full_lists_keep_masks_and_sync_modes(self):
        original, document = self.documents["google_people"]
        expected = {"/v1/contactGroups": "contactGroups", "/v1/otherContacts": "otherContacts",
                    "/v1/people:listDirectoryPeople": "people", "/v1/people:searchDirectoryPeople": "people",
                    "/v1/{resourceName}/connections": "connections"}
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual({p: a["overrides"]["response"]["envelope"]["itemsField"] for p, a in selected.items()}, expected)
        for path, app in selected.items():
            self.assertIn("omit syncToken", app["description"])
            self.assertIn("nextSyncToken", app["description"])
            self.assertEqual(document["paths"][path]["get"]["parameters"], original["paths"][path]["get"]["parameters"])
        # Contact search returns one bounded result set, not this page mode.
        self.assertNotIn("x-pagination", document["paths"]["/v1/people:searchContacts"]["get"])

    def test_google_tasks_list_scope_preserves_completion_filters(self):
        original, document = self.documents["google_tasks"]
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual(set(selected), {"/tasks/v1/lists/{tasklist}/tasks", "/tasks/v1/users/@me/lists"})
        for app in selected.values():
            self.assertEqual(app["overrides"]["response"]["envelope"], {"itemsField": "items"})
        path = "/tasks/v1/lists/{tasklist}/tasks"
        self.assertEqual(document["paths"][path]["get"]["parameters"], original["paths"][path]["get"]["parameters"])
        description = document["components"]["paginationSchemes"]["forwardPages"]["description"]
        for flag in ("showCompleted", "showHidden", "showDeleted"):
            self.assertIn(flag, description)
        self.assertNotIn("x-pagination", document["paths"][path]["post"])

    def test_google_youtube_collection_modes_exclude_streams_and_id_batches(self):
        document = self.documents["google_youtube"][1]
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual(set(selected), {"/youtube/v3/" + suffix for suffix in
                                        ("playlistItems", "playlists", "subscriptions", "commentThreads", "comments", "search")})
        self.assertIn("parentId only", selected["/youtube/v3/comments"]["description"])
        for resource in ("comments", "commentThreads"):
            self.assertIn("unsupported with id", selected["/youtube/v3/" + resource]["description"])
        for app in selected.values():
            self.assertEqual(app["overrides"]["response"]["envelope"], {"itemsField": "items"})
        for resource in ("liveChat/messages", "members", "videoCategories", "videos"):
            self.assertNotIn("x-pagination", document["paths"]["/youtube/v3/" + resource]["get"])

    def test_google_storage_flat_objects_and_schema_doc_disagreements(self):
        document = self.documents["google_storage"][1]
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual({p: a["overrides"]["response"]["envelope"]["itemsField"] for p, a in selected.items()}, {
            "/b": "items", "/b/{bucket}/o": "items", "/b/{bucket}/operations": "operations",
            "/projects/{projectId}/hmacKeys": "items",
        })
        self.assertIn("omit delimiter", selected["/b/{bucket}/o"]["description"])
        self.assertIn("prefixes", selected["/b/{bucket}/o"]["description"])
        self.assertEqual(selected["/b/{bucket}/operations"]["overrides"]["request"],
                         {"queryParameters": {"pageSize": {"role": "pageSize"}}})
        # Folder docs say maxResults while the pin says pageSize; cache docs
        # omit pagination inputs. Preserve these routes for a separate review.
        for resource in ("folders", "managedFolders", "anywhereCaches"):
            self.assertNotIn("x-pagination", document["paths"]["/b/{bucket}/" + resource]["get"])
        self.assertNotIn("x-pagination", document["paths"]["/b/{bucket}/o/watch"]["post"])

    def test_box_query_body_and_workflow_query_markers_remain_distinct(self):
        original, document = self.documents["box"]
        selected = {(p, m): a for p, m, _, _, a in applications(document)}
        self.assertEqual(selected, {("/automate_workflows", "get"): {"scheme": "queryMarker"},
                                    ("/query", "post"): {"scheme": "bodyMarker"}})
        schemes = document["components"]["paginationSchemes"]
        for name, location in (("queryMarker", "queryParameters"), ("bodyMarker", "bodyFields")):
            self.assertEqual(schemes[name]["request"], {location: {"marker": {"role": "cursor"}, "limit": {"role": "pageSize"}}})
            self.assertEqual(schemes[name]["response"], {"envelope": {"itemsField": "entries"},
                                                       "bodyFields": {"next_marker": {"role": "nextCursor"}}})
        self.assertEqual(document["components"]["parameters"]["BoxVersionHeader"],
                         original["components"]["parameters"]["BoxVersionHeader"])
        self.assertEqual(document["components"]["schemas"]["QueryRequestBody"], original["components"]["schemas"]["QueryRequestBody"])
        for path in ("/automate_workflows/{workflow_id}/start", "/notes/convert", "/query_insights"):
            self.assertNotIn("x-pagination", document["paths"][path]["post"])

    def test_github_link_headers_preserve_versioned_root_arrays(self):
        document = self.documents["github"][1]
        selected = {(p, m) for p, m, _, _, _ in applications(document)}
        paths = {"/repos/{owner}/{repo}/issues", "/repos/{owner}/{repo}/pulls", "/repos/{owner}/{repo}/issues/comments",
                 "/repos/{owner}/{repo}/labels", "/repos/{owner}/{repo}/milestones", "/users/{username}/repos",
                 "/user/repos", "/orgs/{org}/repos"}
        self.assertEqual(selected, {(p, "get") for p in paths})
        scheme = document["components"]["paginationSchemes"]["linkedArrays"]
        self.assertEqual(scheme["response"], {"headers": {"Link": {"role": "nextLink"}}})
        self.assertEqual(scheme["request"], {"queryParameters": {"per_page": {"role": "pageSize"}}})
        self.assertIn("X-GitHub-Api-Version: 2022-11-28", scheme["description"])
        # Search is a separate object envelope, not an array at the root.
        self.assertNotIn("x-pagination", document["paths"]["/search/issues"]["get"])
        self.assertNotIn("x-pagination", document["paths"]["/repos/{owner}/{repo}/issues/{issue_number}"]["get"])
        self.assertNotIn("x-pagination", document["paths"]["/repos/{owner}/{repo}/issues"]["post"])

    def test_twilio_modern_link_transports_and_get_only_scope(self):
        expected = {"twilio_conversations": 22, "twilio_messaging": 9, "twilio_accounts": 2}
        for name, count in expected.items():
            with self.subTest(service=name):
                document = self.documents[name][1]
                selected = list(applications(document))
                self.assertEqual(len(selected), count)
                scheme = document["components"]["paginationSchemes"]["linkedCollections"]
                field = "meta.next_page_url"
                self.assertEqual(scheme["type"], "nextLink")
                self.assertEqual(scheme["request"], {"queryParameters": {"PageSize": {"role": "pageSize"}}})
                self.assertEqual(scheme["response"], {"bodyFields": {field: {"role": "nextLink"}}})
                for _, method, item, op, _ in selected:
                    self.assertEqual(method, "get")
                    params = {resolve(document, p)["name"]: resolve(document, p) for p in
                              item.get("parameters", []) + op.get("parameters", [])}
                    self.assertEqual(schema_types(document, params["PageSize"]["schema"]), {"integer"})
                    response = resolve(document, op["responses"]["200"])
                    self.assertTrue(field_schema(document, json_response_schema(response), field)["nullable"])
                for item in document["paths"].values():
                    for method in ("post", "put", "patch", "delete"):
                        self.assertNotIn("x-pagination", item.get(method, {}))

    def test_twilio_modern_envelopes_and_credential_list_scope(self):
        expected = {
            "twilio_conversations": {"/v1/Conversations": "conversations", "/v1/Conversations/{ConversationSid}/Messages": "messages",
                                     "/v1/Conversations/{ConversationSid}/Participants": "participants"},
            "twilio_messaging": {"/v1/Services": "services", "/v1/Services/{ServiceSid}/PhoneNumbers": "phone_numbers"},
            "twilio_accounts": {"/v1/Credentials/AWS": "credentials", "/v1/Credentials/PublicKeys": "credentials"},
        }
        for name, envelopes in expected.items():
            with self.subTest(service=name):
                document = self.documents[name][1]
                selected = {p: a["overrides"]["response"]["envelope"]["itemsField"]
                            for p, _, _, _, a in applications(document)}
                for path, envelope in envelopes.items():
                    self.assertEqual(selected[path], envelope)
        document = self.documents["twilio_accounts"][1]
        for resource in ("AWS", "PublicKeys"):
            self.assertNotIn("x-pagination", document["paths"]["/v1/Credentials/" + resource + "/{Sid}"]["get"])

    def test_clockify_paging_targets_only_the_declared_root_array(self):
        original, document = self.documents["clockify"]
        path = "/v1/workspaces/{workspaceId}/user/{userId}/time-entries"
        self.assertEqual({(p, m) for p, m, _, _, _ in applications(document)}, {(path, "get")})
        scheme = document["components"]["paginationSchemes"]["timeEntryPages"]
        self.assertEqual(scheme["type"], "pageNumber")
        self.assertEqual(scheme["request"], {"queryParameters": {"page": {"role": "page"}, "page-size": {"role": "pageSize"}}})
        self.assertNotIn("response", scheme)
        self.assertEqual(json_response_schema(document["paths"][path]["get"]["responses"]["200"])["type"], "array")
        params = document["components"]["parameters"]
        for name, default in (("Page", 1), ("PageSize", 50)):
            self.assertEqual(params[name]["schema"], {"type": "integer", "minimum": 1, "default": default})
        self.assertEqual(params, original["components"]["parameters"])
        self.assertEqual(document["security"], original["security"])
        self.assertNotIn("x-pagination", document["paths"]["/v1/workspaces/{workspaceId}/time-entries/{id}"]["get"])
        for resource in ("projects", "users"):
            self.assertNotIn("/v1/workspaces/{workspaceId}/" + resource, document["paths"])


    def test_google_workspace_forward_pages_keep_scopes_and_methods(self):
        expected = {"chat": 4, "classroom": 12, "calendar": 5, "blogger": 5,
                    "driveactivity": 1, "forms": 1, "keep": 1}
        for service, count in expected.items():
            with self.subTest(service=service):
                document = self.documents["google_" + service][1]
                selected = list(applications(document))
                self.assertEqual(len(selected), count)
                scheme = document["components"]["paginationSchemes"]["forwardPages"]
                self.assertEqual(scheme["response"], {"bodyFields": {"nextPageToken": {"role": "nextCursor"}}})
                self.assertIn("not when a page is short or empty", scheme["description"])
                location = "bodyFields" if service == "driveactivity" else "queryParameters"
                self.assertEqual(scheme["request"], {location: {"pageToken": {"role": "cursor"}}})
                for _, method, _, _, _ in selected:
                    self.assertEqual(method, "post" if service == "driveactivity" else "get")
                for path, item in document["paths"].items():
                    for method in ("post", "put", "patch", "delete"):
                        if service == "driveactivity" and path == "/v2/activity:query" and method == "post":
                            continue
                        self.assertNotIn("x-pagination", item.get(method, {}))

    def test_google_chat_root_collections_have_distinct_envelopes(self):
        document = self.documents["google_chat"][1]
        selected = {p: a["overrides"]["response"]["envelope"]["itemsField"] for p, _, _, _, a in applications(document)}
        self.assertEqual(selected, {"/v1/spaces": "spaces", "/v1/{parent}/members": "memberships",
                                    "/v1/{parent}/messages": "messages", "/v1/{parent}/reactions": "reactions"})

    def test_google_classroom_preserves_singular_collection_field_names(self):
        document = self.documents["google_classroom"][1]
        selected = {p: a["overrides"]["response"]["envelope"]["itemsField"] for p, _, _, _, a in applications(document)}
        self.assertEqual(selected["/v1/courses/{courseId}/courseWorkMaterials"], "courseWorkMaterial")
        self.assertEqual(selected["/v1/courses/{courseId}/topics"], "topic")
        self.assertEqual(selected["/v1/courses/{courseId}/courseWork/{courseWorkId}/studentSubmissions"], "studentSubmissions")
        self.assertNotIn("x-pagination", document["paths"]["/v1/courses/{id}"]["get"])

    def test_google_calendar_pages_items_excluding_sync_checkpoints_and_watches(self):
        document = self.documents["google_calendar"][1]
        expected = {"/calendars/{calendarId}/acl", "/calendars/{calendarId}/events",
                    "/calendars/{calendarId}/events/{eventId}/instances", "/users/me/calendarList", "/users/me/settings"}
        selected = {p: a for p, _, _, _, a in applications(document)}
        self.assertEqual(set(selected), expected)
        for path, app in selected.items():
            self.assertIn("omit syncToken", app["description"])
            self.assertEqual(app["overrides"]["response"], {"envelope": {"itemsField": "items"}})
            self.assertEqual(app["overrides"]["request"], {"queryParameters": {"maxResults": {"role": "pageSize"}}})
        scheme = document["components"]["paginationSchemes"]["forwardPages"]
        self.assertNotIn("syncToken", scheme["request"]["queryParameters"])
        self.assertNotIn("nextSyncToken", scheme["response"]["bodyFields"])
        for path, item in document["paths"].items():
            if path.endswith("/watch"):
                self.assertNotIn("x-pagination", item["post"])

    def test_google_drive_activity_token_is_in_body_without_maximum_size_role(self):
        original, document = self.documents["google_driveactivity"]
        path = "/v2/activity:query"
        op = document["paths"][path]["post"]
        self.assertEqual(op["requestBody"], original["paths"][path]["post"]["requestBody"])
        scheme = document["components"]["paginationSchemes"]["forwardPages"]
        self.assertEqual(scheme["request"], {"bodyFields": {"pageToken": {"role": "cursor"}}})
        self.assertIn("minimum desired", scheme["description"])
        app = op["x-pagination"][0]
        self.assertEqual(app["overrides"], {"response": {"envelope": {"itemsField": "activities"}}})
        body = resolve(document, op["requestBody"])["content"]["application/json"]["schema"]
        self.assertIn("minimum number", field_schema(document, body, "pageSize")["description"])

    def test_google_forms_keep_and_blogger_envelopes_preserve_filtering(self):
        expected = {"forms": {"/v1/forms/{formId}/responses": "responses"},
                    "keep": {"/v1/notes": "notes"},
                    "blogger": {"/v3/blogs/{blogId}/comments": "items", "/v3/blogs/{blogId}/pages": "items",
                                "/v3/blogs/{blogId}/posts": "items", "/v3/blogs/{blogId}/posts/{postId}/comments": "items",
                                "/v3/users/{userId}/blogs/{blogId}/posts": "items"}}
        for service, envelopes in expected.items():
            original, document = self.documents["google_" + service]
            selected = {p: a["overrides"]["response"]["envelope"]["itemsField"] for p, _, _, _, a in applications(document)}
            self.assertEqual(selected, envelopes)
            for path in selected:
                self.assertEqual(document["paths"][path]["get"]["parameters"], original["paths"][path]["get"]["parameters"])

    def test_google_books_offsets_only_select_bookshelf_volumes(self):
        document = self.documents["google_books"][1]
        expected = {"/books/v1/mylibrary/bookshelves/{shelf}/volumes", "/books/v1/users/{userId}/bookshelves/{shelf}/volumes"}
        self.assertEqual({p for p, _, _, _, _ in applications(document)}, expected)
        scheme = document["components"]["paginationSchemes"]["shelfOffsets"]
        self.assertEqual(scheme["type"], "pageNumber")
        self.assertEqual(scheme["request"], {"queryParameters": {"startIndex": {"role": "offset"}, "maxResults": {"role": "pageSize"}}})
        self.assertEqual(scheme["response"], {"envelope": {"itemsField": "items"}})
        # Search estimates and unrelated annotation/onboarding APIs aren't traversal bounds.
        for path in ("/books/v1/volumes", "/books/v1/mylibrary/annotations", "/books/v1/onboarding/listCategoryVolumes"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])


    def test_hubspot_additional_forward_lists_preserve_cursor_and_query_contracts(self):
        counts = {"pages": 6, "url-redirects": 1, "user-provisioning": 1, "events": 1,
                  "audit-logs": 3, "sequences": 1, "marketing-emails": 2, "multicurrency": 1,
                  "marketing-events": 4, "campaigns-public-api": 2, "custom-objects": 1, "imports": 2}
        for service, count in counts.items():
            with self.subTest(service=service):
                original, document = self.documents["hubspot_" + service]
                selected = list(applications(document))
                self.assertEqual(len(selected), count)
                scheme = document["components"]["paginationSchemes"]["forwardResults"]
                self.assertEqual(scheme["request"], {"queryParameters": {"after": {"role": "cursor"}, "limit": {"role": "pageSize"}}})
                self.assertEqual(scheme["response"], {"envelope": {"itemsField": "results"}, "bodyFields": {"paging.next.after": {"role": "nextCursor"}}})
                for path, method, _, operation, _ in selected:
                    self.assertEqual(method, "get")
                    self.assertEqual(operation["parameters"], original["paths"][path][method]["parameters"])
                for item in document["paths"].values():
                    for method in ("post", "put", "patch", "delete"):
                        self.assertNotIn("x-pagination", item.get(method, {}))

    def test_hubspot_additional_scope_excludes_search_aggregates_and_undeclared_inputs(self):
        document = self.documents["hubspot_custom-objects"][1]
        base = "/crm/objects/2026-03/{objectType}"
        self.assertIn("x-pagination", document["paths"][base]["get"])
        self.assertNotIn("x-pagination", document["paths"][base + "/search"]["post"])
        document = self.documents["hubspot_marketing-emails"][1]
        self.assertNotIn("x-pagination", document["paths"]["/marketing/emails/2026-03/statistics/histogram"]["get"])
        document = self.documents["hubspot_marketing-events"][1]
        for path in ("/marketing/marketing-events/2026-03/associations/{marketingEventId}/lists",
                     "/marketing/marketing-events/2026-03/{externalEventId}/identifiers"):
            self.assertNotIn("x-pagination", document["paths"][path]["get"])
        document = self.documents["hubspot_campaigns-public-api"][1]
        op = document["paths"]["/marketing/campaigns/2026-03/{campaignGuid}/assets/{assetType}"]["get"]
        params = {p["name"]: p for p in op["parameters"]}
        self.assertEqual(params["limit"]["schema"]["type"], "string")
        self.assertNotIn("x-pagination", op)

    def test_google_admin_collections_use_only_get_forward_tokens(self):
        counts = {"directory": 13, "reports": 4, "vault": 4, "drivelabels": 3, "businessinfo": 3}
        for service, count in counts.items():
            with self.subTest(service=service):
                document = self.documents["google_" + service][1]
                selected = list(applications(document))
                self.assertEqual(len(selected), count)
                scheme = document["components"]["paginationSchemes"]["forwardPages"]
                self.assertEqual(scheme["request"], {"queryParameters": {"pageToken": {"role": "cursor"}}})
                self.assertEqual(scheme["response"], {"bodyFields": {"nextPageToken": {"role": "nextCursor"}}})
                for _, method, _, _, _ in selected:
                    self.assertEqual(method, "get")
                for path, item in document["paths"].items():
                    for method in ("post", "put", "patch", "delete"):
                        self.assertNotIn("x-pagination", item.get(method, {}))

    def test_google_directory_ordinary_users_preserve_deleted_and_projection_scope(self):
        original, document = self.documents["google_directory"]
        path = "/admin/directory/v1/users"
        op = document["paths"][path]["get"]
        self.assertEqual(op["parameters"], original["paths"][path]["get"]["parameters"])
        app = op["x-pagination"][0]
        self.assertIn("omit event", app["description"])
        self.assertIn("three days", app["description"])
        self.assertEqual(app["overrides"]["response"]["envelope"], {"itemsField": "users"})
        params = {p["name"]: p for p in op["parameters"]}
        self.assertTrue({"customer", "domain", "projection", "customFieldMask", "query", "showDeleted"} <= set(params))
        for p, item in document["paths"].items():
            if p.endswith("/watch"):
                self.assertNotIn("x-pagination", item["post"])

    def test_google_reports_warnings_are_not_items_or_pagination_inputs(self):
        original, document = self.documents["google_reports"]
        selected = {p: a for p, _, _, _, a in applications(document)}
        usage = "/admin/reports/v1/usage/dates/{date}"
        self.assertNotIn("request", selected[usage]["overrides"])
        for path, app in selected.items():
            expected = "items" if "/activity/" in path else "usageReports"
            self.assertEqual(app["overrides"]["response"]["envelope"], {"itemsField": expected})
            if expected == "usageReports":
                response = document["paths"][path]["get"]["responses"]["200"]
                fields = properties(document, json_response_schema(response))
                self.assertEqual(fields["warnings"], properties(original, json_response_schema(original["paths"][path]["get"]["responses"]["200"]))["warnings"])

    def test_google_vault_only_selects_resource_metadata_lists(self):
        document = self.documents["google_vault"][1]
        selected = {p: a["overrides"]["response"]["envelope"]["itemsField"] for p, _, _, _, a in applications(document)}
        self.assertEqual(selected, {"/v1/matters": "matters", "/v1/matters/{matterId}/exports": "exports",
                                    "/v1/matters/{matterId}/holds": "holds", "/v1/matters/{matterId}/savedQueries": "savedQueries"})
        self.assertNotIn("x-pagination", document["paths"]["/v1/{name}"]["get"])

    def test_google_drive_labels_keep_revision_and_permission_envelopes(self):
        document = self.documents["google_drivelabels"][1]
        selected = {p: a["overrides"]["response"]["envelope"]["itemsField"] for p, _, _, _, a in applications(document)}
        self.assertEqual(selected, {"/v2/labels": "labels", "/v2/{parent}/locks": "labelLocks", "/v2/{parent}/permissions": "labelPermissions"})
        params = {p["name"] for p in document["paths"]["/v2/labels"]["get"]["parameters"]}
        self.assertTrue({"publishedOnly", "customer", "languageCode", "view", "minimumRole", "useAdminAccess"} <= params)

    def test_google_business_locations_preserve_required_read_mask_and_distinct_metadata(self):
        original, document = self.documents["google_businessinfo"]
        selected = {p: a for p, _, _, _, a in applications(document)}
        expected = {"/v1/attributes": "attributeMetadata", "/v1/categories": "categories", "/v1/{parent}/locations": "locations"}
        self.assertEqual({p: a["overrides"]["response"]["envelope"]["itemsField"] for p, a in selected.items()}, expected)
        path = "/v1/{parent}/locations"
        params = {p["name"]: p for p in document["paths"][path]["get"]["parameters"]}
        self.assertTrue(params["readMask"]["description"].startswith("Required."))
        self.assertIn("readMask query is required", selected[path]["description"])
        self.assertEqual(document["paths"][path]["get"]["parameters"], original["paths"][path]["get"]["parameters"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
