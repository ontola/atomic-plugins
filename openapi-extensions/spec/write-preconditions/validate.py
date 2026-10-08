"""Validate Write Preconditions 0.1.0-draft declarations, and reference client logic.

`validate(document)` raises ValueError listing every violation of the document
rules of §7 and returns None for a valid document. `may_send(...)` (§4.2, §4.4)
and `resolve_unknown(...)` (§4.5) are reference implementations for clients.
"""
import json
import sys

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
WRITES = {"put", "patch", "post", "delete"}
KINDS = {"ifMatch", "readVerify", "none"}
FIELDS = {"kind", "version", "header", "conflictStatus", "refuseWhen", "idempotent", "description"}
_MISSING = object()


def _scalar(value):
    return value is None or isinstance(value, (str, bool, int, float))


def _check(declaration, method, operation, where, errors):
    if not isinstance(declaration, dict):
        errors.append(f"{where}: expected an object")
        return
    unknown = {k for k in declaration if k not in FIELDS and not k.startswith("x-")}
    if unknown:
        errors.append(f"{where}: unknown fields {sorted(unknown)}")
    if method not in WRITES:
        errors.append(f"{where}: only on PUT, PATCH, POST or DELETE")
    crud = operation.get("x-crud")
    if isinstance(crud, dict) and crud.get("action") not in ("update", "delete"):
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
        if ("values" in refusal) == ("present" in refusal):
            errors.append(f"{label}: exactly one of values and present")
        elif "present" in refusal:
            if refusal["present"] is not True:
                errors.append(f"{label}.present: expected true")
        else:
            values = refusal["values"]
            if not (isinstance(values, list) and values and all(_scalar(v) for v in values)):
                errors.append(f"{label}.values: expected a nonempty array of JSON scalars")
        if {k for k in refusal if k not in ("field", "values", "present", "description") and not k.startswith("x-")}:
            errors.append(f"{label}: unknown fields")
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
                       f"paths.{path}.{method}.x-write-precondition", errors)
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


def refused(declaration, current):
    """The first Refusal Object that matches the object, or None."""
    for refusal in (declaration or {}).get("refuseWhen", []):
        value = _field(current, refusal["field"])
        if refusal.get("present") is True:
            if value is not None:
                return refusal
        elif any(_same(value, v) for v in refusal["values"]):
            return refusal
    return None


def may_send(declaration, baseline, written, current, headers=None):
    """§4.2/§4.4: ('send', headers) | ('refused', refusal) | ('conflict', fields) | ('read-first', None).

    `baseline` maps written fields (dot-paths) to their last read values,
    `written` lists the fields the write sets, `current` is the object as just
    read (readVerify) or as last read, or None when not read, and `headers`
    the response headers of that read (for a header version).
    """
    declaration = declaration or {}
    kind = declaration.get("kind")
    if current is None and (kind in ("ifMatch", "readVerify") or declaration.get("refuseWhen")):
        return "read-first", None
    if current is not None:
        refusal = refused(declaration, current)
        if refusal:
            return "refused", refusal
    if kind == "ifMatch":
        value = version_of(declaration, current, headers)
        if value is None:
            return "read-first", None
        return "send", {declaration.get("header", "If-Match"): value}
    if kind == "readVerify":
        changed = sorted(f for f in written if not _same(_field(current, f), baseline.get(f)))
        if changed:
            return "conflict", changed
    return "send", {}


def resolve_unknown(declaration, method, baseline, written, read=None, sent_version=None,
                    action=None, deletion_confirmed=False, tombstone=None):
    """§4.5 after an unknown outcome.

    Returns 'resend' (no read needed), 'read-first', 'applied', 'not-applied',
    'conflict', 'refused', 'gone-unconfirmed' (a DELETE answered 404/410 without
    a declaration that a missing object was deleted) or 'unknown'.

    `action` is the operation's x-crud action ('update' or 'delete'); without
    it the HTTP method decides. `written` maps fields to the values the write
    set (empty for a delete); `baseline` maps fields to their last read values
    (for a delete, every field the client holds); `read` is None (not read yet)
    or {'status': int, 'body': ..., 'headers': {...}}; `sent_version` is the
    version an ifMatch write sent. `deletion_confirmed` is true when a
    collection of the resource declares notFound: deleted explicitly or
    absent: deleted, or the resource has a deletion feed; `tombstone` is the
    resource's x-read-tombstone ({field, values}) or None.
    """
    declaration = declaration or {}
    kind = declaration.get("kind")
    method = method.lower()
    is_delete = action == "delete" if action else method == "delete"
    idempotent = declaration.get("idempotent", method in ("put", "delete"))
    if read is None:
        if kind != "readVerify" and idempotent:
            return "resend"
        return "read-first"
    status, body = read.get("status"), read.get("body")
    headers = read.get("headers")
    ok = isinstance(status, int) and 200 <= status < 300
    if ok and isinstance(body, dict) and refused(declaration, body):
        return "refused"
    if is_delete:
        if status in (404, 410):
            return "applied" if deletion_confirmed else "gone-unconfirmed"
        if not ok:
            return "unknown"
        if tombstone and isinstance(body, dict) and any(_same(_field(body, tombstone["field"]), v) for v in tombstone["values"]):
            return "applied"
        if kind == "ifMatch" and sent_version is not None:
            unchanged = _same(version_of(declaration, body, headers), sent_version)
        else:
            unchanged = all(_same(_field(body, f), v) for f, v in baseline.items())
        return "not-applied" if unchanged else "conflict"
    if not ok or not written:
        return "unknown"
    if all(_same(_field(body, f), v) for f, v in written.items()):
        return "applied"
    at_baseline = all(_same(_field(body, f), baseline.get(f)) for f in written)
    if kind == "ifMatch" and sent_version is not None:
        if _same(version_of(declaration, body, headers), sent_version):
            return "not-applied"
        return "conflict"  # another writer changed the version; a resend with the old one would fail
    return "not-applied" if at_baseline else "conflict"


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
