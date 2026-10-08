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

    def test_unknown_outcomes(self):
        baseline, written = {"title": "A"}, {"title": "B"}
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, None), "read-first")
        self.assertEqual(resolve_unknown(dict(VERIFY, idempotent=True), "PATCH", baseline, written, None), "resend")
        self.assertEqual(resolve_unknown({"kind": "none"}, "PUT", baseline, written, None), "resend")
        self.assertEqual(resolve_unknown({"kind": "none", "idempotent": False}, "PUT", baseline, written, None), "read-first")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, {"title": "B"}), "applied")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, {"title": "A"}), "not-applied")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", baseline, written, {"title": "C"}), "conflict")
        # Under ifMatch, a 412 on a repeat is resolved the same way: the first write may have changed the version.
        self.assertEqual(resolve_unknown(IF_MATCH, "PATCH", baseline, written, {"title": "B", "etag": '"new"'}), "applied")


if __name__ == "__main__":
    unittest.main()
