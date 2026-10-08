"""Checked-in examples and rejection cases for the draft."""
import copy
import json
import pathlib
import unittest

import yaml

from validate import SCHEMA, load, validate, validate_file, validate_record

ROOT = pathlib.Path(__file__).parent
EXAMPLES = ROOT / "examples"
PLAN_DEFAULTS = {
    ("lease", "durationSeconds"): 604800,
    ("lease", "renewAfterSeconds"): 43200,
    ("lease", "progressDeadlineSeconds"): 604800,
    ("subscription", "maxPendingEvents"): 10000,
    ("subscription", "maxPendingBytes"): 64 * 1024 * 1024,
    ("subscription", "maxPendingAgeSeconds"): 604800,
    ("owner", "maxPendingBytes"): 256 * 1024 * 1024,
    ("owner", "maxPendingReferences"): 50000,
    ("owner", "maxActiveSubscriptions"): 20,
    ("deployment", "maxInboxBytes"): 1024 * 1024 * 1024,
    ("receipts", "ttlSeconds"): 48 * 3600,
    ("closed", "tombstoneTtlSeconds"): 30 * 86400,
    ("cleanup", "deadlineSeconds"): 30 * 86400,
    ("sweep", "maxIntervalSeconds"): 60,
}


def records():
    return json.loads((EXAMPLES / "records.json").read_text(encoding="utf-8"))["records"]


class ExampleTests(unittest.TestCase):
    def test_examples_are_valid(self):
        validate(load(EXAMPLES / "receiver.yaml"))
        validate_file(load(EXAMPLES / "records.json"))

    def test_schema_defaults_and_example_are_the_plans_pilot_limits(self):
        policy = load(EXAMPLES / "receiver.yaml")["x-webhook-subscriptions"]["policy"]
        definitions = SCHEMA["$defs"]["Policy"]["properties"]
        for (group, field), value in PLAN_DEFAULTS.items():
            self.assertEqual(definitions[group]["properties"][field]["default"], value, f"{group}.{field}")
            self.assertEqual(policy[group][field], value, f"{group}.{field}")

    def test_receiver_document_is_valid_openapi(self):
        from openapi_spec_validator import validate as validate_openapi
        path = EXAMPLES / "receiver.yaml"
        validate_openapi(yaml.safe_load(path.read_text(encoding="utf-8")), base_uri=path.resolve().as_uri())

    def test_every_record_kind_has_an_example(self):
        kinds = set(records())
        for kind in ("Subscription", "EventPage", "ReconciliationRequired", "Acknowledgement", "Renewal",
                     "ReconciliationComplete", "Error"):
            self.assertIn(kind, kinds)


class PolicyRejectionTests(unittest.TestCase):
    def rejects(self, mutate):
        document = load(EXAMPLES / "receiver.yaml")
        mutate(document["x-webhook-subscriptions"]["policy"])
        with self.assertRaises(ValueError):
            validate(document)

    def test_shape(self):
        self.rejects(lambda p: p.pop("fetch"))
        self.rejects(lambda p: p["lease"].update(durationSeconds=0))
        self.rejects(lambda p: p["lease"].update(durationSeconds="604800"))
        self.rejects(lambda p: p["owner"].update(maxActiveSubscriptions=True))
        self.rejects(lambda p: p.update(unlimited=True))

    def test_consistency(self):
        self.rejects(lambda p: p["lease"].update(renewAfterSeconds=604800))
        self.rejects(lambda p: p["subscription"].update(maxPendingBytes=p["owner"]["maxPendingBytes"] + 1))
        self.rejects(lambda p: p["owner"].update(maxPendingBytes=p["deployment"]["maxInboxBytes"] + 1))
        self.rejects(lambda p: p["subscription"].update(maxPendingEvents=50001))
        self.rejects(lambda p: p["delivery"].update(maxBodyBytes=p["subscription"]["maxPendingBytes"] + 1))
        self.rejects(lambda p: p["sweep"].update(maxIntervalSeconds=61))
        self.rejects(lambda p: p["closed"].update(tombstoneTtlSeconds=2592001))
        self.rejects(lambda p: p["cleanup"].update(deadlineSeconds=2592001))


