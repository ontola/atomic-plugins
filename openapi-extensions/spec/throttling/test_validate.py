"""Executable examples and invalid declarations for the draft."""
import unittest
from validate import validate

class ValidationTests(unittest.TestCase):
    def document(self):
        return {"x-throttling": {"limits": {
            "ip": {"requests": 150, "window": {"seconds": 300, "kind": "unspecified"}, "partitionBy": ["sourceIp"]},
            "user": {"window": {"seconds": 30, "kind": "sliding"}}},
            "applies": ["ip", "user"]}, "paths": {"/status": {"get": {"x-throttling": []}}}}

    def test_valid_unknown_amount_and_partition_and_empty_selection(self):
        validate(self.document())

    def test_joint_and_independent_partitions(self):
        d = self.document()
        d["x-throttling"]["limits"]["user"]["partitionBy"] = ["sourceIp", "session"]
        validate(d)
        d["x-throttling"]["limits"]["user"]["partitionBy"] = []
        validate(d)

    def test_rejects_nonpositive_and_boolean_numbers(self):
        for value in (0, -1, True, 1.5, "150"):
            d = self.document()
            d["x-throttling"]["limits"]["ip"]["requests"] = value
            with self.assertRaises(ValueError): validate(d)

    def test_rejects_missing_duplicate_or_undefined_bucket_references(self):
        for refs in (["missing"], ["ip", "ip"], "ip"):
            d = self.document()
            d["paths"]["/status"]["get"]["x-throttling"] = refs
            with self.assertRaises(ValueError): validate(d)
        d = self.document()
        del d["x-throttling"]
        with self.assertRaises(ValueError): validate(d)

    def test_anchor_requires_fixed_and_valid_timestamp(self):
        d = self.document()
        window = d["x-throttling"]["limits"]["ip"]["window"]
        window.update(kind="fixed", anchor="2026-01-01T00:00:00Z")
        validate(d)
        for kind, anchor in (("sliding", "2026-01-01T00:00:00Z"), ("fixed", "2026-99-99T00:00:00Z"), ("fixed", "2026-01-01T00:00:00")):
            window.update(kind=kind, anchor=anchor)
            with self.assertRaises(ValueError): validate(d)

    def test_dimension_names_are_unique_and_extensible_by_uri(self):
        d = self.document()
        limit = d["x-throttling"]["limits"]["ip"]
        limit["partitionBy"] = ["urn:example:device"]
        validate(d)
        for values in (["sourceIp", "sourceIp"], ["typo"], None):
            limit["partitionBy"] = values
            with self.assertRaises(ValueError): validate(d)

import copy
import pathlib

import yaml

from validate import classify, fallback_window, limits_in_force

EXAMPLES = pathlib.Path(__file__).parent / "examples"
NOW = 1_800_000_000


def example(name):
    return yaml.safe_load((EXAMPLES / name).read_text(encoding="utf-8"))


