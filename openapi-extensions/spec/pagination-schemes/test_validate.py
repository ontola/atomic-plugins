"""Pagination Schemes 0.10.0: schema, document validator, examples, link resolution and range windows."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import LinkRefused, PageReadError, WindowReadError, halves, page_items, read_item_cursor, read_offsets, read_pages, read_range, resolve_link, response_incomplete, rfc3986_resolve, validate, window_request

ROOT = pathlib.Path(__file__).parent
EXAMPLES = ("relative-next-link.yaml", "declared-base.yaml", "range-window.yaml", "short-page.yaml", "empty-when-absent.yaml", "offset-advance.yaml", "incomplete-marker.yaml", "item-cursor.yaml", "item-order.yaml")


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


TRANSACTIONS = "/ledgers/{ledgerId}/transactions"


class RangeWindowSchemaTests(unittest.TestCase):
    def document(self):
        return example("range-window.yaml")

    def scheme(self, document, name="periodWindows"):
        return document["components"]["paginationSchemes"][name]

    def assertInvalid(self, document, fragment):
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_window_is_required_for_range_window_and_refused_elsewhere(self):
        document = self.document()
        del self.scheme(document)["window"]
        self.assertInvalid(document, "periodWindows")
        document = example("relative-next-link.yaml")
        document["components"]["paginationSchemes"]["linkedCollections"]["window"] = {
            "unit": "day", "format": "date", "bounds": "closed", "cap": 100}
        self.assertInvalid(document, "linkedCollections")

    def test_window_fields_and_values(self):
        for mutate in (lambda w: w.pop("bounds"), lambda w: w.pop("cap"), lambda w: w.pop("unit"),
                       lambda w: w.pop("format"), lambda w: w.update(cap=0), lambda w: w.update(cap="100"),
                       lambda w: w.update(minimumWidth=0), lambda w: w.update(bounds="open"),
                       lambda w: w.update(unit="month"), lambda w: w.update(field="date"),
                       lambda w: w.update(format="dateTime"), lambda w: w.update(split="halve")):
            document = self.document()
            mutate(self.scheme(document)["window"])
            self.assertInvalid(document, "periodWindows")

    def test_format_fits_unit(self):
        fits = {"day": ("date", "basicDate"), "second": ("dateTime", "unixSeconds"), "integer": ("integer",)}
        for unit in fits:
            for form in ("date", "basicDate", "dateTime", "unixSeconds", "integer"):
                document = self.document()
                window = self.scheme(document, "changedWindows")["window"]
                window.update(unit=unit, format=form)
                with self.subTest(unit=unit, format=form):
                    if form in fits[unit]:
                        validate(document)
                    else:
                        self.assertInvalid(document, "changedWindows")

    def test_time_zone_only_for_days(self):
        document = self.document()
        self.scheme(document, "changedWindows")["window"]["timeZone"] = "UTC"
        self.assertInvalid(document, "changedWindows")

    def test_window_roles_only_in_range_window_schemes(self):
        for role in ("windowStart", "windowEnd", "windowRange"):
            document = example("relative-next-link.yaml")
            document["components"]["paginationSchemes"]["linkedCollections"]["request"]["queryParameters"]["PageSize"]["role"] = role
            with self.subTest(role=role):
                self.assertInvalid(document, "linkedCollections")

    def test_one_way_of_carrying_the_window(self):
        document = self.document()
        fields = self.scheme(document)["request"]["queryParameters"]
        fields["from"] = {"role": "windowStart"}
        self.assertInvalid(document, "needs one windowRange field")
        document = self.document()
        fields = self.scheme(document, "changedWindows")["request"]["queryParameters"]
        del fields["updatedBefore"]
        self.assertInvalid(document, "needs one windowRange field")
        fields["updatedBefore"] = {"role": "windowStart"}
        self.assertInvalid(document, "needs one windowRange field")
        fields["updatedBefore"] = {"role": "pageSize"}
        self.assertInvalid(document, "needs one windowRange field")

    def test_template_rules(self):
        for template in ("period:{start}", "period:{end}..{end}", "period:{start}..{end}..{start}",
                         "period:{start}..{end},x:{other}", "period:{start}..{end}}", ""):
            document = self.document()
            self.scheme(document)["request"]["queryParameters"]["filter"]["template"] = template
            with self.subTest(template=template):
                self.assertInvalid(document, "periodWindows")
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["filter"]["template"] = "{end}/{start}"
        validate(document)
        del self.scheme(document)["request"]["queryParameters"]["filter"]["template"]
        self.assertInvalid(document, "periodWindows")
        document = self.document()
        self.scheme(document, "changedWindows")["request"]["queryParameters"]["updatedFrom"]["template"] = "{start}{end}"
        self.assertInvalid(document, "changedWindows")

    def test_never_auto_detected(self):
        document = self.document()
        self.scheme(document)["autoDetect"] = True
        self.assertInvalid(document, "periodWindows")
        self.scheme(document)["autoDetect"] = {"matchQueryParams": True}
        self.assertInvalid(document, "periodWindows")
        del self.scheme(document)["autoDetect"]
        validate(document)

    def test_applied_alone(self):
        document = self.document()
        document["components"]["paginationSchemes"]["pages"] = {
            "type": "pageNumber", "request": {"queryParameters": {"page": {"role": "page"}}}}
        document["paths"][TRANSACTIONS]["get"]["x-pagination"].append({"scheme": "pages"})
        self.assertInvalid(document, "applies no other scheme")

    def test_applied_alone_after_overrides(self):
        # A pageNumber scheme overridden into a rangeWindow counts as one (review of #397).
        document = self.document()
        document["components"]["paginationSchemes"]["pages"] = {
            "type": "pageNumber", "request": {"queryParameters": {"page": {"role": "page"}}}}
        document["paths"][TRANSACTIONS]["get"]["x-pagination"] = [
            {"scheme": "pages"},
            {"scheme": "pages", "overrides": {"type": "rangeWindow", "autoDetect": False,
                                              "window": copy.deepcopy(self.scheme(document)["window"]),
                                              "request": {"queryParameters": {
                                                  "page": {"role": "x-unused"},
                                                  "filter": {"role": "windowRange", "template": "{start}..{end}"}}}}}]
        self.assertInvalid(document, "applies no other scheme")

    def test_window_parameters_exist_on_the_operation(self):
        document = self.document()
        parameters = document["paths"][TRANSACTIONS]["get"]["parameters"]
        parameters[0]["name"] = "filters"
        self.assertInvalid(document, "no query parameter 'filter'")
        # A path-item parameter reached through $ref counts.
        del parameters[0]
        document["components"]["parameters"]["filter"] = {"name": "filter", "in": "query", "schema": {"type": "string"}}
        document["paths"][TRANSACTIONS]["parameters"].append({"$ref": "#/components/parameters/filter"})
        validate(document)
        # Overrides are merged before the check.
        document["paths"]["/entries"]["get"]["x-pagination"][0]["overrides"] = {"request": {"queryParameters": {
            "updatedBefore": {"role": "x-unused"}, "before": {"role": "windowEnd"}}}}
        self.assertInvalid(document, "no query parameter 'before'")

    def test_header_parameters_match_case_insensitively(self):
        document = self.document()
        scheme = self.scheme(document, "changedWindows")
        scheme["request"] = {"headerFields": {"X-From": {"role": "windowStart"}, "X-Before": {"role": "windowEnd"}}}
        document["paths"]["/entries"]["get"]["parameters"] = [
            {"name": "x-from", "in": "header", "schema": {"type": "string"}},
            {"name": "X-BEFORE", "in": "header", "schema": {"type": "string"}}]
        validate(document)
        document["paths"]["/entries"]["get"]["parameters"][1]["in"] = "query"
        self.assertInvalid(document, "no header parameter 'X-Before'")

    def test_0_4_documents_stay_valid(self):
        for name in ("relative-next-link.yaml", "declared-base.yaml"):
            validate(example(name))


class ReadRangeTests(unittest.TestCase):
    def setUp(self):
        self.document = example("range-window.yaml")
        self.period = self.document["components"]["paginationSchemes"]["periodWindows"]
        self.changed = self.document["components"]["paginationSchemes"]["changedWindows"]

    def provider(self, dates, cap):
        """A fake financial_mutations list: items {id, date YYYYMMDD}, answers truncated at cap."""
        calls = []

        def request(values):
            filter_value = values[("queryParameters", "filter")]
            calls.append(filter_value)
            self.assertTrue(filter_value.startswith("period:") and filter_value.endswith(",state:all"))
            low, high = filter_value[len("period:"):-len(",state:all")].split("..")
            selected = [{"id": str(i), "date": d} for i, d in enumerate(dates) if low <= d <= high]
            return selected[:cap]

        return request, calls

    def test_one_request_when_below_the_cap(self):
        request, calls = self.provider(["20260105"] * 99, 100)
        result = read_range(self.period, "20260101", "20261231", request)
        self.assertEqual((result["requests"], len(result["items"])), (1, 99))
        self.assertEqual(calls, ["period:20260101..20261231,state:all"])

    def test_full_answers_are_halved_like_the_money_app(self):
        dates = ["20260310"] * 60 + ["20261120"] * 60
        request, calls = self.provider(dates, 100)
        result = read_range(self.period, "20260101", "20261231", request)
        self.assertEqual(len(result["items"]), 120)
        self.assertEqual(calls[:3], ["period:20260101..20261231,state:all",
                                     "period:20260101..20260702,state:all",
                                     "period:20260703..20261231,state:all"])
        self.assertEqual(result["windows"], [("20260101", "20260702"), ("20260703", "20261231")])

    def test_windows_partition_the_range_down_to_days(self):
        dates = [f"202602{d:02d}" for d in range(1, 29) for _ in range(4)]  # 112 items, 4 a day
        request, _ = self.provider(dates, 100)
        result = read_range(self.period, "20260201", "20260228", request)
        self.assertEqual(len(result["items"]), 112)
        windows = result["windows"]
        self.assertEqual(windows[0][0], "20260201")
        self.assertEqual(windows[-1][1], "20260228")
        for (_, end), (start, _) in zip(windows, windows[1:]):
            self.assertEqual(int(start) - int(end), 1)  # adjacent days within February

    def test_a_full_single_day_is_an_error_not_a_complete_read(self):
        request, _ = self.provider(["20260415"] * 100, 100)
        with self.assertRaises(WindowReadError) as raised:
            read_range(self.period, "20260101", "20261231", request)
        self.assertIn("20260415..20260415", str(raised.exception))

    def test_exactly_cap_items_counts_as_full(self):
        request, calls = self.provider(["20260101", "20260102"] * 50, 100)
        result = read_range(self.period, "20260101", "20260102", request)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(result["items"]), 100)

    def test_request_budget_ends_the_read_incomplete(self):
        request, _ = self.provider(["20260310"] * 60 + ["20261120"] * 60, 100)
        with self.assertRaises(WindowReadError):
            read_range(self.period, "20260101", "20261231", request, max_requests=2)

    def test_minimum_width(self):
        window = dict(self.period["window"], minimumWidth=7)
        self.assertIsNone(halves("20260101", "20260113", window))  # 13 days < 14
        self.assertEqual(halves("20260101", "20260114", window),
                         (("20260101", "20260107"), ("20260108", "20260114")))

    def test_half_open_seconds(self):
        window = self.changed["window"]
        self.assertEqual(halves("2026-01-01T00:00:00Z", "2026-01-01T00:00:10Z", window),
                         (("2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z"),
                          ("2026-01-01T00:00:05Z", "2026-01-01T00:00:10Z")))
        self.assertIsNone(halves("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z", window))
        self.assertEqual(window_request(self.changed, "a", "b"),
                         {("queryParameters", "updatedFrom"): "a", ("queryParameters", "updatedBefore"): "b"})

    def test_odd_widths_put_the_extra_unit_first(self):
        window = {"unit": "integer", "format": "integer", "bounds": "closed", "cap": 1}
        self.assertEqual(halves("1", "5", window), (("1", "3"), ("4", "5")))
        self.assertEqual(halves("-2", "-1", window), (("-2", "-2"), ("-1", "-1")))
        window["bounds"] = "halfOpen"
        self.assertEqual(halves("0", "5", window), (("0", "3"), ("3", "5")))

    def test_dates_cross_month_and_leap_days(self):
        window = {"unit": "day", "format": "date", "bounds": "closed", "cap": 1}
        self.assertEqual(halves("2028-02-28", "2028-03-01", window),
                         (("2028-02-28", "2028-02-29"), ("2028-03-01", "2028-03-01")))

    def test_bounds_must_be_in_the_format(self):
        for start in ("2026-01-01", "2026011", 20260101, "20261301"):
            with self.subTest(start=start), self.assertRaises(ValueError):
                read_range(self.period, start, "20261231", lambda values: [])
        with self.assertRaises(ValueError):
            read_range(self.period, "20260102", "20260101", lambda values: [])

    def test_duplicates_across_windows_are_kept_once(self):
        answers = iter([[{"id": "1"}] * 2, [{"id": "1", "v": 1}], [{"id": "1", "v": 2}]])
        window = {"unit": "integer", "format": "integer", "bounds": "closed", "cap": 2}
        scheme = {"type": "rangeWindow", "window": window,
                  "request": {"queryParameters": {"n": {"role": "windowRange", "template": "{start}:{end}"}}}}
        result = read_range(scheme, "1", "2", lambda values: next(answers))
        self.assertEqual(result["items"], [{"id": "1", "v": 2}])


class ShortPageSchemaTests(unittest.TestCase):
    def document(self):
        return example("short-page.yaml")

    def scheme(self, document, name="zeroBasedPages"):
        return document["components"]["paginationSchemes"][name]

    def assertInvalid(self, document, fragment):
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_start_only_on_page_and_not_negative(self):
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["page"]["start"] = -1
        self.assertInvalid(document, "zeroBasedPages")
        document = self.document()
        self.scheme(document, "sizedPages")["request"]["queryParameters"]["per_page"]["start"] = 0
        self.assertInvalid(document, "sizedPages")
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["page"]["start"] = 1
        validate(document)

    def test_short_page_fields(self):
        for mutate in (lambda s: s.pop("size"), lambda s: s.pop("assurance"), lambda s: s.update(size=0),
                       lambda s: s.update(size="response"), lambda s: s.update(assurance="likely"),
                       lambda s: s.update(extra=True)):
            document = self.document()
            mutate(self.scheme(document)["response"]["shortPage"])
            self.assertInvalid(document, "zeroBasedPages")

    def test_short_page_only_on_page_number_schemes(self):
        document = self.document()
        self.scheme(document)["type"] = "pageToken"
        self.assertInvalid(document, "zeroBasedPages")

    def test_request_size_needs_a_page_size_field(self):
        document = self.document()
        del self.scheme(document, "sizedPages")["request"]["queryParameters"]["per_page"]
        self.assertInvalid(document, "needs a request field with role pageSize")

    def test_applied_scheme_needs_a_page_field(self):
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["page"]["role"] = "x-page"
        del self.scheme(document)["request"]["queryParameters"]["page"]["start"]
        self.assertInvalid(document, "needs exactly one request field with role page")

    def test_0_5_documents_stay_valid(self):
        for name in ("relative-next-link.yaml", "declared-base.yaml", "range-window.yaml"):
            validate(example(name))


class ReadPagesTests(unittest.TestCase):
    def setUp(self):
        self.document = example("short-page.yaml")
        self.zero = self.document["components"]["paginationSchemes"]["zeroBasedPages"]
        self.sized = self.document["components"]["paginationSchemes"]["sizedPages"]

    def provider(self, total, size, first=0, envelope="tasks"):
        calls = []

        def request(values):
            calls.append(values)
            number = values[("queryParameters", "page")] - first
            page = [{"id": str(i)} for i in range(number * size, min(total, (number + 1) * size))]
            return {envelope: page} if envelope else page

        return request, calls

    def test_zero_based_pages_start_at_zero_and_end_on_a_short_page(self):
        request, calls = self.provider(250, 100)
        result = read_pages(self.zero, request)
        self.assertEqual([c[("queryParameters", "page")] for c in calls], [0, 1, 2])
        self.assertEqual(len(result["items"]), 250)
        self.assertFalse(result["complete"])  # assurance: assumed

    def test_a_full_last_page_needs_one_more_empty_page(self):
        request, calls = self.provider(200, 100)
        result = read_pages(self.zero, request)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(result["items"]), 200)

    def test_documented_short_page_makes_the_read_complete(self):
        request, calls = self.provider(120, 50, first=1, envelope=None)
        result = read_pages(self.sized, request, page_size=50)
        self.assertTrue(result["complete"])
        self.assertEqual([c[("queryParameters", "page")] for c in calls], [1, 2, 3])
        self.assertEqual({c[("queryParameters", "per_page")] for c in calls}, {50})

    def test_request_size_needs_the_page_size(self):
        with self.assertRaises(ValueError):
            read_pages(self.sized, lambda values: [])

    def test_an_oversized_page_ends_with_an_error(self):
        with self.assertRaises(PageReadError):
            read_pages(self.zero, lambda values: {"tasks": [{"id": str(i)} for i in range(101)]})

    def test_a_server_that_ignores_the_page_ends_with_an_error(self):
        with self.assertRaises(PageReadError) as raised:
            read_pages(self.zero, lambda values: {"tasks": [{"id": str(i)} for i in range(100)]})
        self.assertIn("earlier page", str(raised.exception))

    def test_page_budget_ends_the_read_incomplete(self):
        request, _ = self.provider(1000, 100)
        with self.assertRaises(PageReadError):
            read_pages(self.zero, request, max_pages=3)


class ReadPagesReviewTests(unittest.TestCase):
    """Review of #415: page size maximum, end signals that disagree, zero-based totalPages."""

    def setUp(self):
        document = example("short-page.yaml")
        self.zero = document["components"]["paginationSchemes"]["zeroBasedPages"]
        self.sized = document["components"]["paginationSchemes"]["sizedPages"]

    def pages(self, total, size, first=0, extra=lambda number: {}):
        calls = []

        def request(values):
            number = values[("queryParameters", "page")]
            calls.append(number)
            n = number - first
            tasks = [{"id": str(i)} for i in range(n * size, min(total, (n + 1) * size))]
            return {"tasks": tasks, **extra(number)}

        return request, calls

    def with_fields(self, scheme, **fields):
        scheme = copy.deepcopy(scheme)
        scheme["response"]["bodyFields"] = {name: {"role": role} for name, role in fields.items()}
        return scheme

    def test_page_size_above_the_documented_maximum_is_refused(self):
        with self.assertRaises(ValueError):
            read_pages(self.sized, lambda values: [], page_size=500, maximum=50)
        request, _ = self.pages(30, 50, first=1)
        result = read_pages(self.sized, lambda v: request(v)["tasks"], page_size=50, maximum=50)
        self.assertTrue(result["complete"])

    def test_total_pages_counts_from_start(self):
        # Zero-based: totalPages 3 means pages 0, 1 and 2; a full page 2 ends the read.
        scheme = self.with_fields(self.zero, total_pages="totalPages")
        request, calls = self.pages(300, 100, extra=lambda number: {"total_pages": 3})
        result = read_pages(scheme, request)
        self.assertEqual(calls, [0, 1, 2])
        self.assertTrue(result["complete"])  # a totalPages end is complete whatever the assurance

    def test_total_count_end_on_a_full_page_is_complete(self):
        scheme = self.with_fields(self.zero, total="totalCount")
        request, calls = self.pages(200, 100, extra=lambda number: {"total": 200})
        result = read_pages(scheme, request)
        self.assertEqual(calls, [0, 1])
        self.assertTrue(result["complete"])

    def test_short_page_contradicted_by_the_total(self):
        request, _ = self.pages(150, 100, extra=lambda number: {"total": 300})
        documented = self.with_fields(self.zero, total="totalCount")
        documented["response"]["shortPage"]["assurance"] = "documented"
        with self.assertRaises(PageReadError) as raised:
            read_pages(documented, request)
        self.assertIn("more pages follow", str(raised.exception))
        result = read_pages(self.with_fields(self.zero, total="totalCount"), request)
        self.assertFalse(result["complete"])

    def test_reported_page_size_is_the_full_size(self):
        scheme = self.with_fields(self.zero, limit="pageSize")
        request, calls = self.pages(120, 60, extra=lambda number: {"limit": 60})
        result = read_pages(scheme, request)
        self.assertEqual(calls, [0, 1, 2])
        self.assertEqual(len(result["items"]), 120)

    def test_an_item_seen_on_any_earlier_page_ends_the_read(self):
        answers = iter([
            {"tasks": [{"id": str(i)} for i in range(100)]},
            {"tasks": [{"id": str(i)} for i in range(100, 200)]},
            {"tasks": [{"id": "5"}]},
        ])
        with self.assertRaises(PageReadError) as raised:
            read_pages(self.zero, lambda values: next(answers))
        self.assertIn("earlier page", str(raised.exception))

    def test_exactly_one_page_field(self):
        scheme = copy.deepcopy(self.zero)
        scheme["request"]["queryParameters"]["p2"] = {"role": "page"}
        with self.assertRaises(ValueError):
            read_pages(scheme, lambda values: {"tasks": []})
        document = example("short-page.yaml")
        document["components"]["paginationSchemes"]["zeroBasedPages"] = scheme
        document["paths"]["/team/{teamId}/task"]["get"]["parameters"].append({"name": "p2", "in": "query", "schema": {"type": "integer"}})
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("exactly one request field with role page", str(raised.exception))


