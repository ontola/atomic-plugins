"""Validate Deletion Feeds declarations (0.3.0-draft), and test list tombstones.

`validate(document)` raises ValueError listing every violation of the
document rules of §9 that the document alone can show; it returns None when
there is none. It cannot check the evidence rules (that the provider
documents a marked state as deletion, that a feed is oldest first).

`tombstone(declaration, item)` is §4.3's test of an item under a Tombstone
Object, `except` conditions included; `list_tombstone` (§4.5) and
`read_tombstone` (§4.4, which also checks the body is about the object read)
apply it.
"""
import json
import pathlib
import sys

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
MISSING = object()
TOMBSTONE_FIELDS = {"field", "values", "except"}
LIST_TOMBSTONE_FIELDS = {"field", "values", "except", "description"}
FEED_FIELDS = {"operationId", "envelope", "cursor", "tombstone", "idField", "description"}


def _resources(document):
    return (document.get("components") or {}).get("crudResources") or {}


def _scalar(value):
    return isinstance(value, (str, bool)) or (isinstance(value, (int, float)) and not isinstance(value, bool))


def _dot_path(value):
    return isinstance(value, str) and value != "" and all(value.split("."))


def _values(value, where, errors):
    if not isinstance(value, list) or not value:
        errors.append(f"{where}: expected a nonempty array")
    elif not all(_scalar(v) for v in value):
        errors.append(f"{where}: expected strings, numbers or booleans")


def _known(value, allowed, where, errors):
    unknown = sorted(k for k in value if k not in allowed and not str(k).startswith("x-"))
    if unknown:
        errors.append(f"{where}: unknown fields {unknown}")


def _tombstone(value, where, errors):
    """A Tombstone Object (§4.3)."""
    if not isinstance(value, dict):
        errors.append(f"{where}: expected an object")
        return
    _known(value, TOMBSTONE_FIELDS, where, errors)
    if not _dot_path(value.get("field")):
        errors.append(f"{where}.field: expected a dot-path")
    _values(value.get("values"), f"{where}.values", errors)
    _except(value, where, errors)


def _except(value, where, errors):
    if "except" in value:
        if not isinstance(value["except"], list) or not value["except"]:
            errors.append(f"{where}.except: expected a nonempty array")
        else:
            for index, condition in enumerate(value["except"]):
                _condition(condition, f"{where}.except[{index}]", errors)


def _condition(value, where, errors):
    """A Condition Object (§4.5)."""
    if not isinstance(value, dict):
        errors.append(f"{where}: expected an object")
        return
    _known(value, {"field", "values", "present"}, where, errors)
    if not _dot_path(value.get("field")):
        errors.append(f"{where}.field: expected a dot-path")
    operators = [k for k in ("values", "present") if k in value]
    if len(operators) != 1:
        errors.append(f"{where}: expected exactly one of values or present")
    elif operators == ["values"]:
        _values(value["values"], f"{where}.values", errors)
    elif value["present"] is not True:
        errors.append(f"{where}.present: expected true")


def _list_tombstone(value, where, errors):
    """A List Tombstone Object (§4.5)."""
    if not isinstance(value, dict):
        errors.append(f"{where}: expected an object")
        return
    _known(value, LIST_TOMBSTONE_FIELDS, where, errors)
    if not _dot_path(value.get("field")):
        errors.append(f"{where}.field: expected a dot-path")
    _values(value.get("values"), f"{where}.values", errors)
    _except(value, where, errors)
    if "description" in value and not isinstance(value["description"], str):
        errors.append(f"{where}.description: expected a string")


def _operations(document):
    for path, item in (document.get("paths") or {}).items():
        if not isinstance(item, dict):
            continue
        for method in METHODS:
            operation = item.get(method)
            if isinstance(operation, dict):
                yield path, method, operation


def _feed(value, where, errors, get_ids):
    if not isinstance(value, dict):
        errors.append(f"{where}: expected an object")
        return
    _known(value, FEED_FIELDS, where, errors)
    if value.get("operationId") not in get_ids:
        errors.append(f"{where}.operationId: names no GET operation of the document")
    if "tombstone" in value:
        _tombstone(value["tombstone"], f"{where}.tombstone", errors)


