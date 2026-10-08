"""Write Preconditions 0.1.0-draft: document rules and reference client logic."""
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import may_send, resolve_unknown, validate

ROOT = pathlib.Path(__file__).parent
IF_MATCH = {"kind": "ifMatch", "version": {"in": "body", "name": "etag"}}
VERIFY = {"kind": "readVerify", "refuseWhen": [{"field": "in_trash", "values": [True]}]}


def example():
    return yaml.safe_load((ROOT / "examples" / "conditional-writes.yaml").read_text(encoding="utf-8"))


def declaration(document, path, method):
    return document["paths"][path][method]["x-write-precondition"]


class ValidationTests(unittest.TestCase):
    def invalid(self, mutate, fragment):
        document = example()
        mutate(document)
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_example_is_valid_and_openapi(self):
        validate(example())
        validate_openapi(example())

    def test_kind_and_its_fields(self):
        self.invalid(lambda d: declaration(d, "/events/{eventId}", "patch").update(kind="etag"), "kind: expected")
        self.invalid(lambda d: declaration(d, "/events/{eventId}", "patch").pop("version"), "version: expected")
        self.invalid(lambda d: declaration(d, "/events/{eventId}", "patch").update(version={"in": "query", "name": "v"}), "version: expected")
        self.invalid(lambda d: declaration(d, "/events/{eventId}", "patch").update(version={"in": "body", "name": ""}), "version: expected")
        self.invalid(lambda d: declaration(d, "/pages/{pageId}", "patch").update(version={"in": "body", "name": "etag"}), "only with kind ifMatch")
        self.invalid(lambda d: declaration(d, "/notes/{noteId}", "put").update(header="If-Match"), "only with kind ifMatch")
        self.invalid(lambda d: declaration(d, "/events/{eventId}", "patch").update(header=""), "header: expected")
        for statuses in ([], [500], [412, 412], ["412"], [True], 412):
            self.invalid(lambda d, s=statuses: declaration(d, "/events/{eventId}", "patch").update(conflictStatus=s), "conflictStatus")
        self.invalid(lambda d: declaration(d, "/events/{eventId}", "patch").update(extra=1), "unknown fields")

    def test_refusals_and_idempotent(self):
        page = lambda d: declaration(d, "/pages/{pageId}", "patch")
        self.invalid(lambda d: page(d).update(refuseWhen={"field": "x"}), "refuseWhen: expected an array")
        self.invalid(lambda d: page(d)["refuseWhen"].append({"field": "", "values": [1]}), "field: expected")
        self.invalid(lambda d: page(d)["refuseWhen"].append({"field": "x", "values": []}), "values: expected")
        self.invalid(lambda d: page(d)["refuseWhen"].append({"field": "x", "values": [{"a": 1}]}), "values: expected")
        self.invalid(lambda d: page(d).update(idempotent="yes"), "idempotent: expected")
        document = example()
        page(document).update(idempotent=True)
        page(document)["refuseWhen"].append({"field": "archived", "values": [True, None]})
        validate(document)

    def test_placement(self):
        def on_get(document):
            document["paths"]["/pages/{pageId}"]["get"]["x-write-precondition"] = {"kind": "none"}
        self.invalid(on_get, "only on PUT, PATCH, POST or DELETE")
        self.invalid(lambda d: d["paths"]["/pages/{pageId}"]["patch"].update({"x-crud": {"action": "read", "resource": "p"}}),
                     "x-crud action must be update or delete")