class HeadersAndSignalsValidationTests(unittest.TestCase):
    def document(self):
        return example("response-signals.yaml")

    def invalid(self, mutate):
        d = self.document()
        mutate(d["x-throttling"])
        with self.assertRaises(ValueError):
            validate(d)

    def test_examples_are_valid(self):
        validate(example("windowed.yaml"))
        validate(self.document())

    def test_readme_snippets_validate_on_their_own(self):
        readme = (EXAMPLES.parent / "README.md").read_text(encoding="utf-8")
        snippets = [block for block in readme.split("```yaml\n")[1:] if block.startswith("x-throttling:")]
        self.assertGreaterEqual(len(snippets), 4)
        for snippet in snippets:
            validate(yaml.safe_load(snippet.split("```")[0]))

    def test_signals_or_headers_without_limits(self):
        d = self.document()
        root = d["x-throttling"]
        del root["limits"], root["applies"], root["signals"][0]["bucket"]
        validate(d)
        del root["headers"]
        validate(d)
        self.invalid(lambda r: r.clear())
        self.invalid(lambda r: r.pop("applies"))
        self.invalid(lambda r: r.update(extra=1))

    def test_header_roles_and_units(self):
        self.invalid(lambda r: r["headers"].update({"x-ratelimit-reset": {"role": "reset", "unit": "epochSeconds"}}))  # case duplicate
        self.invalid(lambda r: r["headers"].update({"X-Other": {"role": "remaining"}}))  # role twice
        self.invalid(lambda r: r["headers"]["X-RateLimit-Reset"].pop("unit"))
        self.invalid(lambda r: r["headers"]["X-RateLimit-Reset"].update(unit="minutes"))
        self.invalid(lambda r: r["headers"]["X-RateLimit-Limit"].update(unit="deltaSeconds"))
        self.invalid(lambda r: r["headers"]["X-RateLimit-Limit"].update(role="quota"))
        self.invalid(lambda r: r.update(headers={}))
        for unit in ("epochSeconds", "deltaSeconds", "httpDate", "deltaSecondsOrHttpDate"):
            d = self.document()
            d["x-throttling"]["headers"]["Retry-After"]["unit"] = unit
            validate(d)

    def test_signal_fields(self):
        self.invalid(lambda r: r.update(signals=[]))
        for status in ([], [99], [600], [403, 403], ["403"], [True], 403):
            self.invalid(lambda r, s=status: r["signals"][0].update(status=s))
        self.invalid(lambda r: r["signals"][0].update(meaning="limited"))
        self.invalid(lambda r: r["signals"][0].pop("meaning"))
        self.invalid(lambda r: r["signals"][0].update(bucket="missing"))
        self.invalid(lambda r: r["signals"][3].update(minDelaySeconds=0))
        self.invalid(lambda r: r["signals"][0].update(retry=True))

    def test_predicates_need_exactly_one_operator(self):
        self.invalid(lambda r: r["signals"][0]["header"].update(present=True))
        self.invalid(lambda r: r["signals"][0]["header"].pop("equals"))
        self.invalid(lambda r: r["signals"][0]["header"].update(equals=0))
        self.invalid(lambda r: r["signals"][0]["header"].update(name=""))
        self.invalid(lambda r: r["signals"][0].update(header={"name": "x-ratelimit-remaining", "in": []}))
        self.invalid(lambda r: r["signals"][1]["header"].update(present=False))
        self.invalid(lambda r: r["signals"][0].update(header={"name": "x", "contains": "0"}))
        self.invalid(lambda r: r["signals"][2]["body"].update(pointer="error/errors"))
        self.invalid(lambda r: r["signals"][2]["body"].update(pointer="/a~2b"))
        self.invalid(lambda r: r["signals"][2]["body"]["item"].update(equals="x"))
        self.invalid(lambda r: r["signals"][2]["body"]["item"].update(**{"in": []}))
        self.invalid(lambda r: r["signals"][2]["body"]["item"].update(**{"in": [{"a": 1}]}))
        self.invalid(lambda r: r["signals"][3]["body"].update(contains=""))
        self.invalid(lambda r: r["signals"][3]["body"].update(contains=None))
        d = self.document()
        d["x-throttling"]["signals"][3]["body"] = {"pointer": "", "present": True}
        validate(d)
        d["x-throttling"]["signals"][3]["body"] = {"pointer": "/a~0b/~1c/0", "equals": None}
        validate(d)


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.document = example("response-signals.yaml")

    def classify(self, status, headers=None, body=None):
        return classify(self.document, status, headers or {}, body, NOW)

    def test_primary_limit_waits_for_reset(self):
        result = self.classify(403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(NOW + 900)})
        self.assertEqual(result, {"meaning": "quotaExhausted", "bucket": "core", "retryAt": NOW + 900})

    def test_retry_after_and_reset_take_the_later(self):
        result = self.classify(429, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(NOW + 30), "retry-after": "120"})
        self.assertEqual(result["retryAt"], NOW + 120)
        result = self.classify(429, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(NOW + 300), "retry-after": "120"})
        self.assertEqual(result["retryAt"], NOW + 300)

    def test_reset_is_ignored_while_requests_remain(self):
        result = self.classify(403, {"x-ratelimit-remaining": "17", "x-ratelimit-reset": str(NOW + 900), "retry-after": "5"})
        self.assertEqual(result, {"meaning": "throttled", "bucket": None, "retryAt": NOW + 5})

    def test_http_date_measured_against_the_date_header(self):
        headers = {"retry-after": "Fri, 15 Jan 2027 08:01:00 GMT", "date": "Fri, 15 Jan 2027 08:00:00 GMT"}
        self.assertEqual(self.classify(429, headers)["retryAt"], NOW + 60)

    def test_unparseable_header_is_ignored_not_guessed(self):
        result = self.classify(429, {"retry-after": "soon"})
        self.assertEqual(result, {"meaning": "throttled", "bucket": None, "retryAt": None})

    def test_google_reason_inside_the_error_array(self):
        body = {"error": {"errors": [{"domain": "global", "reason": "other"},
                                     {"domain": "usageLimits", "reason": "userRateLimitExceeded"}], "code": 403}}
        self.assertEqual(self.classify(403, body=body)["meaning"], "throttled")
        body["error"]["errors"][1]["reason"] = "insufficientPermissions"
        self.assertIsNone(self.classify(403, body=body))

    def test_secondary_message_is_case_insensitive_with_minimum_delay(self):
        body = {"message": "You have exceeded a Secondary Rate Limit. Please wait."}
        self.assertEqual(self.classify(403, body=body), {"meaning": "throttled", "bucket": None, "retryAt": NOW + 60})
        self.assertIsNone(self.classify(403, body={"message": "Resource not accessible by integration"}))
        self.assertIsNone(self.classify(403, body="not json"))

    def test_403_without_a_matching_signal_is_not_throttling(self):
        self.assertIsNone(self.classify(403, {"x-ratelimit-remaining": "4999"}))
        self.assertIsNone(self.classify(401, {"retry-after": "5"}))

    def test_429_is_always_throttling(self):
        document = copy.deepcopy(self.document)
        document["x-throttling"]["signals"] = [{"status": [403], "meaning": "throttled"}]
        self.assertEqual(classify(document, 429, {}, None, NOW)["meaning"], "throttled")
        del document["x-throttling"]["signals"]
        self.assertEqual(classify(document, 429, {"Retry-After": "7"}, None, NOW)["retryAt"], NOW + 7)
        self.assertIsNone(classify(document, 403, {"Retry-After": "7"}, None, NOW))

    def test_a_wrong_date_header_never_makes_the_retry_earlier(self):
        headers = {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(NOW + 900),
                   "date": "Fri, 01 Jan 2100 00:00:00 GMT"}
        self.assertEqual(self.classify(403, headers)["retryAt"], NOW + 900)
        # A server clock 100 s behind ours moves the reset later, never earlier.
        headers["date"] = "Fri, 15 Jan 2027 07:58:20 GMT"
        self.assertEqual(self.classify(403, headers)["retryAt"], NOW + 1000)

    def test_huge_and_malformed_numbers_are_ignored(self):
        for value in ("9" * 5000, "-5", "5.5", "1e3", ""):
            with self.subTest(value=value[:10]):
                result = self.classify(429, {"retry-after": value, "x-ratelimit-remaining": "0", "x-ratelimit-reset": value})
                # Neither header parses, so the quotaExhausted signal's bucket window is the floor.
                self.assertEqual(result, {"meaning": "quotaExhausted", "bucket": "core", "retryAt": NOW + 3600})

    def test_obsolete_http_date_without_zone_is_gmt(self):
        self.assertEqual(self.classify(429, {"retry-after": "Fri Jan 15 08:02:00 2027"})["retryAt"], NOW + 120)

    def test_window_is_the_floor_for_quota_exhausted_without_times(self):
        document = copy.deepcopy(self.document)
        document["x-throttling"]["signals"] = [{"status": [429], "meaning": "quotaExhausted", "bucket": "core"}]
        self.assertEqual(classify(document, 429, {}, None, NOW)["retryAt"], NOW + 3600)
        self.assertEqual(classify(document, 429, {"retry-after": "5"}, None, NOW)["retryAt"], NOW + 5)

    def test_repeated_headers_have_no_value_and_values_are_stripped(self):
        self.assertIsNone(self.classify(403, {"x-ratelimit-remaining": ["0", "0"]}))
        self.assertEqual(self.classify(403, {"x-ratelimit-remaining": " 0 "})["meaning"], "quotaExhausted")
        self.assertEqual(self.classify(403, {"x-ratelimit-remaining": ["0"]})["meaning"], "quotaExhausted")
        # present still matches a repeated header; its value is not used as a time.
        self.assertEqual(self.classify(403, {"retry-after": ["5", "6"]}), {"meaning": "throttled", "bucket": None, "retryAt": None})

    def test_first_matching_signal_wins(self):
        # Remaining 0 and Retry-After: the quotaExhausted signal comes first.
        result = self.classify(403, {"x-ratelimit-remaining": "0", "retry-after": "10"})
        self.assertEqual(result["meaning"], "quotaExhausted")


