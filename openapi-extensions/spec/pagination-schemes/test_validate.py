"""Pagination Schemes 0.6.0: schema, document validator, examples, link resolution and range windows."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import LinkRefused, PageReadError, WindowReadError, halves, read_pages, read_range, resolve_link, rfc3986_resolve, validate, window_request

ROOT = pathlib.Path(__file__).parent
EXAMPLES = ("relative-next-link.yaml", "declared-base.yaml", "range-window.yaml", "short-page.yaml")


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
        self.assertInvalid(document, "needs a request field with role page")

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
        self.assertIn("repeats", str(raised.exception))

    def test_page_budget_ends_the_read_incomplete(self):
        request, _ = self.provider(1000, 100)
        with self.assertRaises(PageReadError):
            read_pages(self.zero, request, max_pages=3)


if __name__ == "__main__":
    unittest.main()
