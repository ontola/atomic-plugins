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
        values = refusal.get("values")
        if not (isinstance(values, list) and values and all(_scalar(v) for v in values)):
            errors.append(f"{label}.values: expected a nonempty array of JSON scalars")
        if {k for k in refusal if k not in ("field", "values", "description") and not k.startswith("x-")}:
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
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return _MISSING
        value = value[key]
    return value


def _same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def refused(declaration, current):
    """The first Refusal Object that matches the object, or None."""
    for refusal in (declaration or {}).get("refuseWhen", []):
        value = _field(current, refusal["field"])
        if value is not _MISSING and any(_same(value, v) for v in refusal["values"]):
            return refusal
    return None


def may_send(declaration, baseline, written, current):
    """§4.2/§4.4: ('send', headers) | ('refused', refusal) | ('conflict', fields) | ('read-first', None).

    `baseline` maps written fields (dot-paths) to their last read values,
    `written` the fields the write sets, `current` the object as just read
    (readVerify) or as last read (ifMatch, none), or None when not read.
    """
    kind = (declaration or {}).get("kind")
    if current is None and kind in ("ifMatch", "readVerify"):
        return "read-first", None
    if current is not None:
        refusal = refused(declaration, current)
        if refusal:
            return "refused", refusal
    if kind == "ifMatch":
        version = declaration["version"]
        if version["in"] != "body":
            raise ValueError("a header version is passed by the caller, from the read's response headers")
        value = _field(current, version["name"])
        if value is _MISSING:
            return "read-first", None
        return "send", {declaration.get("header", "If-Match"): value}
    if kind == "readVerify":
        changed = sorted(f for f in written if not _same(_field(current, f), baseline.get(f, _MISSING)))
        if changed:
            return "conflict", changed
    return "send", {}


def resolve_unknown(declaration, method, baseline, written, current):
    """§4.5 after an unknown outcome: 'resend', 'applied', 'not-applied' or 'conflict'.

    `written` maps fields to the values the write set; `current` is the object
    read after the unknown outcome, or None when the client has not read it.
    """
    default = method.lower() in ("put", "delete")
    idempotent = (declaration or {}).get("idempotent", default)
    if current is None:
        return "resend" if idempotent else "read-first"
    if all(_same(_field(current, f), v) for f, v in written.items()):
        return "applied"
    if all(_same(_field(current, f), baseline.get(f, _MISSING)) for f in written):
        return "not-applied"
    return "conflict"


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
