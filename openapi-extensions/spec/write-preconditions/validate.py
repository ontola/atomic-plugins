"""Validate Write Preconditions 0.1.0-draft declarations, and reference client logic.

`validate(document)` raises ValueError listing every violation of the document
rules of §7 and returns None for a valid document. `may_send(...)` (§4.2, §4.4)
and `resolve_unknown(...)` (§4.5) are reference implementations for clients.
"""
import json
import re
import sys

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
WRITES = {"put", "patch", "post", "delete"}
KINDS = {"ifMatch", "readVerify", "none"}
FIELDS = {"kind", "version", "header", "conflictStatus", "refuseWhen", "idempotent", "description"}
_MISSING = object()
VARIABLE = re.compile(r"\{([^{}]+)\}")


def _scalar(value):
    return value is None or isinstance(value, (str, bool, int, float))


def _predicate(value, label, errors):
    """Exactly one of a nonempty values array of JSON scalars and present: true."""
    if ("values" in value) == ("present" in value):
        errors.append(f"{label}: exactly one of values and present")
    elif "present" in value:
        if value["present"] is not True:
            errors.append(f"{label}.present: expected true")
    else:
        values = value["values"]
        if not (isinstance(values, list) and values and all(_scalar(v) for v in values)):
            errors.append(f"{label}.values: expected a nonempty array of JSON scalars")


def _resources(document):
    if "swagger" in document:
        return document.get("x-crudResources", {})
    return document.get("components", {}).get("crudResources", {})


def _check(declaration, method, operation, where, errors, document=None, path=""):
    if not isinstance(declaration, dict):
        errors.append(f"{where}: expected an object")
        return
    unknown = {k for k in declaration if k not in FIELDS and not k.startswith("x-")}
    if unknown:
        errors.append(f"{where}: unknown fields {sorted(unknown)}")
    if method not in WRITES:
        errors.append(f"{where}: only on PUT, PATCH, POST or DELETE")
    crud = operation.get("x-crud")
    action = crud.get("action") if isinstance(crud, dict) else None
    if action == "create":
        refusals = declaration.get("refuseWhen") or []
        if declaration.get("kind") != "none" or not refusals or not all(
                isinstance(r, dict) and "source" in r for r in refusals):
            errors.append(f"{where}: on a create only kind none with source refusals")
        if "idempotent" in declaration:
            errors.append(f"{where}.idempotent: not on a create (§4.5 does not cover creates)")
    elif isinstance(crud, dict) and action not in ("update", "delete"):
        errors.append(f"{where}: x-crud action must be update or delete")
    kind = declaration.get("kind")
    if kind not in KINDS:
        errors.append(f"{where}.kind: expected ifMatch, readVerify or none")
    if kind == "ifMatch":
        version = declaration.get("version")
        if not isinstance(version, dict) or version.get("in") not in ("header", "body") \
                or not isinstance(version.get("name"), str) or not version["name"] \
                or {k for k in version if k not in ("in", "name") and not k.startswith("x-")}:
            errors.append(f"{where}.version: expected {{in: header|body, name}}")
        if "header" in declaration and not (isinstance(declaration["header"], str) and declaration["header"]):
            errors.append(f"{where}.header: expected a nonempty string")
        if "conflictStatus" in declaration:
            statuses = declaration["conflictStatus"]
            if not (isinstance(statuses, list) and statuses and len(set(map(repr, statuses))) == len(statuses)
                    and all(type(s) is int and 400 <= s <= 499 for s in statuses)):
                errors.append(f"{where}.conflictStatus: expected unique integers 400-499")
    else:
        for field in ("version", "header", "conflictStatus"):
            if field in declaration:
                errors.append(f"{where}.{field}: only with kind ifMatch")
    refusals = declaration.get("refuseWhen", [])
    if not isinstance(refusals, list):
        errors.append(f"{where}.refuseWhen: expected an array")
        refusals = []
    for index, refusal in enumerate(refusals):
        label = f"{where}.refuseWhen[{index}]"
        if not isinstance(refusal, dict) or not isinstance(refusal.get("field"), str) or not refusal["field"]:
            errors.append(f"{label}.field: expected a nonempty string")
            continue
        _predicate(refusal, label, errors)
        if {k for k in refusal if k not in ("field", "values", "present", "source", "when", "description")
                and not k.startswith("x-")}:
            errors.append(f"{label}: unknown fields")
        if "source" in refusal:
            source = refusal["source"]
            resource = _resources(document or {}).get(source.get("resource")) if isinstance(source, dict) else None
            if not isinstance(resource, dict):
                errors.append(f"{label}.source.resource: expected a crudResources key")
            else:
                template = (resource.get("identity") or {}).get("urlTemplate", "")
                missing = sorted(set(VARIABLE.findall(template)) - set(VARIABLE.findall(path)))
                if missing:
                    errors.append(f"{label}.source: identity variables {missing} are not path parameters of {path}")
        if "when" in refusal:
            when = refusal["when"]
            if not isinstance(when, dict) or not isinstance(when.get("field"), str) or not when["field"]:
                errors.append(f"{label}.when.field: expected a nonempty string")
            else:
                _predicate(when, f"{label}.when", errors)
                if {k for k in when if k not in ("field", "values", "present") and not k.startswith("x-")}:
                    errors.append(f"{label}.when: unknown fields")
    if "idempotent" in declaration and not isinstance(declaration["idempotent"], bool):
        errors.append(f"{where}.idempotent: expected a boolean")