class ReadPagesSmallerPageSizeTests(unittest.TestCase):
    """Second review of #415: a whole-number size with a smaller page size sent."""

    def test_the_smaller_page_size_sent_is_the_full_size(self):
        document = example("short-page.yaml")
        scheme = copy.deepcopy(document["components"]["paginationSchemes"]["zeroBasedPages"])
        scheme["request"]["queryParameters"]["limit"] = {"role": "pageSize"}
        scheme["response"]["shortPage"]["assurance"] = "documented"
        calls = []

        def request(values):
            number = values[("queryParameters", "page")]
            calls.append((number, values[("queryParameters", "limit")]))
            return {"tasks": [{"id": str(i)} for i in range(number * 50, min(250, (number + 1) * 50))]}

        result = read_pages(scheme, request, page_size=50)
        self.assertEqual(len(result["items"]), 250)
        self.assertEqual([n for n, _ in calls], [0, 1, 2, 3, 4, 5])
        self.assertTrue(result["complete"])

    def test_a_page_size_without_a_page_size_field_changes_nothing(self):
        document = example("short-page.yaml")
        scheme = document["components"]["paginationSchemes"]["zeroBasedPages"]  # no pageSize field
        calls = []

        def request(values):
            number = values[("queryParameters", "page")]
            calls.append(number)
            return {"tasks": [{"id": str(i)} for i in range(number * 100, min(250, (number + 1) * 100))]}

        result = read_pages(scheme, request, page_size=50)
        self.assertEqual(calls, [0, 1, 2])
        self.assertEqual(len(result["items"]), 250)

    def test_a_reported_page_size_of_zero_is_absent(self):
        document = example("short-page.yaml")
        scheme = copy.deepcopy(document["components"]["paginationSchemes"]["zeroBasedPages"])
        scheme["response"]["bodyFields"] = {"limit": {"role": "pageSize"}}

        def request(values):
            number = values[("queryParameters", "page")]
            return {"limit": 0, "tasks": [{"id": str(i)} for i in range(number * 100, min(150, (number + 1) * 100))]}

        self.assertEqual(len(read_pages(scheme, request)["items"]), 150)

    def test_rule_21_is_checked_after_overrides_only(self):
        document = example("short-page.yaml")
        sized = document["components"]["paginationSchemes"]["sizedPages"]
        del sized["request"]["queryParameters"]["per_page"]
        # The bare scheme is not checked; its application is.
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("(merged)", str(raised.exception))
        document["paths"]["/projects"]["get"]["x-pagination"][0]["overrides"] = {
            "request": {"queryParameters": {"per_page": {"role": "pageSize"}}}}
        validate(document)