class BodyFieldTests(unittest.TestCase):
    """0.3.0: roles read from the JSON body (Todoist's error_extra.retry_after)."""

    def document(self):
        return {"x-throttling": {"bodyFields": {"error_extra.retry_after": {"role": "retryAfter", "unit": "deltaSeconds"}}}}

    def test_validation(self):
        validate(self.document())
        for mutate in (lambda r: r.update(bodyFields={}),
                       lambda r: r["bodyFields"]["error_extra.retry_after"].pop("unit"),
                       lambda r: r["bodyFields"].update({"other": {"role": "retryAfter", "unit": "deltaSeconds"}}),
                       lambda r: r["bodyFields"]["error_extra.retry_after"].update(role="wait")):
            d = self.document()
            mutate(d["x-throttling"])
            with self.assertRaises(ValueError):
                validate(d)
        # Body paths are case-sensitive: these are two names (but each role only once).
        d = self.document()
        d["x-throttling"]["bodyFields"]["Error_extra.limit"] = {"role": "limit"}
        validate(d)

    def test_retry_after_from_the_body(self):
        body = {"error": "Too many requests", "http_code": 429, "error_extra": {"retry_after": 3, "event_id": "x"}}
        self.assertEqual(classify(self.document(), 429, {}, body, NOW), {"meaning": "throttled", "bucket": None, "retryAt": NOW + 3})
        # A string digit sequence parses too; booleans, floats and objects do not.
        body["error_extra"]["retry_after"] = "7"
        self.assertEqual(classify(self.document(), 429, {}, body, NOW)["retryAt"], NOW + 7)
        for value in (True, 3.5, {"s": 3}, None):
            body["error_extra"]["retry_after"] = value
            self.assertIsNone(classify(self.document(), 429, {}, body, NOW)["retryAt"])
        # A non-throttling response's body field says nothing.
        body["error_extra"]["retry_after"] = 3
        self.assertIsNone(classify(self.document(), 404, {}, body, NOW))

    def test_header_and_body_for_one_role(self):
        d = self.document()
        d["x-throttling"]["headers"] = {"Retry-After": {"role": "retryAfter", "unit": "deltaSecondsOrHttpDate"}}
        body = {"error_extra": {"retry_after": 3}}
        self.assertEqual(classify(d, 429, {"Retry-After": "10"}, body, NOW)["retryAt"], NOW + 10)  # the later time
        self.assertEqual(classify(d, 429, {"Retry-After": "1"}, body, NOW)["retryAt"], NOW + 3)
        # remaining: either value at 0 means exhausted.
        d = {"x-throttling": {"headers": {"X-Remaining": {"role": "remaining"}, "X-Reset": {"role": "reset", "unit": "deltaSeconds"}},
                              "bodyFields": {"remaining": {"role": "remaining"}}}}
        self.assertEqual(classify(d, 429, {"X-Remaining": "5", "X-Reset": "60"}, {"remaining": 0}, NOW)["retryAt"], NOW + 60)
        self.assertEqual(classify(d, 429, {"X-Remaining": "5", "X-Reset": "60"}, {"remaining": 2}, NOW)["retryAt"], None)
        self.assertEqual(classify(d, 429, {"X-Remaining": "x", "X-Reset": "60"}, {"remaining": 0}, NOW)["retryAt"], NOW + 60)


