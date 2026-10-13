"""Validate the Filtering proposal's parameter annotations, and convert wall-clock bounds.

`validate(document)` checks every `x-time-zone` (0.2.0-draft) and the shape of
every `x-filter` on a Parameter Object: the parameters of every operation
under `paths`, `webhooks`, `components.pathItems` and callbacks (an
operation's own and `components.callbacks`), and `components.parameters`.
It reports an `x-time-zone` anywhere else. `x-collection-scope` and
`x-for-each` are not checked. Ordinary OpenAPI validation is separate.

`wall_clock_param(...)`, `instants_of(...)` and `covered_span(...)` are a
reference implementation of the client steps under "Parameter time zones".
"""
import datetime
import json
import pathlib
import re
import sys
from zoneinfo import ZoneInfo

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
OPERATORS = ("eq", "gte", "gt", "lte", "lt")
AMBIGUOUS = ("unspecified", "earlier", "later")
POINTER = re.compile(r"^(/([^~/]|~[01])*)*$")
ZONE_FIELDS = {"interpretation", "zone", "suffix", "ambiguous", "description"}
# Current offsets run from UTC-12 to UTC+14. A lower bound needs only 12 hours,
# an upper bound 14; the fallback uses 14 for both (see the README).
MAX_OFFSET = datetime.timedelta(hours=14)
UTC = datetime.timezone.utc


def _deref(document, value):
    seen = set()
    while isinstance(value, dict) and "$ref" in value:
        ref = value["$ref"]
        if not isinstance(ref, str) or not ref.startswith("#/") or ref in seen:
            return None
        seen.add(ref)
        value = document
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(value, dict) or part not in value:
                return None
            value = value[part]
    return value


def _path_item_operations(document, item, location, seen):
    """(location, method, item, operation) of a path item, and of its operations' callbacks."""
    item = _deref(document, item)
    if not isinstance(item, dict) or id(item) in seen:
        return
    seen.add(id(item))
    yield location, None, item, None  # the path item itself; operations() leaves it out
    for method in METHODS:
        operation = item.get(method)
        if not isinstance(operation, dict):
            continue
        yield location, method, item, operation
        for name, callback in (operation.get("callbacks") or {}).items():
            callback = _deref(document, callback)
            for expression, nested in (callback or {}).items() if isinstance(callback, dict) else []:
                yield from _path_item_operations(
                    document, nested, f"{location}.{method}.callbacks.{name}.{expression}", seen)


def operations(document, callable_only=False):
    """Every operation in the document; with callable_only, only those under `paths`."""
    return (entry for entry in _entries(document, callable_only) if entry[3] is not None)


def path_items(document):
    """(location, path item) of every path item, operations or not."""
    return ((entry[0], entry[2]) for entry in _entries(document, False) if entry[3] is None)


def _entries(document, callable_only):
    seen = set()
    for path, item in (document.get("paths") or {}).items():
        yield from (
            entry for entry in _path_item_operations(document, item, f"paths.{path}", seen)
            if not callable_only or ".callbacks." not in entry[0]
        )
    if callable_only:
        return
    for name, item in (document.get("webhooks") or {}).items():
        yield from _path_item_operations(document, item, f"webhooks.{name}", seen)
    components = document.get("components") or {}
    for name, item in (components.get("pathItems") or {}).items():
        yield from _path_item_operations(document, item, f"components.pathItems.{name}", seen)
    for name, callback in (components.get("callbacks") or {}).items():
        callback = _deref(document, callback)
        for expression, item in (callback or {}).items() if isinstance(callback, dict) else []:
            yield from _path_item_operations(
                document, item, f"components.callbacks.{name}.{expression}", seen)


def parameters_of(document, item, operation):
    """The resolved parameters of an operation, its own overriding its path item's by (in, name)."""
    found = {}
    for source in (item, operation):
        for raw in source.get("parameters") or []:
            parameter = _deref(document, raw)
            if isinstance(parameter, dict) and "name" in parameter and "in" in parameter:
                found[(parameter["in"], parameter["name"])] = parameter
    return found


def _parameter_formats(document, parameter):
    """The `format` of every schema the parameter declares: `schema`, or each `content` entry's,
    and the schemas their `allOf`, `oneOf` and `anyOf` hold."""
    pending = [parameter.get("schema")]
    for media in (parameter.get("content") or {}).values():
        if isinstance(media, dict):
            pending.append(media.get("schema"))
    formats, seen = [], set()
    while pending:
        schema = _deref(document, pending.pop())
        if not isinstance(schema, dict) or id(schema) in seen:
            continue
        seen.add(id(schema))
        if "format" in schema:
            formats.append(schema["format"])
        for key in ("allOf", "oneOf", "anyOf"):
            if isinstance(schema.get(key), list):
                pending.extend(schema[key])
    return formats


