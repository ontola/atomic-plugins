"""Write Preconditions 0.1.0-draft: document rules and reference client logic."""
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import may_send, resolve_unknown, validate, write_answer

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

    def test_resolution_order_and_gone_objects(self):
        read = lambda body, status=200: {"status": status, "body": body}
        tombstone = {"field": "in_trash", "values": [True]}
        # A trash PATCH that set in_trash: the written value holds, so applied, not refused.
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", {"in_trash": False}, {"in_trash": True},
                                         read({"in_trash": True})), "applied")
        # A soft DELETE reads back as a tombstone that refuseWhen also matches: applied.
        self.assertEqual(resolve_unknown(VERIFY, "DELETE", {"title": "A"}, {}, read({"title": "A", "in_trash": True}),
                                         tombstone=tombstone), "applied")
        # An update whose object is gone stops: a resent PUT could recreate it.
        for status in (404, 410):
            self.assertEqual(resolve_unknown(VERIFY, "PUT", {"title": "A"}, {"title": "B"}, read(None, status)), "gone")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", {"title": "A"}, {"title": "B"}, read({"title": "A", "in_trash": True}),
                                         tombstone=tombstone), "gone")

    def test_possible_creates_are_never_resent(self):
        # The round-7 probe: a POST create without x-crud must not be resent by §4.5.
        none_idempotent = {"kind": "none", "idempotent": True}
        self.assertEqual(resolve_unknown(none_idempotent, "POST", {}, {"title": "B"}), "unknown")
        self.assertEqual(resolve_unknown(none_idempotent, "POST", {}, {"title": "B"}, {"status": 200, "body": {"title": "A"}}), "unknown")
        self.assertEqual(resolve_unknown(none_idempotent, "PUT", {}, {"title": "B"}, action="create"), "unknown")
        # A POST known to be an update by x-crud is resolved as one.
        self.assertEqual(resolve_unknown(VERIFY, "POST", {"title": "A"}, {"title": "B"}, {"status": 200, "body": {"title": "B"}},
                                         action="update"), "applied")

    def test_rule_6_needs_a_baseline_for_every_compared_field(self):
        read = {"status": 200, "body": {"title": "A", "notes": "n"}}
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", {}, {"title": "B"}, read), "unknown")
        self.assertEqual(resolve_unknown(VERIFY, "PATCH", {"title": "A"}, {"title": "B", "notes": "m"}, read), "unknown")
        self.assertEqual(resolve_unknown(VERIFY, "DELETE", {}, {}, read), "unknown")

    def test_the_writes_own_answer(self):
        self.assertEqual(write_answer("delete", 404), "gone-unconfirmed")
        self.assertEqual(write_answer("delete", 410, deletion_confirmed=True), "applied")
        self.assertEqual(write_answer("update", 404), "gone")
        self.assertIsNone(write_answer("delete", 204))
        self.assertIsNone(write_answer("update", 412))

    def test_read_verify_delete_compares_every_baseline_field(self):
        baseline = {"title": "A", "notes": "n"}
        self.assertEqual(may_send(VERIFY, baseline, [], {"title": "A", "notes": "n"}, action="delete"), ("send", {}))
        self.assertEqual(may_send(VERIFY, baseline, [], {"title": "A", "notes": "changed"}, action="delete"),
                         ("conflict", ["notes"]))

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

    def test_source_and_when_validation(self):
        def document_with(refusal):
            document = example()
            document["components"] = {"crudResources": {"workspace": {
                "identity": {"urlTemplate": "/workspaces/{workspaceId}", "bindings": {"workspaceId": {"field": "id"}}},
                "collections": {"workspaces": {"urlTemplate": "/workspaces"}}}}}
            document["paths"]["/workspaces/{workspaceId}/entries/{entryId}"] = {"put": {
                "x-write-precondition": {"kind": "none", "refuseWhen": [refusal]},
                "responses": {"200": {"description": "ok"}}}}
            return document
        good = {"source": {"resource": "workspace"}, "field": "settings.forceProjects", "values": [True],
                "when": {"field": "projectId", "values": [None]}}
        validate(document_with(good))
        for bad, fragment in ((dict(good, source={"resource": "nope"}), "expected a crudResources key"),
                              (dict(good, when={"field": "projectId"}), "exactly one of values and present"),
                              (dict(good, when={"field": "", "present": True}), "when.field"),
                              (dict(good, when={"field": "p", "present": True, "x": 1}), "when: unknown fields")):
            with self.subTest(fragment=fragment), self.assertRaises(ValueError) as raised:
                validate(document_with(bad))
            self.assertIn(fragment, str(raised.exception))
        document = document_with(good)
        document["components"]["crudResources"]["workspace"]["identity"]["urlTemplate"] = "/orgs/{orgId}/workspaces/{workspaceId}"
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("['orgId'] are not path parameters", str(raised.exception))

    def test_creates_take_only_source_refusals(self):
        def document_with(declaration):
            document = example()
            document["components"] = {"crudResources": {"workspace": {
                "identity": {"urlTemplate": "/workspaces/{workspaceId}", "bindings": {"workspaceId": {"field": "id"}}}}}}
            document["paths"]["/workspaces/{workspaceId}/entries"] = {"post": {
                "x-crud": {"action": "create", "resource": "entry", "url": {"source": "template"}},
                "x-write-precondition": declaration, "responses": {"201": {"description": "ok"}}}}
            return document
        source = {"source": {"resource": "workspace"}, "field": "settings.forceProjects", "values": [True],
                  "when": {"field": "projectId", "values": [None]}}
        validate(document_with({"kind": "none", "refuseWhen": [source]}))
        with self.assertRaises(ValueError) as raised:
            validate(document_with({"kind": "none", "refuseWhen": [source], "idempotent": True}))
        self.assertIn("idempotent: not on a create", str(raised.exception))
        for bad in ({"kind": "none"}, {"kind": "readVerify", "refuseWhen": [source]},
                    {"kind": "none", "refuseWhen": [source, {"field": "in_trash", "values": [True]}]}):
            with self.subTest(bad=bad), self.assertRaises(ValueError) as raised:
                validate(document_with(bad))
            self.assertIn("on a create only kind none with source refusals", str(raised.exception))

    def test_source_refusal_fails_closed(self):
        force = {"kind": "none", "refuseWhen": [
            {"source": {"resource": "workspace"}, "field": "settings.forceProjects", "values": [True],
             "when": {"field": "projectId", "values": [None]}}]}
        forced = {"workspace": {"id": "w1", "settings": {"forceProjects": True}}}
        relaxed = {"workspace": {"id": "w1", "settings": {"forceProjects": False}}}
        no_project, with_project = {"description": "x"}, {"description": "x", "projectId": "p1"}
        # The write's own object need not be read for a source-only refusal.
        self.assertEqual(may_send(force, {}, ["description"], None, body=no_project, sources=forced)[0], "refused")
        self.assertEqual(may_send(force, {}, ["description"], None, body=with_project, sources=forced), ("send", {}))
        self.assertEqual(may_send(force, {}, ["description"], None, body=no_project, sources=relaxed), ("send", {}))
        # The source could not be read: a write the refusal could refuse is not sent; others are.
        self.assertEqual(may_send(force, {}, ["description"], None, body=no_project, sources={"workspace": None})[0], "source-unknown")
        self.assertEqual(may_send(force, {}, ["description"], None, body=no_project)[0], "source-unknown")
        self.assertEqual(may_send(force, {}, ["description"], None, body=with_project, sources={}), ("send", {}))
        # Without when, any write is refused while the source is unknown.
        unconditional = {"kind": "none", "refuseWhen": [{"source": {"resource": "workspace"}, "field": "locked", "values": [True]}]}
        self.assertEqual(may_send(unconditional, {}, ["x"], None, body={}, sources={})[0], "source-unknown")
        # The §4.5 resolution read re-checks the object's own states only.
        self.assertEqual(resolve_unknown(force, "PUT", {"description": "a"}, {"description": "x"},
                                         {"status": 200, "body": {"description": "x"}}), "applied")

    def test_refusals_need_a_read_and_header_versions_are_supported(self):
        refusing = {"kind": "none", "refuseWhen": [{"field": "in_trash", "values": [True]}]}
        self.assertEqual(may_send(refusing, {}, ["x"], None), ("read-first", None))
        header = {"kind": "ifMatch", "version": {"in": "header", "name": "ETag"}}
        self.assertEqual(may_send(header, {}, ["x"], {"x": 1}, {"etag": '"1"'}), ("send", {"If-Match": '"1"'}))
        self.assertEqual(may_send(header, {}, ["x"], {"x": 1}, {}), ("read-first", None))


if __name__ == "__main__":
    unittest.main()