class BodyFieldFollowUpTests(unittest.TestCase):
    """#454 follow-ups: dot-paths, text forms, zero waits, fallbacks."""

    def document(self, min_delay=None):
        d = example("body-fields.yaml")
        if min_delay:
            d["x-throttling"]["signals"][0]["minDelaySeconds"] = min_delay
        return d

    def test_example_is_valid(self):
        validate(self.document())

    def test_invalid_dot_paths(self):
        for path in ("a..b", ".a", "a."):
            d = self.document()
            d["x-throttling"]["bodyFields"] = {path: {"role": "retryAfter", "unit": "deltaSeconds"}}
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate(d)

    def test_text_forms(self):
        for value, expected in ((" 3 ", NOW + 3), (3.0, NOW + 3), (3.5, None), (-1.0, None), ("", None)):
            body = {"error_extra": {"retry_after": value}}
            with self.subTest(value=value):
                self.assertEqual(classify(self.document(), 429, {}, body, NOW)["retryAt"], expected)

    def test_whitespace_and_large_integers(self):
        for value, expected in (("\t3\r\n", NOW + 3), ("\u00a03", None), ("3\u3000", None),
                                (float(2 ** 53 - 1), NOW + 2 ** 53 - 1), (1e21, None), (1e300, None),
                                (2 ** 53 - 1, NOW + 2 ** 53 - 1), (2 ** 53, None), (10 ** 400, None),
                                ("9" * 400, None), ("9" * 5000, None)):
            body = {"error_extra": {"retry_after": value}}
            with self.subTest(value=str(value)[:20]):
                self.assertEqual(classify(self.document(), 429, {}, body, NOW)["retryAt"], expected)
        d = {"x-throttling": {"headers": {"Retry-After": {"role": "retryAfter", "unit": "deltaSeconds"}}}}
        self.assertEqual(classify(d, 429, {"Retry-After": " \t5\t "}, None, NOW)["retryAt"], NOW + 5)
        self.assertIsNone(classify(d, 429, {"Retry-After": "\u00a05"}, None, NOW)["retryAt"])
        self.assertIsNone(classify(d, 429, {"Retry-After": "1" + "0" * 400}, None, NOW)["retryAt"])

    def test_a_zero_header_wait_counts_beside_a_zero_body_wait(self):
        # Ignored by source, not by value: the header's Retry-After: 0 is a wait of 0, not absent.
        d = self.document(min_delay=30)
        d["x-throttling"]["headers"] = {"Retry-After": {"role": "retryAfter", "unit": "deltaSeconds"}}
        body = {"error_extra": {"retry_after": 0}}
        self.assertEqual(classify(d, 429, {"Retry-After": "0"}, body, NOW)["retryAt"], NOW)
        self.assertEqual(classify(d, 429, {}, body, NOW)["retryAt"], NOW + 30)
        # The #472 review's case: the same value and unit on both sides.
        d = {"x-throttling": {"headers": {"Retry-After": {"role": "retryAfter", "unit": "deltaSecondsOrHttpDate"}},
                              "bodyFields": {"w": {"role": "retryAfter", "unit": "deltaSecondsOrHttpDate"}},
                              "signals": [{"status": [429], "meaning": "throttled", "minDelaySeconds": 30}]}}
        validate(d)
        self.assertEqual(classify(d, 429, {"Retry-After": "0"}, {"w": 0}, NOW)["retryAt"], NOW)
        self.assertEqual(classify(d, 429, {}, {"w": 0}, NOW)["retryAt"], NOW + 30)

    def test_a_zero_body_wait_does_not_suppress_the_fallback(self):
        body = {"error_extra": {"retry_after": 0}}
        self.assertEqual(classify(self.document(min_delay=30), 429, {}, body, NOW)["retryAt"], NOW + 30)
        self.assertIsNone(classify(self.document(), 429, {}, body, NOW)["retryAt"])
        # A positive body wait shorter than minDelaySeconds is used as it is: a fallback, not a floor.
        body = {"error_extra": {"retry_after": 5}}
        self.assertEqual(classify(self.document(min_delay=30), 429, {}, body, NOW)["retryAt"], NOW + 5)