def validate(document):
    errors = []
    get_ids = {op.get("operationId") for _, method, op in _operations(document) if method == "get"}
    for name, resource in _resources(document).items():
        if not isinstance(resource, dict):
            continue
        where = f"crudResources.{name}"
        if "x-read-tombstone" in resource:
            _tombstone(resource["x-read-tombstone"], f"{where}.x-read-tombstone", errors)
        if "x-list-tombstone" in resource:
            errors.append(f"{where}.x-list-tombstone: only on a Collection Object or a list operation (§4.5)")
        for collection_name, collection in (resource.get("collections") or {}).items():
            if not isinstance(collection, dict):
                continue
            at = f"{where}.collections.{collection_name}"
            if "x-deletion-feed" in collection:
                _feed(collection["x-deletion-feed"], f"{at}.x-deletion-feed", errors, get_ids)
            if "x-list-tombstone" in collection:
                _list_tombstone(collection["x-list-tombstone"], f"{at}.x-list-tombstone", errors)
            if "x-read-tombstone" in collection:
                errors.append(f"{at}.x-read-tombstone: not on a Collection Object (§4.4)")
    for path, method, operation in _operations(document):
        at = f"paths.{path}.{method}"
        if "x-deletion-feed" in operation:
            _feed(operation["x-deletion-feed"], f"{at}.x-deletion-feed", errors, get_ids)
        if "x-read-tombstone" in operation:
            if method != "get":
                errors.append(f"{at}.x-read-tombstone: only on the read (GET) operation (§4.4)")
            _tombstone(operation["x-read-tombstone"], f"{at}.x-read-tombstone", errors)
        if "x-list-tombstone" in operation:
            if method not in ("get", "post"):
                errors.append(f"{at}.x-list-tombstone: only on a GET or POST list operation (§4.5)")
            _list_tombstone(operation["x-list-tombstone"], f"{at}.x-list-tombstone", errors)
    if errors:
        raise ValueError("\n".join(errors))


def get_path(value, path):
    """The value at a dot-path, or MISSING."""
    for name in path.split("."):
        if not isinstance(value, dict) or name not in value:
            return MISSING
        value = value[name]
    return value


def _same(a, b):
    """JSON equality of two scalars: same JSON type and value (`true` is not `1`, `"1"` is not `1`)."""
    def kind(v):
        if isinstance(v, bool):
            return "boolean"
        if isinstance(v, (int, float)):
            return "number"
        if isinstance(v, str):
            return "string"
        return None
    return kind(a) is not None and kind(a) == kind(b) and a == b


def _matches(condition, item):
    value = get_path(item, condition["field"])
    if value is MISSING:
        return False
    if condition.get("present") is True:
        return True
    return any(_same(value, v) for v in condition["values"])


def tombstone(declaration, item):
    """§4.3: whether an item (a feed item, a read's body or a list item) is a tombstone under a Tombstone Object."""
    if not isinstance(item, dict):
        return False
    value = get_path(item, declaration["field"])
    if value is MISSING or not any(_same(value, v) for v in declaration["values"]):
        return False
    return not any(_matches(condition, item) for condition in declaration.get("except", []))


def list_tombstone(declaration, item):
    """§4.5: whether one item of a collection's read is a list tombstone."""
    return tombstone(declaration, item)


def read_tombstone(declaration, body, id_field, object_id):
    """§4.4: whether a 2xx read body is a read tombstone of the object read."""
    if not isinstance(body, dict):
        return False
    identifier = get_path(body, id_field)
    if identifier is MISSING or identifier is None or str(identifier) != str(object_id):
        return False
    return tombstone(declaration, body)


def _load(path):
    text = pathlib.Path(path).read_text(encoding="utf-8")
    if path.endswith(".json"):
        return json.loads(text)
    import yaml

    return yaml.safe_load(text)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: validate.py DOCUMENT [DOCUMENT ...]")
    for name in sys.argv[1:]:
        validate(_load(name))
        print(f"{name}: deletion feeds valid")
