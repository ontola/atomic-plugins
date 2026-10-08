"""Validate x-webhook-subscriptions (0.1.0-draft) policies and records.

validate(document) checks a receiver document's x-webhook-subscriptions
against schema.json and the policy rules of README section 8.
validate_record(kind, value) checks one record (a $defs name) the same way.
A file with a top-level `records` map of $defs name to a list of records is
checked record by record.
"""
import base64
import binascii
import hashlib
import json
import pathlib
import sys

import jsonschema
import yaml

ROOT = pathlib.Path(__file__).parent
SCHEMA = json.loads((ROOT / "schema.json").read_text(encoding="utf-8"))
RECORDS = ("Policy", "Subscription", "Lease", "GapMarker", "ReconciliationRequired", "Event",
           "EventPage", "Acknowledgement", "Renewal", "ReconciliationComplete", "Error")
THIRTY_DAYS = 2592000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_schema(value, schema, label):
    try:
        jsonschema.validate(value, schema)
    except jsonschema.ValidationError as error:
        location = "/".join(str(p) for p in error.absolute_path)
        raise ValueError(f"{label}/{location}: {error.message}") from None


def record_schema(kind):
    return {"$schema": SCHEMA["$schema"], "$defs": SCHEMA["$defs"], "$ref": f"#/$defs/{kind}"}


def check_policy(policy):
    lease, sub, owner = policy["lease"], policy["subscription"], policy["owner"]
    require(lease["renewAfterSeconds"] < lease["durationSeconds"],
            "policy.lease: renewAfterSeconds must be less than durationSeconds")
    require(sub["maxPendingBytes"] <= owner["maxPendingBytes"] <= policy["deployment"]["maxInboxBytes"],
            "policy: subscription.maxPendingBytes <= owner.maxPendingBytes <= deployment.maxInboxBytes")
    require(sub["maxPendingEvents"] <= owner["maxPendingReferences"],
            "policy: subscription.maxPendingEvents <= owner.maxPendingReferences")
    require(policy["delivery"]["maxBodyBytes"] <= sub["maxPendingBytes"],
            "policy: delivery.maxBodyBytes <= subscription.maxPendingBytes, or no delivery could be retained")
    require(policy["sweep"]["maxIntervalSeconds"] <= 60, "policy.sweep.maxIntervalSeconds: at most 60")
    require(policy["closed"]["tombstoneTtlSeconds"] <= THIRTY_DAYS, "policy.closed.tombstoneTtlSeconds: at most 30 days")
    require(policy["cleanup"]["deadlineSeconds"] <= THIRTY_DAYS, "policy.cleanup.deadlineSeconds: at most 30 days")


def check_gap(gap, label):
    if gap["reason"] == "initial":
        require(gap["generation"] is None and gap["lastAcknowledged"] is None and gap["earliestAvailableCursor"] is None,
                f"{label}: an initial gap has no generation, acknowledgement or available cursor")
    else:
        require(gap["generation"] is not None, f"{label}: only an initial gap has no generation")


def check_reconciliation(result, label):
    reconcile = result["action"] == "reconcile"
    require(reconcile == (result["state"] == "needs-reconciliation"),
            f"{label}: action reconcile exactly when state is needs-reconciliation")
    require(reconcile == ("generation" in result) == ("barrier" in result),
            f"{label}: generation and barrier are present exactly with action reconcile")
    if reconcile:
        require(result["gap"]["generation"] != result["generation"],
                f"{label}: the gap names the generation that ended, not the new one")
    check_gap(result["gap"], f"{label}.gap")


def check_event(event, label):
    payload = event["payload"]
    try:
        body = base64.b64decode(payload["body"], validate=True)
    except binascii.Error:
        raise ValueError(f"{label}.payload.body: not base64") from None
    require(len(body) == payload["bytes"], f"{label}.payload.bytes: does not match the body")
    require(hashlib.sha256(body).hexdigest() == payload["sha256"], f"{label}.payload.sha256: does not match the body")


def check_subscription(sub, label):
    needs = sub["state"] == "needs-reconciliation"
    require(needs == ("reconciliationRequired" in sub),
            f"{label}: reconciliationRequired is present exactly in state needs-reconciliation")
    if needs:
        result = sub["reconciliationRequired"]
        check_reconciliation(result, f"{label}.reconciliationRequired")
        require(result["subscription"] == sub["id"], f"{label}.reconciliationRequired: another subscription")
        require(result["generation"] == sub["generation"],
                f"{label}.reconciliationRequired: generation is not the subscription's")
    if sub["state"] == "provisioning":
        require(sub["generation"] is None, f"{label}: a provisioning subscription has no generation yet")
    elif sub["state"] in ("needs-reconciliation", "active"):
        require(sub["generation"] is not None and sub["lease"] is not None,
                f"{label}: a capturing subscription has a generation and a lease")
    if sub["lease"] is not None:
        idle = sub["pending"]["events"] == 0
        require(idle == (sub["lease"]["progressDeadlineAt"] is None),
                f"{label}.lease.progressDeadlineAt: null exactly when nothing is pending")
    require((sub["pending"]["events"] == 0) == (sub["pending"]["bytes"] == 0),
            f"{label}.pending: events and bytes are zero together")


def check_page(page, label):
    cursors = [event["cursor"] for event in page["events"]]
    require(len(cursors) == len(set(cursors)), f"{label}: duplicate cursors")
    for index, event in enumerate(page["events"]):
        require(event["generation"] == page["generation"], f"{label}.events[{index}]: another generation")
        check_event(event, f"{label}.events[{index}]")
    if page["more"]:
        require(page["next"] is not None, f"{label}: more without next")
    if page["events"]:
        require(page["next"] == cursors[-1], f"{label}: next is the last event's cursor")
    if "reconciliationRequired" in page:
        result = page["reconciliationRequired"]
        check_reconciliation(result, f"{label}.reconciliationRequired")
        require(result["subscription"] == page["subscription"], f"{label}.reconciliationRequired: another subscription")


CHECKS = {
    "Policy": check_policy,
    "Subscription": check_subscription,
    "GapMarker": check_gap,
    "ReconciliationRequired": check_reconciliation,
    "Event": check_event,
    "EventPage": check_page,
}


def validate_record(kind, value, label=None):
    require(kind in RECORDS, f"unknown record kind {kind}")
    label = label or kind
    check_schema(value, record_schema(kind), label)
    if kind in CHECKS:
        CHECKS[kind](value, label)


def validate(document):
    require(isinstance(document, dict), "document: expected an object")
    root = document.get("x-webhook-subscriptions")
    require(root is not None, "document: no x-webhook-subscriptions")
    check_schema(root, SCHEMA, "x-webhook-subscriptions")
    check_policy(root["policy"])


def validate_file(document):
    if "records" in document:
        require(isinstance(document["records"], dict), "records: expected a map")
        for kind, values in document["records"].items():
            for index, value in enumerate(values):
                validate_record(kind, value, f"records.{kind}[{index}]")
    else:
        validate(document)


def load(path):
    with open(path, encoding="utf-8") as source:
        return yaml.safe_load(source)


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        validate_file(load(argument))
        print(f"{argument}: webhook subscriptions valid")
