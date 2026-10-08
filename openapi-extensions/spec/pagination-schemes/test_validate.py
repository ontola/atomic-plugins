"""Pagination Schemes 0.4.0: schema, document validator, examples and link resolution."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import LinkRefused, resolve_link, rfc3986_resolve, validate

ROOT = pathlib.Path(__file__).parent
EXAMPLES = ("relative-next-link.yaml", "declared-base.yaml")


def example(name):
    return yaml.safe_load((ROOT / "examples" / name).read_text(encoding="utf-8"))


class ExampleTests(unittest.TestCase):
    def test_examples_pass_the_validator(self):
        for name in EXAMPLES:
            with self.subTest(example=name):
                validate(example(name))

    def test_examples_are_valid_openapi_without_the_extension_member(self):
        # components.paginationSchemes is not an OpenAPI 3.0 member; the rest must be valid.
        for name in EXAMPLES:
            with self.subTest(example=name):
                document = example(name)
                document["components"].pop("paginationSchemes")
                if not document["components"]:
                    document.pop("components")
                validate_openapi(document)


class SchemaTests(unittest.TestCase):
    def document(self):
        return example("relative-next-link.yaml")

    def field(self, document):
        return document["components"]["paginationSchemes"]["linkedCollections"]["response"]["bodyFields"]["next_page_uri"]

    def assertInvalid(self, document, fragment):
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_every_base_is_accepted(self):
        for resolution in ({"base": "request"}, {"base": "server"},
                           {"base": "declared", "url": "https://api.example.com/"},
                           {"base": "declared", "url": "https://api.example.com:443/2010-04-01/"}):
            document = self.document()
            self.field(document)["linkResolution"] = resolution
            validate(document)

    def test_0_3_documents_without_link_resolution_stay_valid(self):
        document = self.document()
        del self.field(document)["linkResolution"]
        validate(document)

    def test_rejects_unknown_base_missing_or_misplaced_url(self):
        for resolution in ({"base": "response"}, {}, {"base": "declared"},
                           {"base": "server", "url": "https://api.example.com/"},
                           {"base": "server", "unknown": True}):
            document = self.document()
            self.field(document)["linkResolution"] = resolution
            self.assertInvalid(document, "next_page_uri.linkResolution")

    def test_link_resolution_only_on_link_roles(self):
        document = self.document()
        field = self.field(document)
        field["role"] = "nextPageToken"
        self.assertInvalid(document, "next_page_uri")
        field["role"] = "previousLink"
        validate(document)

    def test_declared_url_must_be_absolute_http_without_userinfo_or_fragment(self):
        for url in ("/2010-04-01/", "ftp://api.example.com/", "https://user:pw@api.example.com/",
                    "https://api.example.com/#top", "https://{region}.example.com/", "api.example.com"):
            document = self.document()
            self.field(document)["linkResolution"] = {"base": "declared", "url": url}
            with self.subTest(url=url):
                self.assertInvalid(document, "linkResolution")

    def test_declared_url_must_share_the_operation_server_origin(self):
        for url in ("https://other.example.com/", "http://api.example.com/", "https://api.example.com:8443/"):
            document = self.document()
            self.field(document)["linkResolution"] = {"base": "declared", "url": url}
            with self.subTest(url=url):
                self.assertInvalid(document, "x-pagination[0].response.bodyFields.next_page_uri.linkResolution.url")

    def test_declared_origin_uses_operation_then_path_servers_and_skips_templated_ones(self):
        document = self.document()
        self.field(document)["linkResolution"] = {"base": "declared", "url": "https://eu.example.com/"}
        item = document["paths"]["/2010-04-01/Accounts/{AccountSid}/Calls.json"]
        item["servers"] = [{"url": "https://eu.example.com"}]
        validate(document)
        item["get"]["servers"] = [{"url": "https://us.example.com"}]
        self.assertInvalid(document, "differs from every server")
        # Rule 11 asks for one of the listed servers, so production plus sandbox is valid.
        item["get"]["servers"] = [{"url": "https://eu.example.com"}, {"url": "https://sandbox.example.com"}]
        validate(document)
        item["get"]["servers"] = [{"url": "https://{region}.example.com", "variables": {"region": {"default": "us"}}}]
        validate(document)

    def test_overrides_are_checked_after_merging(self):
        document = self.document()
        application = document["paths"]["/2010-04-01/Accounts/{AccountSid}/Calls.json"]["get"]["x-pagination"][0]
        application["overrides"]["response"]["bodyFields"] = {
            "next_page_uri": {"linkResolution": {"base": "declared", "url": "https://other.example.com/"}}}
        self.assertInvalid(document, "differs from every server")
        application["overrides"]["response"]["bodyFields"]["next_page_uri"]["linkResolution"]["url"] = "https://api.example.com/"
        validate(document)

    def test_rejects_undefined_scheme_and_bad_types_and_roles(self):
        document = self.document()
        document["paths"]["/2010-04-01/Accounts/{AccountSid}/Calls.json"]["get"]["x-pagination"][0]["scheme"] = "missing"
        self.assertInvalid(document, "'missing' is not defined")
        for mutate in (lambda s: s.update(type="cursor"),
                       lambda s: s.pop("request") and s.pop("response"),
                       lambda s: s["request"]["queryParameters"]["PageSize"].update(role="limit"),
                       lambda s: s["response"]["bodyFields"]["next_page_uri"].update(role="next")):
            document = self.document()
            mutate(document["components"]["paginationSchemes"]["linkedCollections"])
            self.assertInvalid(document, "components.paginationSchemes.linkedCollections")
        document = self.document()
        document["components"]["paginationSchemes"]["linkedCollections"]["response"]["bodyFields"]["next_page_uri"]["role"] = "x-nextUri"
        del document["components"]["paginationSchemes"]["linkedCollections"]["response"]["bodyFields"]["next_page_uri"]["linkResolution"]
        validate(document)

    def test_swagger_2_root_member(self):
        document = {
            "swagger": "2.0", "host": "api.example.com", "basePath": "/v1", "schemes": ["https"],
            "x-paginationSchemes": {"links": {"type": "nextLink", "response": {"bodyFields": {
                "next": {"role": "nextLink", "linkResolution": {"base": "declared", "url": "https://api.example.com/v1/"}}}}}},
            "paths": {"/items": {"get": {"x-pagination": [{"scheme": "links"}], "responses": {"200": {"description": "ok"}}}}},
        }
        validate(document)
        document["schemes"] = ["http"]
        with self.assertRaises(ValueError):
            validate(document)


class ResolveLinkTests(unittest.TestCase):
    SERVER = "https://api.example.com"
    REQUEST = "https://api.example.com/2010-04-01/Accounts/AC0/Calls.json?PageSize=50"

    def resolve(self, value, resolution=None, server=SERVER, request=REQUEST):
        return resolve_link(value, request_url=request, server_url=server, resolution=resolution)

    def test_no_next_page(self):
        for value in (None, ""):
            self.assertIsNone(self.resolve(value, {"base": "server"}))

    def test_twilio_absolute_path_reference_is_the_same_under_every_base(self):
        value = "/2010-04-01/Accounts/AC0/Calls.json?PageSize=50&Page=1&PageToken=PA0"
        expected = "https://api.example.com" + value
        for resolution in (None, {"base": "request"}, {"base": "server"},
                           {"base": "declared", "url": "https://api.example.com/other/"}):
            self.assertEqual(self.resolve(value, resolution), expected)

    def test_bases_differ_for_relative_path_and_query_references(self):
        request = "https://api.example.com/v2/items?page=1"
        server = "https://api.example.com/v2"
        self.assertEqual(self.resolve("?page=2", None, server, request), "https://api.example.com/v2/items?page=2")
        self.assertEqual(self.resolve("?page=2", {"base": "server"}, server, request), "https://api.example.com/v2/?page=2")
        self.assertEqual(self.resolve("items?page=2", {"base": "server"}, server, request), "https://api.example.com/v2/items?page=2")
        self.assertEqual(self.resolve("items?page=2", {"base": "server"}, server + "/", request), "https://api.example.com/v2/items?page=2")
        self.assertEqual(self.resolve("items?page=2", None, server, request), "https://api.example.com/v2/items?page=2")
        self.assertEqual(self.resolve("../items?page=2", {"base": "declared", "url": "https://api.example.com/v2/sub/"}, server, request),
                         "https://api.example.com/v2/items?page=2")
        # A declared base is used exactly as written: without its trailing slash, its last segment is replaced.
        self.assertEqual(self.resolve("items", {"base": "declared", "url": "https://api.example.com/v2"}, server, request),
                         "https://api.example.com/items")

    def test_absolute_links_on_the_server_origin_are_followed(self):
        for value in ("https://api.example.com/next", "https://API.example.com:443/next", "HTTPS://api.example.com/next"):
            self.assertIsNotNone(self.resolve(value, {"base": "server"}))

    def test_links_leaving_the_server_origin_are_refused(self):
        for value in ("https://attacker.example/steal", "//attacker.example/steal", "http://api.example.com/next",
                      "https://api.example.com:8443/next", "https://api.example.com.attacker.example/",
                      "javascript:alert(1)", "data:text/plain,x", "file:///etc/passwd",
                      # Parsers disagree on these (review B1); rule 2 refuses them before resolution.
                      "///attacker.example/x", "////attacker.example/x", "https:///attacker.example/x",
                      "https:attacker.example/x", "https:/attacker.example/x", "http:x", "//", "https://",
                      "//?x", "https://äpi.example.com/x", "https://api.example.com／x"):
            for resolution in (None, {"base": "server"}):
                with self.subTest(value=value, resolution=resolution), self.assertRaises(LinkRefused):
                    self.resolve(value, resolution)

    def test_rfc3986_section_5_4_examples(self):
        # RFC 3986 §5.4.1 and §5.4.2 (strict), without the fragment cases.
        base = "http://a/b/c/d;p?q"
        cases = {
            "g:h": "g:h", "g": "http://a/b/c/g", "./g": "http://a/b/c/g", "g/": "http://a/b/c/g/",
            "/g": "http://a/g", "//g": "http://g", "?y": "http://a/b/c/d;p?y", "g?y": "http://a/b/c/g?y",
            ";x": "http://a/b/c/;x", "g;x": "http://a/b/c/g;x", "": "http://a/b/c/d;p?q", ".": "http://a/b/c/",
            "./": "http://a/b/c/", "..": "http://a/b/", "../": "http://a/b/", "../g": "http://a/b/g",
            "../..": "http://a/", "../../": "http://a/", "../../g": "http://a/g",
            "../../../g": "http://a/g", "../../../../g": "http://a/g", "/./g": "http://a/g", "/../g": "http://a/g",
            "g.": "http://a/b/c/g.", ".g": "http://a/b/c/.g", "g..": "http://a/b/c/g..", "..g": "http://a/b/c/..g",
            "./../g": "http://a/b/g", "./g/.": "http://a/b/c/g/", "g/./h": "http://a/b/c/g/h",
            "g/../h": "http://a/b/c/h", "g;x=1/./y": "http://a/b/c/g;x=1/y", "g;x=1/../y": "http://a/b/c/y",
            "g?y/./x": "http://a/b/c/g?y/./x", "g?y/../x": "http://a/b/c/g?y/../x", "http:g": "http:g",
            "?": "http://a/b/c/d;p?", "//g/../x": "http://g/x",
        }
        for reference, expected in cases.items():
            with self.subTest(reference=reference):
                self.assertEqual(rfc3986_resolve(base, reference), expected)

    def test_query_only_and_dot_segment_links_resolve_exactly(self):
        self.assertEqual(self.resolve("?", None), "https://api.example.com/2010-04-01/Accounts/AC0/Calls.json?")
        self.assertEqual(self.resolve("//api.example.com/a/../b", {"base": "server"}), "https://api.example.com/b")
        # Climbing past the server's base path stays allowed within the origin (§4.4.3).
        self.assertEqual(self.resolve("../../x", {"base": "server"}, "https://api.example.com/v1/sub"),
                         "https://api.example.com/x")

    def test_a_declared_base_never_widens_the_allowed_origin(self):
        with self.assertRaises(LinkRefused):
            self.resolve("next", {"base": "declared", "url": "https://other.example.com/"})

    def test_userinfo_fragments_and_unparseable_values_are_refused(self):
        for value in ("https://user:pw@api.example.com/next", "//user@api.example.com/next", "/next#frag", "/next#",
                      "/next page", " /next", "/next\n", "/next\t", "\\\\attacker.example/x", "/next\\..\\x",
                      "/next\x00", "/next\x7f", 42, ["/next"]):
            with self.subTest(value=value), self.assertRaises(LinkRefused):
                self.resolve(value, {"base": "server"})

    def test_server_with_a_path_keeps_relative_resolution_inside_it(self):
        server = "https://api.example.com/v1"
        self.assertEqual(self.resolve("items?cursor=b", {"base": "server"}, server, server + "/items"),
                         "https://api.example.com/v1/items?cursor=b")
        # An absolute-path reference replaces the server path; the origin rule still allows it (§4.4.3, last paragraph).
        self.assertEqual(self.resolve("/items?cursor=b", {"base": "server"}, server, server + "/items"),
                         "https://api.example.com/items?cursor=b")


if __name__ == "__main__":
    unittest.main()