class IncompleteMarkerTests(unittest.TestCase):
    """0.8.0: the Incomplete Object (§4.4.6, rule 26)."""

    def document(self):
        return example("incomplete-marker.yaml")

    def scheme(self, document):
        return document["components"]["paginationSchemes"]["cappedQuery"]

    def test_shape(self):
        for mutate in (lambda m: m.pop("equals"),
                       lambda m: m.update({"in": ["incomplete"]}),
                       lambda m: m.update(field=""),
                       lambda m: m.update(field="a..b"),
                       lambda m: m.update(field=".a"),
                       lambda m: m.update(equals={"type": "incomplete"}),
                       lambda m: m.update(extra=1)):
            document = self.document()
            mutate(self.scheme(document)["response"]["incomplete"])
            with self.subTest(), self.assertRaises(ValueError):
                validate(document)
        document = self.document()
        marker = self.scheme(document)["response"]["incomplete"]
        marker.pop("equals")
        marker["in"] = ["incomplete", None, 0, False]
        validate(document)
        # Not allowed in a request.
        document = self.document()
        self.scheme(document)["request"]["incomplete"] = {"field": "a", "equals": 1}
        with self.assertRaises(ValueError):
            validate(document)

    def test_only_on_page_number_token_and_link_schemes(self):
        marker = {"field": "capped", "equals": True}
        for name in ("short-page.yaml", "relative-next-link.yaml", "incomplete-marker.yaml"):
            document = example(name)
            for scheme in document["components"]["paginationSchemes"].values():
                scheme.setdefault("response", {})["incomplete"] = dict(marker)
            with self.subTest(example=name):
                validate(document)
        document = example("range-window.yaml")
        for scheme in document["components"]["paginationSchemes"].values():
            scheme.setdefault("response", {})["incomplete"] = dict(marker)
        with self.assertRaises(ValueError):
            validate(document)
        document = self.document()
        sync = {"type": "incrementalSync", "request": {"queryParameters": {"syncToken": {"role": "syncToken"}}},
                "response": {"bodyFields": {"nextSyncToken": {"role": "nextSyncToken"}}, "incomplete": marker}}
        document["components"]["paginationSchemes"]["sync"] = sync
        with self.assertRaises(ValueError):
            validate(document)
        del sync["response"]["incomplete"]
        validate(document)

    def test_marking(self):
        scheme = self.scheme(self.document())
        marked = {"results": [], "request_status": {"type": "incomplete", "incomplete_reason": "query_result_limit_reached"}}
        self.assertTrue(response_incomplete(scheme, marked))
        for body in ({"results": []}, {"request_status": {"type": "complete"}}, {"request_status": "incomplete"},
                     {"request_status": None}, [], None):
            with self.subTest(body=body):
                self.assertFalse(response_incomplete(scheme, body))
        self.assertFalse(response_incomplete({"type": "pageToken"}, marked))
        # JSON equality: "1" is not 1, True is not 1, 1.0 is 1.
        numeric = {"response": {"incomplete": {"field": "capped", "in": [1]}}}
        self.assertTrue(response_incomplete(numeric, {"capped": 1.0}))
        self.assertFalse(response_incomplete(numeric, {"capped": "1"}))
        self.assertFalse(response_incomplete(numeric, {"capped": True}))

    def test_a_marked_page_makes_page_and_offset_reads_not_complete(self):
        pages = copy.deepcopy(example("short-page.yaml")["components"]["paginationSchemes"]["sizedPages"])
        pages["response"]["incomplete"] = {"field": "capped", "equals": True}
        pages["response"]["envelope"] = {"itemsField": "rows"}

        def wrapped(capped_page):
            def request(values):
                number = values[("queryParameters", "page")]
                rows = [{"id": str(i)} for i in range((number - 1) * 50, min(120, number * 50))]
                return {"rows": rows, "capped": number == capped_page}
            return request

        self.assertTrue(read_pages(pages, wrapped(None), page_size=50)["complete"])
        result = read_pages(pages, wrapped(2), page_size=50)
        self.assertFalse(result["complete"])
        self.assertEqual(len(result["items"]), 120)  # paging is unchanged

        offsets = copy.deepcopy(example("offset-advance.yaml")["components"]["paginationSchemes"]["limitPages"])
        offsets["response"]["incomplete"] = {"field": "capped", "equals": True}

        def by_offset(values):
            offset = values[("queryParameters", "offset")]
            return {"entries": [{"id": str(i)} for i in range(offset, min(30, offset + 10))], "limit": 10,
                    "offset": offset, "total_count": 30, "capped": offset == 10}

        result = read_offsets(offsets, by_offset)
        self.assertFalse(result["complete"])
        self.assertEqual(len(result["items"]), 30)

    def test_a_marked_page_on_the_0_7_1_link_path(self):
        scheme = copy.deepcopy(example("offset-advance.yaml")["components"]["paginationSchemes"]["limitPages"])
        scheme["response"]["bodyFields"]["next"] = {"role": "nextLink"}
        scheme["response"]["incomplete"] = {"field": "capped", "equals": True}

        def page(offset, capped):
            following = offset + 10
            return {"entries": [{"id": str(i)} for i in range(offset, min(30, following))], "limit": 10,
                    "offset": offset, "total_count": 30, "capped": capped,
                    "next": f"/entries?offset={following}" if following < 30 else None}

        def follow(link):
            offset = int(link.split("=")[1])
            return page(offset, offset == 20)

        result = read_offsets(scheme, lambda values: page(0, False), follow=follow)
        self.assertEqual(result["links"], ["/entries?offset=10", "/entries?offset=20"])
        self.assertEqual(len(result["items"]), 30)
        self.assertFalse(result["complete"])
        unmarked = read_offsets(scheme, lambda values: page(0, False), follow=lambda link: {**follow(link), "capped": False})
        self.assertTrue(unmarked["complete"])

    def test_0_7_documents_stay_valid(self):
        for name in ("relative-next-link.yaml", "declared-base.yaml", "range-window.yaml", "short-page.yaml",
                     "empty-when-absent.yaml", "offset-advance.yaml"):
            validate(example(name))