class BlockedTests(unittest.TestCase):
    """0.4.0: a refusal the API documents as not worth retrying (Notion's public_api_request_blocked)."""

    def document(self):
        return example("blocked.yaml")

    def body(self, reason):
        return {"object": "error", "status": 429, "code": "rate_limited",
                "additional_data": {"rate_limit_reason": reason}}

    def test_example_is_valid(self):
        validate(self.document())

    def test_blocked_is_not_throttling_and_has_no_retry_time(self):
        d = self.document()
        blocked = {"meaning": "blocked", "bucket": None, "retryAt": None}
        self.assertEqual(classify(d, 429, {"Retry-After": "2"}, self.body("public_api_request_blocked"), NOW), blocked)
        # Other reasons stay throttled, with their Retry-After.
        self.assertEqual(classify(d, 429, {"Retry-After": "2"}, self.body("public_api_request_rate_limit"), NOW),
                         {"meaning": "throttled", "bucket": None, "retryAt": NOW + 2})
        # A non-429 status may be blocked too, when a signal lists it.
        d["x-throttling"]["signals"][0]["status"] = [403, 429]
        validate(d)
        self.assertEqual(classify(d, 403, {}, self.body("public_api_request_blocked"), NOW), blocked)

    def test_order_decides(self):
        d = self.document()
        d["x-throttling"]["signals"].reverse()
        validate(d)  # valid, but the broader signal now wins
        self.assertEqual(classify(d, 429, {}, self.body("public_api_request_blocked"), NOW)["meaning"], "throttled")

    def test_blocked_takes_no_bucket_or_delay(self):
        for extra in ({"minDelaySeconds": 30}, {"bucket": "b"}):
            d = self.document()
            d["x-throttling"]["limits"] = {"b": {"requests": 1, "window": {"seconds": 1, "kind": "fixed"}}}
            d["x-throttling"]["applies"] = ["b"]
            d["x-throttling"]["signals"][0].update(extra)
            with self.subTest(extra=extra), self.assertRaises(ValueError) as raised:
                validate(d)
            self.assertIn("bucket and minDelaySeconds are not allowed with blocked", str(raised.exception))
            # A consumer still treats such a signal as blocked, ignoring the field (README).
            self.assertEqual(classify(d, 429, {"Retry-After": "2"}, self.body("public_api_request_blocked"), NOW),
                             {"meaning": "blocked", "bucket": None, "retryAt": None})

    def test_unrecognised_meaning_is_never_resent(self):
        d = self.document()
        d["x-throttling"]["signals"][0]["meaning"] = "suspended"
        with self.assertRaises(ValueError):
            validate(d)
        # classify on an unvalidated document: the unknown meaning reads as blocked.
        self.assertEqual(classify(d, 429, {"Retry-After": "2"}, self.body("public_api_request_blocked"), NOW),
                         {"meaning": "blocked", "bucket": None, "retryAt": None})


