"""Checked-in examples, signed fixtures and rejection cases for the draft.

The secrets below are invented for these fixtures only. They are not, and
never were, configured anywhere.
"""
import copy
import json
import pathlib
import unittest

from validate import VerificationError, load, route_delivery, validate, verify_delivery

ROOT = pathlib.Path(__file__).parent
EXAMPLES = ROOT / "examples"
GITHUB_FIXTURE_SECRET = b"fixture-only-github-app-secret-not-real-0000"
TRACKER_APP_SECRET = b"fixture-only-tracker-app-secret-not-real-000"
TRACKER_HOOK_SECRET = b"fixture-only-project-hook-secret-not-real-00"
FIXTURE_NOW = 1791460800  # 2026-10-08T12:00:00Z, the project-hook fixture's timestamp


def delivery(name):
    data = json.loads((EXAMPLES / name).read_text(encoding="utf-8"))
    return [tuple(h) for h in data["headers"]], data["body"].encode("utf-8")


def with_header(headers, name, value):
    return [(k, v) for k, v in headers if k.lower() != name.lower()] + [(name, value)]


class ExampleTests(unittest.TestCase):
    def test_examples_are_valid(self):
        for name in ("tracker.yaml", "github-fixture.yaml"):
            validate(load(EXAMPLES / name))

    def test_examples_are_valid_openapi_apart_from_crud_resources(self):
        # CRUD Causality places crudResources under components, which strict
        # OpenAPI 3.1 does not allow; everything else must validate.
        from openapi_spec_validator import validate as validate_openapi
        for name in ("tracker.yaml", "github-fixture.yaml"):
            document = load(EXAMPLES / name)
            document["components"].pop("crudResources")
            if not document["components"]:
                del document["components"]
            validate_openapi(document)

    def test_overlay_applies_to_the_neutral_document(self):
        document = load(EXAMPLES / "tracker.yaml")
        del document["x-webhook-deliveries"]
        overlay = load(EXAMPLES / "tracker-overlay.yaml")
        for action in overlay["actions"]:
            self.assertEqual(action["target"], "$")
            document.update(copy.deepcopy(action["update"]))
        validate(document)


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.github = load(EXAMPLES / "github-fixture.yaml")["x-webhook-deliveries"]
        self.tracker = load(EXAMPLES / "tracker.yaml")["x-webhook-deliveries"]

    def test_github_fixture_verifies_over_the_raw_body(self):
        headers, body = delivery("github-deliveries/issues-edited.json")
        verify_delivery(self.github["verificationProfiles"]["githubApp"], headers, body, GITHUB_FIXTURE_SECRET, FIXTURE_NOW)

    def test_a_reserialized_body_fails(self):
        headers, body = delivery("github-deliveries/issues-edited.json")
        reformatted = json.dumps(json.loads(body), indent=2).encode()
        with self.assertRaises(VerificationError):
            verify_delivery(self.github["verificationProfiles"]["githubApp"], headers, reformatted, GITHUB_FIXTURE_SECRET, FIXTURE_NOW)

    def test_wrong_secret_missing_repeated_or_malformed_signature_fail(self):
        profile = self.github["verificationProfiles"]["githubApp"]
        headers, body = delivery("github-deliveries/issues-edited.json")
        signature = dict(headers)["X-Hub-Signature-256"]
        cases = [
            (headers, b"another-fixture-secret-that-is-also-fake-00"),
            ([h for h in headers if h[0] != "X-Hub-Signature-256"], GITHUB_FIXTURE_SECRET),
            (headers + [("x-hub-signature-256", signature)], GITHUB_FIXTURE_SECRET),
            (with_header(headers, "X-Hub-Signature-256", signature[len("sha256="):]), GITHUB_FIXTURE_SECRET),
            (with_header(headers, "X-Hub-Signature-256", signature[:-2]), GITHUB_FIXTURE_SECRET),
            (with_header(headers, "X-Hub-Signature-256", "sha1=" + signature[7:]), GITHUB_FIXTURE_SECRET),
            (headers, b"short"),
        ]
        for case_headers, secret in cases:
            with self.assertRaises(VerificationError):
                verify_delivery(profile, case_headers, body, secret, FIXTURE_NOW)

    def test_hex_signature_is_case_insensitive_and_header_name_too(self):
        headers, body = delivery("github-deliveries/issues-edited.json")
        signature = dict(headers)["X-Hub-Signature-256"]
        upper = with_header(headers, "x-hub-signature-256", "sha256=" + signature[7:].upper())
        verify_delivery(self.github["verificationProfiles"]["githubApp"], upper, body, GITHUB_FIXTURE_SECRET, FIXTURE_NOW)

    def test_tracker_app_hook_and_timestamped_project_hook(self):
        headers, body = delivery("tracker-deliveries/task-updated-app.json")
        verify_delivery(self.tracker["verificationProfiles"]["appHook"], headers, body, TRACKER_APP_SECRET, FIXTURE_NOW)
        profile = self.tracker["verificationProfiles"]["projectHook"]
        headers, body = delivery("tracker-deliveries/task-updated-project-hook.json")
        for now in (FIXTURE_NOW - 300, FIXTURE_NOW, FIXTURE_NOW + 300):
            verify_delivery(profile, headers, body, TRACKER_HOOK_SECRET, now)
        for now in (FIXTURE_NOW - 301, FIXTURE_NOW + 301):
            with self.assertRaises(VerificationError):
                verify_delivery(profile, headers, body, TRACKER_HOOK_SECRET, now)

    def test_the_timestamp_is_signed(self):
        profile = self.tracker["verificationProfiles"]["projectHook"]
        headers, body = delivery("tracker-deliveries/task-updated-project-hook.json")
        for stamp in ("1791460801", "+1791460800", " 1791460800", "1791460800.0"):
            with self.assertRaises(VerificationError):
                verify_delivery(profile, with_header(headers, "Tracker-Timestamp", stamp), body, TRACKER_HOOK_SECRET, FIXTURE_NOW)