class ItemCursorTests(unittest.TestCase):
    """0.9.0: a cursor read from the last item (§4.3.3, rules 27-29)."""

    def document(self):
        return example("item-cursor.yaml")

    def scheme(self, document):
        return document["components"]["paginationSchemes"]["afterLastObject"]

    def provider(self, total, size=2, has_more=True, key="id"):
        ids = [f"cus_{i:03d}" for i in range(total)]
        calls = []

        def request(values):
            calls.append(values)
            after = values.get(("queryParameters", "starting_after"))
            start = ids.index(after) + 1 if after else 0
            page = [{key: i} for i in ids[start:start + size]]
            body = {"object": "list", "data": page}
            if has_more:
                body["has_more"] = start + size < total
            return body

        return request, calls

    def test_shape(self):
        validate(self.document())
        for mutate in (lambda s: s["request"]["queryParameters"]["limit"].update(fromLastItem="id"),
                       lambda s: s["request"]["queryParameters"]["starting_after"].update(fromLastItem=""),
                       lambda s: s["request"]["queryParameters"]["starting_after"].update(fromLastItem="a..b"),
                       lambda s: s["request"]["queryParameters"]["starting_after"].update(fromLastItem=3),
                       lambda s: s["response"]["bodyFields"].update(next={"role": "nextCursor"}),
                       lambda s: s["request"]["queryParameters"].update(
                           ending_before={"role": "pageToken", "fromLastItem": "id"}),
                       lambda s: s.update(type="nextLink")):
            document = self.document()
            mutate(self.scheme(document))
            with self.subTest(), self.assertRaises(ValueError):
                validate(document)
        # hasMore only in a pageToken scheme.
        document = example("offset-advance.yaml")
        for scheme in document["components"]["paginationSchemes"].values():
            scheme["response"].setdefault("bodyFields", {})["has_more"] = {"role": "hasMore"}
        with self.assertRaises(ValueError):
            validate(document)
        # An override that adds a next token is refused after the merge.
        document = self.document()
        document["paths"]["/v1/customers"]["get"]["x-pagination"][0]["overrides"] = {
            "response": {"bodyFields": {"next": {"role": "nextCursor"}}}}
        with self.assertRaises(ValueError):
            validate(document)

    def test_reads_by_the_last_id_and_ends_at_has_more_false(self):
        request, calls = self.provider(5)
        result = read_item_cursor(self.scheme(self.document()), request, page_size=2)
        self.assertEqual(result["cursors"], [None, "cus_001", "cus_003"])
        self.assertEqual(len(result["items"]), 5)
        self.assertTrue(result["complete"])
        self.assertNotIn(("queryParameters", "starting_after"), calls[0])
        self.assertEqual({c[("queryParameters", "limit")] for c in calls}, {2})

    def test_without_has_more_an_empty_page_ends_it(self):
        request, calls = self.provider(4, has_more=False)
        result = read_item_cursor(self.scheme(self.document()), request)
        self.assertEqual(result["cursors"], [None, "cus_001", "cus_003"])  # the third page is empty
        self.assertEqual(len(result["items"]), 4)
        self.assertTrue(result["complete"])

    def test_integer_ids_are_sent_in_decimal(self):
        scheme = self.scheme(self.document())
        pages = iter([{"data": [{"id": 7}, {"id": 9}]}, {"data": []}])
        sent = []
        result = read_item_cursor(scheme, lambda values: sent.append(values) or next(pages))
        self.assertEqual(sent[1][("queryParameters", "starting_after")], "9")
        self.assertTrue(result["complete"])

    def test_errors_end_the_read(self):
        scheme = self.scheme(self.document())
        for pages, message in (
                ([{"data": [{"name": "x"}], "has_more": True}], "no usable id"),
                ([{"data": [{"id": True}], "has_more": True}], "no usable id"),
                ([{"data": [{"id": "a"}], "has_more": True}, {"data": [{"id": "b"}, {"id": "a"}], "has_more": True}],
                 "earlier page"),
        ):
            source = iter(pages)
            with self.subTest(message=message), self.assertRaises(PageReadError) as raised:
                read_item_cursor(scheme, lambda values: next(source), identity=lambda item: item.get("id"))
            self.assertIn(message, str(raised.exception))
        # A server that ignores the cursor repeats the page: an error, not a loop.
        with self.assertRaises(PageReadError):
            read_item_cursor(scheme, lambda values: {"data": [{"id": "a"}], "has_more": True},
                             identity=lambda item: object())
        request, _ = self.provider(10)
        with self.assertRaises(PageReadError):
            read_item_cursor(scheme, request, max_pages=2)

    def test_a_marked_page_is_not_complete(self):
        scheme = copy.deepcopy(self.scheme(self.document()))
        scheme["response"]["incomplete"] = {"field": "capped", "equals": True}
        request, _ = self.provider(5)
        marked = lambda values: {**request(values), "capped": True}
        self.assertFalse(read_item_cursor(scheme, marked)["complete"])
        # Only the first page marked: still not complete.
        request, calls = self.provider(5)
        first_only = lambda values: {**request(values), "capped": len(calls) == 1}
        result = read_item_cursor(scheme, first_only)
        self.assertEqual(len(result["items"]), 5)
        self.assertFalse(result["complete"])

    def test_an_empty_page_with_has_more_true_is_an_error(self):
        scheme = self.scheme(self.document())
        pages = iter([{"data": [{"id": "a"}], "has_more": True}, {"data": [], "has_more": True}])
        with self.assertRaises(PageReadError) as raised:
            read_item_cursor(scheme, lambda values: next(pages))
        self.assertIn("hasMore true", str(raised.exception))
        # Without has_more, an empty page ends it complete.
        pages = iter([{"data": [{"id": "a"}]}, {"data": []}])
        self.assertTrue(read_item_cursor(scheme, lambda values: next(pages))["complete"])

    def test_a_has_more_that_is_not_a_boolean_is_an_error(self):
        scheme = self.scheme(self.document())
        for value in ("false", "true", 0, 1, None, []):
            pages = iter([{"data": [{"id": "a"}], "has_more": value}, {"data": []}])
            with self.subTest(value=value), self.assertRaises(PageReadError) as raised:
                read_item_cursor(scheme, lambda values: next(pages))
            self.assertIn("not a boolean", str(raised.exception))
        # Absent is still fine.
        pages = iter([{"data": [{"id": "a"}]}, {"data": []}])
        self.assertTrue(read_item_cursor(scheme, lambda values: next(pages))["complete"])

    def test_floats_are_refused_and_items_without_an_id_use_the_whole_item(self):
        scheme = self.scheme(self.document())
        pages = iter([{"data": [{"id": 1.5}], "has_more": True}])
        with self.assertRaises(PageReadError):
            read_item_cursor(scheme, lambda values: next(pages))
        # The default identity does not need an id field: no KeyError.
        scheme = copy.deepcopy(scheme)
        scheme["request"]["queryParameters"]["starting_after"]["fromLastItem"] = "key"
        pages = iter([{"data": [{"key": "a"}, {"key": "b"}]}, {"data": []}])
        self.assertTrue(read_item_cursor(scheme, lambda values: next(pages))["complete"])

    def test_rules_28_and_29_review(self):
        for mutate in (lambda s: s["response"]["bodyFields"].update(next={"role": "nextLink"}),
                       lambda s: s["response"].update(headers={"X-Has-More": {"role": "hasMore"}})):
            document = self.document()
            mutate(self.scheme(document))
            with self.subTest(), self.assertRaises(ValueError):
                validate(document)
        # hasMore without fromLastItem, even in a pageToken scheme.
        document = self.document()
        del self.scheme(document)["request"]["queryParameters"]["starting_after"]["fromLastItem"]
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("rule 29", str(raised.exception))

    def test_0_8_documents_stay_valid(self):
        for name in ("relative-next-link.yaml", "declared-base.yaml", "range-window.yaml", "short-page.yaml",
                     "empty-when-absent.yaml", "offset-advance.yaml", "incomplete-marker.yaml"):
            validate(example(name))