class PlanTierTests(unittest.TestCase):
    """0.5.0: a Limit Object with tiers (synthetic plans)."""

    def document(self):
        return example("plan-tiers.yaml")

    def limit(self, document):
        return document["x-throttling"]["limits"]["perAccount"]

    def test_example_is_valid(self):
        validate(self.document())

    def test_shape(self):
        for mutate in (lambda l: l.update(window={"seconds": 1, "kind": "fixed"}),
                       lambda l: l.update(requests=5),
                       lambda l: l.update(tiers=[]),
                       lambda l: l["tiers"].append(dict(l["tiers"][0])),  # basic in two tiers
                       lambda l: l["tiers"][1].update(plans=["plus", "basic"]),
                       lambda l: l["tiers"][0].pop("window"),
                       lambda l: l["tiers"][0].pop("requests"),
                       lambda l: l["tiers"][0].update(plans=[]),
                       lambda l: l["tiers"][0].update(plans=[""]),
                       lambda l: l["tiers"][0].update(plans="basic"),
                       lambda l: l["tiers"][0].update(name="basic"),
                       lambda l: l["tiers"][0].update(requests=0),
                       lambda l: l["tiers"][0]["window"].update(kind="rolling")):
            d = self.document()
            mutate(self.limit(d))
            with self.subTest(), self.assertRaises(ValueError):
                validate(d)
        d = self.document()
        del self.limit(d)["tiers"]
        with self.assertRaises(ValueError):  # neither window nor tiers
            validate(d)

    def test_limits_in_force(self):
        limit = self.limit(self.document())
        pairs = lambda entries: sorted((e["requests"], e["window"]["seconds"]) for e in entries)
        self.assertEqual(pairs(limits_in_force(limit, "plus")), [(20, 1)])
        self.assertEqual(pairs(limits_in_force(limit, "standard")), [(20, 1)])
        self.assertEqual(pairs(limits_in_force(limit, "premium")), [(50, 1)])
        # No plan, or an unknown one: every tier at once. 30 per hour alone would allow
        # 30 requests in one second, which 20 per second forbids.
        for plan in (None, "Premium"):  # names compare exactly
            self.assertEqual(pairs(limits_in_force(limit, plan)), [(20, 1), (30, 3600), (50, 1)])
        plain = {"requests": 5, "window": {"seconds": 10, "kind": "fixed"}}
        self.assertEqual(limits_in_force(plain, "x"), [plain])
        self.assertEqual(limits_in_force({"window": {"seconds": 10, "kind": "fixed"}}), [])

    def test_quota_exhausted_falls_back_to_the_tier_window(self):
        d = self.document()
        self.assertEqual(classify(d, 429, {}, None, NOW),
                         {"meaning": "quotaExhausted", "bucket": "perAccount", "retryAt": NOW + 3600})
        self.assertEqual(classify(d, 429, {}, None, NOW, plan="premium")["retryAt"], NOW + 1)
        self.assertEqual(fallback_window(self.limit(d)), 3600)
        self.assertEqual(fallback_window(self.limit(d), "plus"), 1)

    def test_0_4_documents_stay_valid(self):
        for name in ("windowed.yaml", "response-signals.yaml", "body-fields.yaml", "blocked.yaml"):
            validate(example(name))



if __name__ == "__main__": unittest.main()