class RoutingTests(unittest.TestCase):
    def test_github_issue_delivery_routes_by_repository_id(self):
        document = load(EXAMPLES / "github-fixture.yaml")
        headers, body = delivery("github-deliveries/issues-edited.json")
        routed = route_delivery(document, headers, body)
        self.assertEqual(routed["deliveryId"], "00000000-0000-4000-8000-000000000001")
        self.assertEqual((routed["eventType"], routed["action"]), ("issues", "edited"))
        self.assertEqual(routed["source"], {"kind": "repository", "key": "2000002"})
        self.assertEqual(routed["context"], {"installation": "1000001"})
        self.assertEqual(routed["resources"], [{"resource": "issue", "path": "/repos/fixture-owner/fixture-repo/issues/7"}])
        self.assertEqual(routed["collections"], [{"resource": "issue", "collection": "issues", "path": "/repos/fixture-owner/fixture-repo/issues"}])
        self.assertEqual(routed["revoked"], [])

    def test_github_removal_revokes_each_listed_repository(self):
        document = load(EXAMPLES / "github-fixture.yaml")
        headers, body = delivery("github-deliveries/installation-repositories-removed.json")
        routed = route_delivery(document, headers, body)
        self.assertIsNone(routed["source"])  # not a declared event: nothing is retained for it
        self.assertEqual(routed["revoked"], [{"source": "repository", "context": None, "keys": ["2000002", "2000003"]}])

    def test_tracker_body_event_type_and_escaped_path_values(self):
        document = load(EXAMPLES / "tracker.yaml")
        headers, body = delivery("tracker-deliveries/task-updated-app.json")
        routed = route_delivery(document, headers, body)
        self.assertEqual(routed["source"], {"kind": "project", "key": "p-100"})
        self.assertEqual(routed["resources"], [{"resource": "task", "path": "/projects/p-100/tasks/t%2F7"}])

    def test_keys_are_text_and_only_strings_or_non_negative_integers(self):
        document = load(EXAMPLES / "tracker.yaml")
        headers, _ = delivery("tracker-deliveries/task-updated-app.json")
        for value, expected in ((42, "42"), ("42", "42"), (-1, None), (1.0, None), (True, None), (None, None), ({}, None)):
            body = json.dumps({"kind": "task", "change": "updated", "project": {"id": value}, "task": {"id": "t"}}).encode()
            routed = route_delivery(document, headers, body)
            self.assertEqual(routed["source"] and routed["source"]["key"], expected)

    def test_bad_delivery_ids_are_refused(self):
        document = load(EXAMPLES / "tracker.yaml")
        headers, body = delivery("tracker-deliveries/task-updated-app.json")
        for value in ("", "has space", "x" * 256, "café"):
            with self.assertRaises(VerificationError):
                route_delivery(document, with_header(headers, "Tracker-Delivery", value), body)