def validate(document):
    errors = []
    for path, item in document.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method in METHODS:
            operation = item.get(method)
            if isinstance(operation, dict) and "x-write-precondition" in operation:
                _check(operation["x-write-precondition"], method, operation,
                       f"paths.{path}.{method}.x-write-precondition", errors, document, path)
    if errors:
        raise ValueError("\n".join(errors))


def _field(value, path):
    """The value at a dot-path; an absent field reads as None (§4.5: absent equals null)."""
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value


def _same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def _header(headers, name):
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return value
    return None


def version_of(declaration, body, headers=None):
    """The object's version under ifMatch, from the read's body or response headers, or None."""
    version = declaration["version"]
    if version["in"] == "header":
        return _header(headers, version["name"])
    return _field(body, version["name"])


def _matches(predicate, value):
    if predicate.get("present") is True:
        return value is not None
    return any(_same(value, v) for v in predicate["values"])


def refusal_of(declaration, current, body=None, sources=None, check_sources=True):
    """The first matching Refusal Object as (refusal, 'refused' | 'source-unknown'), or None.

    `current` is the write's object, `body` the write's request body (for
    `when`), `sources` maps a source resource to its object as read, or to
    None when it could not be read (§4.4.1: fail closed). With
    check_sources=False, Refusal Objects with a source are skipped.
    """
    for refusal in (declaration or {}).get("refuseWhen", []):
        when = refusal.get("when")
        if when is not None:
            if body is None and not check_sources:
                continue  # the resolution read of §4.5 re-checks the object's own states only
            if body is not None and not _matches(when, _field(body, when["field"])):
                continue  # without a body the condition cannot be ruled out: fail closed
        if "source" in refusal:
            if not check_sources:
                continue
            source = (sources or {}).get(refusal["source"]["resource"])
            if source is None:
                return refusal, "source-unknown"
            if _matches(refusal, _field(source, refusal["field"])):
                return refusal, "refused"
        elif _matches(refusal, _field(current, refusal["field"])):
            return refusal, "refused"
    return None


def refused(declaration, current, body=None, sources=None, check_sources=True):
    """The first matching Refusal Object, or None (a source that cannot be read matches)."""
    found = refusal_of(declaration, current, body, sources, check_sources)
    return found[0] if found else None


def may_send(declaration, baseline, written, current, headers=None, body=None, sources=None, action="update"):
    """§4.2/§4.4: ('send', headers) | ('refused', refusal) | ('conflict', fields) | ('read-first', None).

    `baseline` maps written fields (dot-paths) to their last read values,
    `written` lists the fields the write sets, `current` is the object as just
    read (readVerify) or as last read, or None when not read, and `headers`
    the response headers of that read (for a header version). `body` is the
    write's request body and `sources` the source objects (§4.4.1); a refusal
    whose source is missing from `sources` returns ('source-unknown', refusal).
    """
    declaration = declaration or {}
    kind = declaration.get("kind")
    own = [r for r in declaration.get("refuseWhen", []) if "source" not in r]
    if current is None and (kind in ("ifMatch", "readVerify") or own):
        return "read-first", None
    found = refusal_of(declaration, current, body, sources)
    if found:
        return found[1], found[0]
    if kind == "ifMatch":
        value = version_of(declaration, current, headers)
        if value is None:
            return "read-first", None
        return "send", {declaration.get("header", "If-Match"): value}
    if kind == "readVerify":
        compared = list(baseline) if action == "delete" else written  # a delete compares every baseline field
        changed = sorted(f for f in compared if not _same(_field(current, f), baseline.get(f)))
        if changed:
            return "conflict", changed
    return "send", {}