class ItemOrderTests(unittest.TestCase):
    """0.10.0: order beside fromLastItem (§4.3.3, rule 30)."""

    def document(self):
        return example("item-order.yaml")

    def scheme(self, document=None):
        return (document or self.document())["components"]["paginationSchemes"]["beforeLastMessage"]

    def test_shape(self):
        validate(self.document())
        for mutate in (lambda f: f.update(order="newest"),
                       lambda f: f.pop("fromLastItem")):
            document = self.document()
            mutate(self.scheme(document)["request"]["queryParameters"]["before"])
            with self.subTest(), self.assertRaises(ValueError):
                validate(document)
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["limit"]["order"] = "ascending"
        with self.assertRaises(ValueError):
            validate(document)

    def pages(self, *pages):
        source = iter(list(pages) + [[]])
        return lambda values: next(source)

    def test_descending_snowflakes_read_newest_to_oldest(self):
        request = self.pages([{"id": "1300000000000000010"}, {"id": "1300000000000000009"}],
                             [{"id": "999999999999999999"}])  # fewer digits, still smaller as a number
        result = read_item_cursor(self.scheme(), request)
        self.assertEqual(result["cursors"], [None, "1300000000000000009", "999999999999999999"])
        self.assertTrue(result["complete"])

    def test_out_of_order_ends_the_read(self):
        for pages in (([{"id": "10"}, {"id": "11"}],),                    # within a page
                      ([{"id": "10"}, {"id": "9"}], [{"id": "9"}]),       # equal across pages (not strict)
                      ([{"id": "10"}], [{"id": "12"}])):                  # across pages
            with self.subTest(pages=pages), self.assertRaises(PageReadError) as raised:
                read_item_cursor(self.scheme(), self.pages(*pages), identity=lambda item: object())
            self.assertIn("out of descending order", str(raised.exception))

    def test_values_that_cannot_be_ordered(self):
        for pages in (([{"id": "10"}, {"id": "abc"}],), ([{"id": "10"}, {"id": "-1"}],), ([{"id": -1}],),
                      ([{"id": 1.5}],), ([{"id": True}],)):
            with self.subTest(pages=pages), self.assertRaises(PageReadError):
                read_item_cursor(self.scheme(), self.pages(*pages), identity=lambda item: object())

    def test_text_values_compare_by_code_point_and_ascending_works(self):
        scheme = copy.deepcopy(self.scheme())
        scheme["request"]["queryParameters"]["before"]["order"] = "ascending"
        result = read_item_cursor(scheme, self.pages([{"id": "a1"}, {"id": "a2"}], [{"id": "b"}]))
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["items"]), 3)
        # Without order nothing is checked.
        del scheme["request"]["queryParameters"]["before"]["order"]
        self.assertTrue(read_item_cursor(scheme, self.pages([{"id": "b"}, {"id": "a"}]))["complete"])

    def test_0_9_documents_stay_valid(self):
        validate(example("item-cursor.yaml"))