class RejectionTests(unittest.TestCase):
    def setUp(self):
        self.base = load(EXAMPLES / "tracker.yaml")

    def rejects(self, mutate):
        document = copy.deepcopy(self.base)
        mutate(document["x-webhook-deliveries"], document)
        with self.assertRaises(ValueError):
            validate(document)

    def test_shape(self):
        cases = [
            lambda r, d: r.pop("events"),
            lambda r, d: r.update(unknown=1),
            lambda r, d: r["verificationProfiles"]["appHook"].update(algorithm="hmac-sha1"),
            lambda r, d: r["verificationProfiles"]["appHook"]["secret"].update(value="do-not-put-secrets-here"),
            lambda r, d: r["verificationProfiles"]["appHook"]["secret"].update(minBytes=16),
            lambda r, d: r["verificationProfiles"]["projectHook"]["timestamp"].update(toleranceSeconds=3600),
            lambda r, d: r["delivery"].update(redelivery="maybe"),
            lambda r, d: r["sources"]["project"].update(key="$request.header.X-Project"),
            lambda r, d: r.update(hooks={}),
        ]
        for mutate in cases:
            self.rejects(mutate)

    def test_timestamp_only_with_signed_timestamp(self):
        self.rejects(lambda r, d: r["verificationProfiles"]["appHook"].update(
            timestamp={"in": "header", "name": "T", "format": "unixSeconds", "toleranceSeconds": 60}))
        self.rejects(lambda r, d: r["verificationProfiles"]["projectHook"].pop("timestamp"))

    def test_secret_source_matches_hook_model(self):
        self.rejects(lambda r, d: r["hooks"]["sharedApplication"].update(verificationProfile="projectHook"))
        self.rejects(lambda r, d: r["hooks"]["dedicated"].update(verificationProfile="appHook"))
        self.rejects(lambda r, d: r["hooks"]["sharedApplication"].update(verificationProfile="missing"))

    def test_dedicated_hook_operations(self):
        self.rejects(lambda r, d: r["hooks"]["dedicated"]["create"]["body"].pop("signingSecret"))
        self.rejects(lambda r, d: r["hooks"]["dedicated"]["create"]["body"].update(other="$receiver.token"))
        self.rejects(lambda r, d: r["hooks"]["dedicated"].update(hookIdParameter="hookId"))
        self.rejects(lambda r, d: r["hooks"]["dedicated"].update(hookIdParameter="projectId"))
        self.rejects(lambda r, d: r["hooks"]["dedicated"]["list"].update(url="$response.body#/0/target"))
        self.rejects(lambda r, d: r["hooks"]["dedicated"]["create"].update(path="/hooks"))
        self.rejects(lambda r, d: d["paths"]["/projects/{projectId}/webhooks"].pop("post"))

    def test_access_check_is_an_existing_get(self):
        self.rejects(lambda r, d: r["sources"]["project"]["access"]["operation"].update(method="post"))
        self.rejects(lambda r, d: r["sources"]["project"]["access"]["operation"].update(path="/nowhere"))

    def test_event_references_and_bindings(self):
        self.rejects(lambda r, d: r["events"]["task"].update(source="workspace"))
        self.rejects(lambda r, d: r["events"]["task"]["resources"][0].update(resource="note"))
        self.rejects(lambda r, d: r["events"]["task"]["collections"][0].update(collection="allTasks"))
        self.rejects(lambda r, d: r["events"]["task"]["resources"][0]["bindings"].pop("taskId"))
        self.rejects(lambda r, d: r["events"]["task"]["resources"][0]["bindings"].update(extra="$request.body#/x"))
        self.rejects(lambda r, d: d["components"].pop("crudResources"))

    def test_wildcards_only_where_allowed(self):
        self.rejects(lambda r, d: r["sources"]["project"].update(key="$request.body#/projects/*/id"))
        self.rejects(lambda r, d: r["events"]["task"]["resources"][0]["bindings"].update(taskId="$request.body#/tasks/*/id"))
        self.rejects(lambda r, d: r["revocations"][0].update(keys="$request.body#/a/*/b/*/id"))

    def test_revocation_references(self):
        self.rejects(lambda r, d: r["revocations"][0].update(source="workspace"))
        self.rejects(lambda r, d: r["revocations"][1].update(context="organisation"))


if __name__ == "__main__":
    unittest.main()