def write_answer(action, status, deletion_confirmed=False, gone=None):
    """§4.5 "The write's own answer": classify a 404/410 to the write itself, on any send.

    Returns 'applied' or 'gone-unconfirmed' for a delete, 'gone' for an update,
    or None when the status is not 404/410 (other answers keep their meaning).
    """
    if status not in (404, 410):
        return None
    if action == "delete":
        if status == 410 and gone is not None:
            confirmed = gone == "deleted"  # a stated gone decides a 410 (Collection Completeness 0.3.0)
        else:
            confirmed = deletion_confirmed
        return "applied" if confirmed else "gone-unconfirmed"
    return "gone"


def resolve_unknown(declaration, method, baseline, written, read=None, sent_version=None,
                    action=None, deletion_confirmed=False, tombstone=None, gone=None):
    """§4.5 after an unknown outcome.

    Only a known update or delete is resolved: by `action`, else by a PUT,
    PATCH or DELETE method; anything else (a POST without x-crud, a create)
    is 'unknown' and never resent.

    Returns 'resend' (no read needed), 'read-first', 'applied', 'not-applied',
    'conflict', 'refused', 'gone' (an update whose object is gone or deleted:
    stop), 'gone-unconfirmed' (a delete whose object is gone without
    confirmed deletion: stop, report no deletion) or 'unknown'.

    `action` is the operation's x-crud action ('update' or 'delete'); without
    it the HTTP method decides. `written` maps fields to the values the write
    set (empty for a delete); `baseline` maps fields to their last read values
    (for a delete, every field the client holds); `read` is None (not read
    yet) or {'status': int, 'body': ..., 'headers': {...}}; `sent_version` is
    the version an ifMatch write sent. `deletion_confirmed` is true for a
    Deletion Feeds tombstone for this object, an explicit notFound: deleted on
    a collection of the resource, or an absent: deleted collection the object
    was a member of when last read; it decides a 404, and a 410 without
    `gone`. `gone` is the resource's stated Collection Completeness 0.3.0
    `gone` value, or None: when stated, it alone decides a 410 (deleted
    confirms, unavailable does not).
    `tombstone` is the resource's x-read-tombstone or None.
    """
    declaration = declaration or {}
    kind = declaration.get("kind")
    method = method.lower()
    if action is None:
        action = {"put": "update", "patch": "update", "delete": "delete"}.get(method)
    if action not in ("update", "delete"):
        return "unknown"  # §4.5 covers only known updates and deletes: never resend a possible create
    idempotent = declaration.get("idempotent", method in ("put", "delete"))
    if read is None:
        if kind != "readVerify" and idempotent:
            return "resend"
        return "read-first"
    status, body = read.get("status"), read.get("body")
    headers = read.get("headers")
    answer = write_answer(action, status, deletion_confirmed, gone)
    if answer:  # rule 1
        return answer
    if not (isinstance(status, int) and 200 <= status < 300) or not isinstance(body, dict):
        return "unknown"  # rule 7
    if tombstone and any(_same(_field(body, tombstone["field"]), v) for v in tombstone["values"]):
        return "applied" if action == "delete" else "gone"  # rule 2
    if action != "delete":
        if not written:
            return "unknown"
        if all(_same(_field(body, f), v) for f, v in written.items()):
            return "applied"  # rule 3
    if refused(declaration, body, check_sources=False):
        return "refused"  # rule 4
    if kind == "ifMatch" and sent_version is not None:  # rule 5
        return "not-applied" if _same(version_of(declaration, body, headers), sent_version) else "conflict"
    fields = list(baseline) if action == "delete" else list(written)
    if not fields or any(f not in baseline for f in fields):
        return "unknown"  # rule 6 needs a baseline for every compared field
    return "not-applied" if all(_same(_field(body, f), baseline[f]) for f in fields) else "conflict"  # rule 6


def _load(path):
    with open(path, encoding="utf-8") as source:
        if path.endswith(".json"):
            return json.load(source)
        import yaml
        return yaml.safe_load(source)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        validate(_load(name))
        print(f"{name}: write preconditions valid")