def _filter_errors(value, where):
    if not isinstance(value, dict):
        return [f"{where}: expected an object"]
    errors = []
    if not isinstance(value.get("field"), str) or not POINTER.match(value["field"]):
        errors.append(f"{where}.field: expected a JSON Pointer")
    if value.get("operator") not in OPERATORS:
        errors.append(f"{where}.operator: expected one of {OPERATORS}")
    if "description" in value and not isinstance(value["description"], str):
        errors.append(f"{where}.description: expected a string")
    return errors


def _zone_errors(document, value, where, parameter):
    if not isinstance(value, dict):
        return [f"{where}: expected an object"]
    errors = [f"{where}.{key}: unknown member" for key in value if key not in ZONE_FIELDS and not key.startswith("x-")]
    if value.get("interpretation") != "wallClock":
        errors.append(f"{where}.interpretation: expected 'wallClock'")
    if "suffix" in value and (not isinstance(value["suffix"], str)
                              or not re.fullmatch(r"Z|[+-]\d{2}:\d{2}", value["suffix"])):
        errors.append(f"{where}.suffix: expected 'Z' or an offset such as '+00:00'")
    if value.get("ambiguous", "unspecified") not in AMBIGUOUS:
        errors.append(f"{where}.ambiguous: expected one of {AMBIGUOUS}")
    if "description" in value and not isinstance(value["description"], str):
        errors.append(f"{where}.description: expected a string")
    zone = value.get("zone")
    if not isinstance(zone, dict):
        errors.append(f"{where}.zone: expected an object")
    else:
        extra = [k for k in zone if k not in ("name", "operationId", "pointer") and not k.startswith("x-")]
        errors += [f"{where}.zone.{k}: unknown member" for k in extra]
        if ("name" in zone) == ("operationId" in zone):
            errors.append(f"{where}.zone: expected exactly one of name and operationId")
        if "name" in zone and (not isinstance(zone["name"], str) or not zone["name"]):
            errors.append(f"{where}.zone.name: expected an IANA time zone name")
        if "operationId" in zone:
            if not isinstance(zone["operationId"], str):
                errors.append(f"{where}.zone.operationId: expected a string")
            if not isinstance(zone.get("pointer"), str) or not POINTER.match(zone["pointer"]) or zone["pointer"] == "":
                errors.append(f"{where}.zone.pointer: expected a non-empty JSON Pointer with operationId")
        elif "pointer" in zone:
            errors.append(f"{where}.zone.pointer: allowed only with operationId")
    for found in _parameter_formats(document, parameter):
        if found != "date-time":
            errors.append(f"{where}: the parameter's schema format is {found!r}, not 'date-time'")
    return errors


def _zone_operation_errors(document, zone, where, own_path_parameters=None):
    """The named operation exists under `paths`, is a get, and needs only path parameters the request has.

    `own_path_parameters` None: the parameter is not used by any operation, so
    only existence and method are checked.
    """
    if not isinstance(zone, dict) or not isinstance(zone.get("operationId"), str):
        return []
    for _, method, item, operation in operations(document, callable_only=True):
        if operation.get("operationId") != zone["operationId"]:
            continue
        if method != "get":
            return [f"{where}.zone.operationId: {zone['operationId']!r} is a {method}, not a get"]
        if own_path_parameters is None:
            return []
        missing = sorted(
            name for (kind, name), parameter in parameters_of(document, item, operation).items()
            if parameter.get("required") and not (kind == "path" and name in own_path_parameters)
        )
        if missing:
            return [f"{where}.zone.operationId: {zone['operationId']!r} requires parameters {missing} the request does not have"]
        return []
    return [f"{where}.zone.operationId: no operation {zone['operationId']!r} under paths"]