class RecordRejectionTests(unittest.TestCase):
    def rejects(self, kind, index, mutate):
        value = copy.deepcopy(records()[kind][index])
        mutate(value)
        with self.assertRaises(ValueError):
            validate_record(kind, value)

    def test_reconciliation_required(self):
        self.rejects("ReconciliationRequired", 0, lambda r: r.pop("barrier"))
        self.rejects("ReconciliationRequired", 0, lambda r: r.update(action="resubscribe"))
        self.rejects("ReconciliationRequired", 2, lambda r: r.update(generation="gen_x", barrier="cur_x"))
        self.rejects("ReconciliationRequired", 2, lambda r: r.update(action="reconcile"))
        self.rejects("ReconciliationRequired", 1, lambda r: r["gap"].update(generation=r["generation"]))
        self.rejects("ReconciliationRequired", 1, lambda r: r["gap"].update(generation=None))
        self.rejects("ReconciliationRequired", 0, lambda r: r["gap"].update(generation="gen_0"))
        self.rejects("ReconciliationRequired", 0, lambda r: r.update(status="ok"))

    def test_events_and_pages(self):
        self.rejects("EventPage", 0, lambda p: p["events"][0]["payload"].update(bytes=1))
        self.rejects("EventPage", 0, lambda p: p["events"][0]["payload"].update(sha256="0" * 64))
        self.rejects("EventPage", 0, lambda p: p["events"][0]["payload"].update(body="not base64!"))
        self.rejects("EventPage", 0, lambda p: p["events"][1].update(cursor=p["events"][0]["cursor"]))
        self.rejects("EventPage", 0, lambda p: p["events"][0].update(generation="gen_other"))
        self.rejects("EventPage", 0, lambda p: p.update(next="cur_elsewhere"))
        self.rejects("EventPage", 1, lambda p: p["reconciliationRequired"].update(subscription="sub_other"))
        self.rejects("EventPage", 0, lambda p: p["events"][0].update(headers={"X-Signature": "x"}))
        self.rejects("EventPage", 0, lambda p: p["events"][0].update(deliveryId="has space"))

    def test_subscriptions(self):
        self.rejects("Subscription", 1, lambda s: s.pop("reconciliationRequired"))
        self.rejects("Subscription", 2, lambda s: s.update(reconciliationRequired=records()["ReconciliationRequired"][0]))
        self.rejects("Subscription", 1, lambda s: s["reconciliationRequired"].update(generation="gen_other"))
        self.rejects("Subscription", 0, lambda s: s.update(generation="gen_early"))
        self.rejects("Subscription", 2, lambda s: s["lease"].update(progressDeadlineAt=None))
        self.rejects("Subscription", 1, lambda s: s["lease"].update(progressDeadlineAt="2026-10-15T12:00:00Z"))
        self.rejects("Subscription", 2, lambda s: s.update(pending={"events": 0, "bytes": 5}))
        self.rejects("Subscription", 2, lambda s: s.update(consumer="did:ad:agent:abc"))
        self.rejects("Subscription", 2, lambda s: s.update(state="paused"))
        self.rejects("Subscription", 2, lambda s: s["lease"].update(expiresAt="2026-10-15 12:00:00"))

    def test_opaque_values_and_error_codes(self):
        self.rejects("Acknowledgement", 0, lambda a: a.update(cursor="cur/../1"))
        self.rejects("Acknowledgement", 0, lambda a: a.update(cursor=""))
        self.rejects("Renewal", 1, lambda r: r.pop("checkpoint"))
        self.rejects("Error", 0, lambda e: e.update(code="teapot"))


if __name__ == "__main__":
    unittest.main()