if __name__ == "__main__":
    unittest.main()


class EmptyWhenAbsentTests(unittest.TestCase):
    """0.7.0: emptyWhenAbsent on the Envelope Object (§4.4.2, rule 23)."""

    def document(self):
        return example("empty-when-absent.yaml")

    def scheme(self, document):
        return document["components"]["paginationSchemes"]["googleTasks"]

    def assertInvalid(self, document, fragment):
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_only_a_boolean_with_a_non_empty_items_field(self):
        for mutate in (lambda e: e.update(emptyWhenAbsent="true"), lambda e: e.pop("itemsField"),
                       lambda e: e.update(itemsField=None), lambda e: e.update(itemsField="")):
            document = self.document()
            mutate(self.scheme(document)["response"]["envelope"])
            self.assertInvalid(document, "googleTasks")
        document = self.document()
        self.scheme(document)["response"]["envelope"]["emptyWhenAbsent"] = False
        validate(document)

    def test_0_6_documents_stay_valid(self):
        for name in ("relative-next-link.yaml", "declared-base.yaml", "range-window.yaml", "short-page.yaml"):
            validate(example(name))

    def test_an_absent_field_is_a_page_with_no_items_only_when_declared(self):
        scheme = self.scheme(self.document())
        self.assertEqual(page_items({"kind": "tasks#tasks", "etag": "e1"}, scheme), [])
        self.assertEqual(page_items({"items": [{"id": "t1"}]}, scheme), [{"id": "t1"}])
        del scheme["response"]["envelope"]["emptyWhenAbsent"]
        with self.assertRaises(PageReadError):
            page_items({"kind": "tasks#tasks"}, scheme)

    def test_a_present_value_that_is_not_an_array_is_an_error_either_way(self):
        scheme = self.scheme(self.document())
        for body in ({"items": None}, {"items": {}}, {"items": "t1"}, ["t1"], None):
            with self.subTest(body=body):
                with self.assertRaises(PageReadError):
                    page_items(body, scheme)

    def test_a_dot_path_is_absent_where_an_object_lacks_the_next_segment(self):
        scheme = {"response": {"envelope": {"itemsField": "data.items", "emptyWhenAbsent": True}}}
        self.assertEqual(page_items({}, scheme), [])
        self.assertEqual(page_items({"data": {}}, scheme), [])
        for body in ({"data": None}, {"data": []}, {"data": "x"}):
            with self.subTest(body=body):
                with self.assertRaises(PageReadError):
                    page_items(body, scheme)

    def test_read_pages_ends_on_an_absent_items_field(self):
        scheme = {
            "type": "pageNumber",
            "request": {"queryParameters": {"page": {"role": "page"}}},
            "response": {"envelope": {"itemsField": "items", "emptyWhenAbsent": True},
                         "shortPage": {"size": 2, "assurance": "documented"}},
        }
        pages = {1: {"items": [{"id": "a"}, {"id": "b"}]}, 2: {"kind": "list"}}
        result = read_pages(scheme, lambda values: pages[values[("queryParameters", "page")]])
        self.assertEqual([item["id"] for item in result["items"]], ["a", "b"])
        self.assertTrue(result["complete"])