def validate(document):
    """Raise ValueError listing every violation; return None when valid."""
    errors, annotated, used = [], set(), set()
    checked = set()

    def check_shape(parameter, where):
        if id(parameter) in checked:
            return
        checked.add(id(parameter))
        if "x-filter" in parameter:
            errors.extend(_filter_errors(parameter["x-filter"], where + ".x-filter"))
        if "x-time-zone" in parameter:
            errors.extend(_zone_errors(document, parameter["x-time-zone"], where + ".x-time-zone", parameter))

    for location, method, item, operation in operations(document):
        found = parameters_of(document, item, operation)
        own_path = {name for (kind, name) in found if kind == "path"}
        for (kind, name), parameter in found.items():
            where = f"{location}.{method}.parameters[{kind}:{name}]"
            annotated.add(id(parameter))
            used.add(id(parameter))
            check_shape(parameter, where)
            zone = parameter.get("x-time-zone")
            if isinstance(zone, dict):
                errors += _zone_operation_errors(document, zone.get("zone"), where + ".x-time-zone", own_path)
    # Parameters listed on a path item or operation but not in effect: a path-item
    # parameter an operation shadows, or one on a path item without operations.
    for location, item in path_items(document):
        listed = [(f"{location}.parameters", raw) for raw in item.get("parameters") or []]
        for method in METHODS:
            operation = item.get(method)
            if isinstance(operation, dict):
                listed += [(f"{location}.{method}.parameters", raw) for raw in operation.get("parameters") or []]
        for where, raw in listed:
            parameter = _deref(document, raw)
            if not isinstance(parameter, dict) or id(parameter) in used:
                continue
            where = f"{where}[{parameter.get('in')}:{parameter.get('name')}]"
            annotated.add(id(parameter))
            used.add(id(parameter))
            check_shape(parameter, where)
            zone = parameter.get("x-time-zone")
            if isinstance(zone, dict):
                errors += _zone_operation_errors(document, zone.get("zone"), where + ".x-time-zone")
    for name, raw in ((document.get("components") or {}).get("parameters") or {}).items():
        parameter = _deref(document, raw)
        if not isinstance(parameter, dict):
            continue
        where = f"components.parameters.{name}"
        annotated.add(id(parameter))
        check_shape(parameter, where)
        zone = parameter.get("x-time-zone")
        if id(parameter) not in used and isinstance(zone, dict):
            errors += _zone_operation_errors(document, zone.get("zone"), where + ".x-time-zone")
    errors += _misplaced(document, "", annotated)
    if errors:
        raise ValueError("\n".join(dict.fromkeys(errors)))


def _misplaced(value, location, annotated):
    found = []
    if isinstance(value, dict):
        if "x-time-zone" in value and id(value) not in annotated:
            found.append(f"{location or '$'}.x-time-zone: allowed only on a Parameter Object")
        for key, child in value.items():
            found += _misplaced(child, f"{location}.{key}" if location else key, annotated)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found += _misplaced(child, f"{location}[{index}]", annotated)
    return found


def wall_clock_param(instant, zone, suffix="Z"):
    """Step 2: the wall-clock digits of an aware datetime in `zone`, with `suffix`."""
    local = instant.astimezone(ZoneInfo(zone))
    return local.strftime("%Y-%m-%dT%H:%M:%S") + (suffix or "")


def instants_of(wall, zone):
    """The UTC instants a naive wall-clock datetime can mean in `zone`, by offset.

    Returns {"earlier": instant, "later": instant}: the instant under the
    offset in effect before a change (Python's fold=0) and under the offset
    after it (fold=1). Outside a repeated or skipped hour both are the same.
    In a repeated hour `earlier` is the earlier instant; in a skipped hour,
    where neither offset gives this wall-clock time back, `earlier` is the
    later instant (Amsterdam 2026-03-29 02:30 at +01:00 is 01:30Z).
    """
    tz = ZoneInfo(zone)
    return {
        "earlier": wall.replace(tzinfo=tz, fold=0).astimezone(UTC),
        "later": wall.replace(tzinfo=tz, fold=1).astimezone(UTC),
    }


def covered_span(start_wall, end_wall, zone, ambiguous="unspecified"):
    """Step 3: the UTC (from, to) a read with these wall-clock bounds is known to cover, or None.

    `ambiguous` `earlier` or `later` takes that offset's instant for both
    bounds; `unspecified` takes, of the two, the latest for the lower bound
    and the earliest for the upper bound. `zone` None means the zone could
    not be read and the bounds were sent as UTC digits: each bound then
    covers 14 hours less. A span that is empty or inverted covers nothing:
    None.
    """
    if zone is None:
        start = start_wall.replace(tzinfo=UTC) + MAX_OFFSET
        end = end_wall.replace(tzinfo=UTC) - MAX_OFFSET
    else:
        starts, ends = instants_of(start_wall, zone), instants_of(end_wall, zone)
        if ambiguous in ("earlier", "later"):
            start, end = starts[ambiguous], ends[ambiguous]
        else:
            start, end = max(starts.values()), min(ends.values())
    return (start, end) if start < end else None


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
        print(f"{name}: filtering annotations valid")