class ClientTests(unittest.TestCase):
    def test_if_match_sends_the_version_read(self):
        current = {"id": "e1", "etag": '"3181161784712000"', "summary": "Old"}
        self.assertEqual(may_send(IF_MATCH, {"summary": "Old"}, ["summary"], current),
                         ("send", {"If-Match": '"3181161784712000"'}))
        self.assertEqual(may_send(dict(IF_MATCH, header="X-If-Match"), {}, ["summary"], current)[1], {"X-If-Match": '"3181161784712000"'})
        self.assertEqual(may_send(IF_MATCH, {}, ["summary"], {"id": "e1"}), ("read-first", None))
        self.assertEqual(may_send(IF_MATCH, {}, ["summary"], None), ("read-first", None))

    def test_read_verify_compares_only_the_written_fields(self):
        baseline = {"title": "A", "status": "open"}
        current = {"title": "A", "status": "open", "notes": "changed by someone else"}
        self.assertEqual(may_send(VERIFY, baseline, ["title"], current), ("send", {}))
        current["status"] = "done"
        self.assertEqual(may_send(VERIFY, baseline, ["title"], current), ("send", {}))
        self.assertEqual(may_send(VERIFY, baseline, ["title", "status"], current), ("conflict", ["status"]))
        self.assertEqual(may_send(VERIFY, {"n": 1}, ["n"], {"n": 1.0}), ("send", {}))
        self.assertEqual(may_send(VERIFY, {"n": 1}, ["n"], {"n": "1"}), ("conflict", ["n"]))
        self.assertEqual(may_send(VERIFY, baseline, ["title"], None), ("read-first", None))

    def test_refusal_wins_over_everything(self):
        self.assertEqual(may_send(VERIFY, {"title": "A"}, ["title"], {"title": "A", "in_trash": True})[0], "refused")
        self.assertEqual(may_send(VERIFY, {"title": "A"}, ["title"], {"title": "A", "in_trash": False})[0], "send")
        self.assertEqual(may_send(VERIFY, {"title": "A"}, ["title"], {"title": "A", "in_trash": "true"})[0], "send")
        nested = {"kind": "none", "refuseWhen": [{"field": "state.phase", "values": ["archived"]}]}
        self.assertEqual(may_send(nested, {}, ["x"], {"state": {"phase": "archived"}})[0], "refused")
        self.assertEqual(may_send({"kind": "none"}, {}, ["x"], None), ("send", {}))

    def test_unknown_outcome_whether_to_read_first(self):
        baseline, written = {"title": "A"}, {"title": "B"}
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written), "read-first")
        # Under readVerify, idempotent never skips the read and comparison.
        self.assertEqual(resolve_unknown(dict(VERIFY, idempotent=True), "PATCH", baseline, written), "read-first")
        self.assertEqual(resolve_unknown(dict(VERIFY, idempotent=True), "PUT", baseline, written), "read-first")
        self.assertEqual(resolve_unknown(dict(IF_MATCH, idempotent=True), "PATCH", baseline, written), "resend")
        self.assertEqual(resolve_unknown({"kind": "none"}, "PUT", baseline, written), "resend")
        self.assertEqual(resolve_unknown({"kind": "none", "idempotent": False}, "PUT", baseline, written), "read-first")

    def test_unknown_update_resolved_by_a_read(self):
        baseline, written = {"title": "A"}, {"title": "B"}
        read = lambda body, status=200: {"status": status, "body": body}
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, read({"title": "B"})), "applied")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, read({"title": "A"})), "not-applied")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, read({"title": "C"})), "conflict")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, read(None, 500)), "unknown")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, {}, read({"title": "A"})), "unknown")
        # ifMatch: the version sent, unchanged, means not applied; a new version is resolved by the fields.
        sent = '"v1"'
        self.assertEqual(resolve_unknown(IF_MATCH, "PATCH", baseline, written, read({"title": "A", "etag": sent}), sent), "not-applied")
        self.assertEqual(resolve_unknown(IF_MATCH, "PATCH", baseline, written, read({"title": "B", "etag": '"v2"'}), sent), "applied")
        self.assertEqual(resolve_unknown(IF_MATCH, "PATCH", baseline, written, read({"title": "C", "etag": '"v2"'}), sent), "conflict")
        # A new version with the written fields at their baseline: another writer changed the object.
        self.assertEqual(resolve_unknown(IF_MATCH, "PATCH", baseline, written, read({"title": "A", "etag": '"v2"'}), sent), "conflict")
        # The resolution read re-checks refuseWhen.
        trash = dict(VERIFY)
        self.assertEqual(resolve_unknown(trash, "PATCH", baseline, written, read({"title": "A", "in_trash": True})), "refused")
        header = {"kind": "ifMatch", "version": {"in": "header", "name": "ETag"}}
        self.assertEqual(resolve_unknown(header, "PATCH", baseline, written,
                                         {"status": 200, "body": {"title": "A"}, "headers": {"etag": sent}}, sent), "not-applied")

    def test_absent_equals_null(self):
        # A merge-patch deletion writes null; the object then lacks the field.
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", {"note": "x"}, {"note": None},
                                         {"status": 200, "body": {"title": "A"}}), "applied")
        self.assertEqual(may_send(VERIFY, {"note": None}, ["note"], {"title": "A"}), ("send", {}))
        self.assertEqual(may_send(VERIFY, {"note": None}, ["note"], {"note": "y"}), ("conflict", ["note"]))

    def test_unknown_delete(self):
        baseline = {"title": "A", "etag": '"v1"'}
        read = lambda body, status=200: {"status": status, "body": body}
        for status in (404, 410):
            # Without a declaration that a missing object was deleted, a 404 may be lost access.
            self.assertEqual(resolve_unknown(VERIFY, "DELETE", baseline, {}, read(None, status)), "gone-unconfirmed")
            self.assertEqual(resolve_unknown(VERIFY, "DELETE", baseline, {}, read(None, status), deletion_confirmed=True), "applied")
        # A soft delete reads back as a read tombstone.
        tombstone = {"field": "deleted", "values": [True]}
        self.assertEqual(resolve_unknown(VERIFY, "DELETE", baseline, {}, read({"title": "A", "deleted": True, "etag": '"v9"'}),
                                         tombstone=tombstone), "applied")
        # The x-crud action decides, not the method: a POST .../archive declared as a delete.
        self.assertEqual(resolve_unknown(VERIFY, "POST", baseline, {}, read(None, 404), action="delete",
                                         deletion_confirmed=True), "applied")
        self.assertEqual(resolve_unknown(VERIFY, "DELETE", {"title": "A"}, {"title": "B"}, read({"title": "B"}), action="update"),
                         "applied")
        self.assertEqual(resolve_unknown(VERIFY, "DELETE", baseline, {}, read({"title": "A", "etag": '"v1"'})), "not-applied")
        self.assertEqual(resolve_unknown(VERIFY, "DELETE", baseline, {}, read({"title": "C", "etag": '"v2"'})), "conflict")
        self.assertEqual(resolve_unknown(IF_MATCH, "DELETE", baseline, {}, read({"title": "C", "etag": '"v1"'}), '"v1"'), "not-applied")
        self.assertEqual(resolve_unknown(IF_MATCH, "DELETE", baseline, {}, read({"title": "A", "etag": '"v2"'}), '"v1"'), "conflict")
        self.assertEqual(resolve_unknown(VERIFY, "DELETE", baseline, {}, read(None, 500)), "unknown")
        self.assertEqual(resolve_unknown({"kind": "none"}, "DELETE", baseline, {}), "resend")

    def test_present_refusal(self):
        recurring = {"kind": "ifMatch", "version": {"in": "body", "name": "etag"},
                     "refuseWhen": [{"field": "recurrence", "present": True}]}
        series = {"etag": '"v"', "recurrence": ["RRULE:FREQ=WEEKLY"]}
        self.assertEqual(may_send(recurring, {}, ["summary"], series)[0], "refused")
        self.assertEqual(may_send(recurring, {}, ["summary"], {"etag": '"v"', "recurrence": []})[0], "refused")
        self.assertEqual(may_send(recurring, {}, ["summary"], {"etag": '"v"'})[0], "send")
        self.assertEqual(may_send(recurring, {}, ["summary"], {"etag": '"v"', "recurrence": None})[0], "send")
        document = example()
        refusals = declaration(document, "/pages/{pageId}", "patch")["refuseWhen"]
        refusals.append({"field": "recurrence", "present": True})
        validate(document)
        for bad in ({"field": "x", "present": False}, {"field": "x", "present": True, "values": [1]}, {"field": "x"}):
            document = example()
            declaration(document, "/pages/{pageId}", "patch")["refuseWhen"].append(bad)
            with self.assertRaises(ValueError):
                validate(document)

    def test_refusals_need_a_read_and_header_versions_are_supported(self):
        refusing = {"kind": "none", "refuseWhen": [{"field": "in_trash", "values": [True]}]}
        self.assertEqual(may_send(refusing, {}, ["x"], None), ("read-first", None))
        header = {"kind": "ifMatch", "version": {"in": "header", "name": "ETag"}}
        self.assertEqual(may_send(header, {}, ["x"], {"x": 1}, {"etag": '"1"'}), ("send", {"If-Match": '"1"'}))
        self.assertEqual(may_send(header, {}, ["x"], {"x": 1}, {}), ("read-first", None))


if __name__ == "__main__":
    unittest.main()