class OffsetAdvanceTests(unittest.TestCase):
    """0.7.0: advance on an offset field (§4.3.2, rules 24 and 25)."""

    def document(self):
        return example("offset-advance.yaml")

    def scheme(self, document, name="limitPages"):
        return document["components"]["paginationSchemes"][name]

    def assertInvalid(self, document, fragment):
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_advance_only_on_offset_and_only_two_values(self):
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["offset"]["advance"] = "limit"
        self.assertInvalid(document, "limitPages")
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["limit"]["advance"] = "pageSize"
        self.assertInvalid(document, "limitPages")
        document = self.document()
        self.scheme(document)["request"]["queryParameters"]["offset"]["advance"] = "itemCount"
        validate(document)

    def test_page_size_advance_needs_a_page_size_field(self):
        document = self.document()
        del self.scheme(document)["request"]["queryParameters"]["limit"]
        validate(document)  # the response's limit field still gives it
        del self.scheme(document)["response"]["bodyFields"]["limit"]
        self.assertInvalid(document, "rule 25")

    def test_0_6_documents_stay_valid(self):
        for name in ("relative-next-link.yaml", "declared-base.yaml", "range-window.yaml", "short-page.yaml"):
            validate(example(name))

    def provider(self, entries, limit, total=None, holes=()):
        """`entries` items, `limit` offsets per page; offsets in `holes` hold no item."""
        def request(values):
            offset = values[("queryParameters", "offset")]
            page = [{"id": str(i)} for i in range(offset, min(entries, offset + limit)) if i not in holes]
            return {"entries": page, "limit": limit, "offset": offset,
                    "total_count": entries if total is None else total}
        return request

    def test_page_size_advance_steps_by_the_limit_over_short_and_empty_pages(self):
        scheme = self.scheme(self.document())
        # Offsets 2-5 hold nothing the caller may see: page 0 is short and page 4 empty.
        result = read_offsets(scheme, self.provider(10, 4, holes={2, 3, 4, 5, 6, 7}), page_size=4)
        self.assertEqual(result["offsets"], [0, 4, 8])
        self.assertEqual([item["id"] for item in result["items"]], ["0", "1", "8", "9"])

    def test_page_size_advance_runs_to_a_total_count_above_the_items(self):
        scheme = self.scheme(self.document())
        result = read_offsets(scheme, self.provider(5, 2, total=8), page_size=2)
        self.assertEqual(result["offsets"], [0, 2, 4, 6])
        self.assertEqual(len(result["items"]), 5)

    def test_item_count_advance_reads_a_short_page_again_and_stops_at_an_empty_one(self):
        scheme = self.scheme(self.document())
        del scheme["request"]["queryParameters"]["offset"]["advance"]
        with self.assertRaises(PageReadError):
            read_offsets(scheme, self.provider(10, 4, holes={2, 3}), page_size=4)
        result = read_offsets(scheme, self.provider(10, 4, holes={4, 5, 6, 7}), page_size=4)
        self.assertEqual([item["id"] for item in result["items"]], ["0", "1", "2", "3"])

    def test_page_size_advance_without_any_page_size_is_an_error(self):
        scheme = self.scheme(self.document())
        del scheme["response"]["bodyFields"]["limit"]
        with self.assertRaises(PageReadError):
            read_offsets(scheme, lambda values: {"entries": [{"id": "a"}], "total_count": 5})


class OffsetAdvanceValueTests(unittest.TestCase):
    """0.7.0 review: reported values are integers, read per response (§4.3.2)."""

    def scheme(self):
        return example("offset-advance.yaml")["components"]["paginationSchemes"]["limitPages"]

    def test_a_reported_page_size_that_is_not_an_integer_of_at_least_1_is_not_used(self):
        for reported in (2.5, "2", 0, -2, True):
            with self.subTest(reported=reported):
                offsets = []

                def request(values):
                    offset = values[("queryParameters", "offset")]
                    offsets.append(offset)
                    page = [{"id": str(i)} for i in range(offset, min(6, offset + 3))]
                    return {"entries": page, "limit": reported, "total_count": 6}

                read_offsets(self.scheme(), request, page_size=3)
                self.assertEqual(offsets, [0, 3])

    def test_a_total_count_that_is_not_an_integer_is_not_carried(self):
        def request(values):
            offset = values[("queryParameters", "offset")]
            page = [{"id": str(i)} for i in range(offset, min(4, offset + 2))]
            return {"entries": page, "limit": 2, "total_count": "4"}

        result = read_offsets(self.scheme(), request)
        self.assertEqual(result["offsets"], [0, 2, 4])

    def test_a_declared_next_link_leads_and_a_null_link_ends_the_read_under_either_rule(self):
        # 0.7.1: offsets are not used after the first request; the link leads.
        for advance in ("pageSize", "itemCount"):
            for total in (None, 6):
                with self.subTest(advance=advance, total=total):
                    scheme = self.scheme()
                    scheme["request"]["queryParameters"]["offset"]["advance"] = advance
                    scheme["response"]["bodyFields"]["next"] = {"role": "nextLink"}

                    def body(offset):
                        page = [{"id": str(i)} for i in range(offset, min(6, offset + 2))]
                        following = offset + 2
                        answer = {"entries": page, "limit": 2,
                                  "next": f"https://api.example.com/items?offset={following}" if following < 6 else None}
                        if total is not None:
                            answer["total_count"] = total
                        return answer

                    result = read_offsets(scheme, lambda values: body(values[("queryParameters", "offset")]),
                                          follow=lambda link: body(int(link.rsplit("=", 1)[1])), max_pages=10)
                    self.assertEqual([item["id"] for item in result["items"]], ["0", "1", "2", "3", "4", "5"])
                    self.assertEqual(result["offsets"], [0])
                    self.assertEqual(len(result["links"]), 2)
                    self.assertTrue(result["complete"])
        # An absent link while totalCount says more: ends, not complete.
        scheme = self.scheme()
        scheme["response"]["bodyFields"]["next"] = {"role": "nextLink"}
        result = read_offsets(scheme, lambda values: {"entries": [{"id": "a"}], "limit": 2, "total_count": 5},
                              follow=lambda link: {"entries": []})
        self.assertEqual(result["offsets"], [0])
        self.assertFalse(result["complete"])
        with self.assertRaises(ValueError):
            scheme = self.scheme()
            scheme["response"]["bodyFields"]["next"] = {"role": "nextLink"}
            read_offsets(scheme, lambda values: {"entries": []})

    def test_a_server_that_ignores_the_offset_ends_the_read_under_either_rule(self):
        for advance in ("pageSize", "itemCount"):
            with self.subTest(advance=advance):
                scheme = self.scheme()
                scheme["request"]["queryParameters"]["offset"]["advance"] = advance
                del scheme["response"]["bodyFields"]["total_count"]
                with self.assertRaises(PageReadError):
                    read_offsets(scheme, lambda values: {"entries": [{"id": "a"}, {"id": "b"}], "limit": 2},
                                 max_pages=50)
