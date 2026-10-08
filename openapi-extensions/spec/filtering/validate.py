"""Validate the Filtering proposal's parameter annotations, and convert wall-clock bounds.

`validate(document)` checks every `x-time-zone` (0.2.0-draft) and the shape of
every `x-filter` on a Parameter Object: an operation's or path item's
parameters, and `components.parameters`. It reports an `x-time-zone`
anywhere else. `x-collection-scope` and `x-for-each` are not checked.
Ordinary OpenAPI validation is separate.

`wall_clock_param(...)` and `covered_span(...)` are a reference
implementation of the client steps under "Parameter time zones".
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
# No zone is further from UTC than this (UTC+14; the other end is UTC-12).
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


def operations(document):
    for path, item in (document.get("paths") or {}).items():
        if not isinstance(item, dict):
            continue
        for method in METHODS:
            operation = item.get(method)
            if isinstance(operation, dict):
                yield path, method, item, operation


def parameters_of(document, item, operation):
    """The resolved parameters of an operation, its own overriding its path item's by (in, name)."""
    found = {}
    for source in (item, operation):
        for raw in source.get("parameters") or []:
            parameter = _deref(document, raw)
            if isinstance(parameter, dict) and "name" in parameter and "in" in parameter:
                found[(parameter["in"], parameter["name"])] = parameter
    return found


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


def _zone_errors(value, where, parameter):
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
    schema = parameter.get("schema")
    if isinstance(schema, dict) and "format" in schema and schema["format"] != "date-time":
        errors.append(f"{where}: the parameter's schema format is {schema['format']!r}, not 'date-time'")
    return errors


def _zone_operation_errors(document, zone, where, own_path_parameters):
    """The named operation exists, is a get, and needs only path parameters the request already has."""
    if not isinstance(zone, dict) or not isinstance(zone.get("operationId"), str):
        return []
    for _, method, item, operation in operations(document):
        if operation.get("operationId") != zone["operationId"]:
            continue
        if method != "get":
            return [f"{where}.zone.operationId: {zone['operationId']!r} is a {method}, not a get"]
        missing = sorted(
            name for (kind, name), parameter in parameters_of(document, item, operation).items()
            if parameter.get("required") and not (kind == "path" and name in own_path_parameters)
        )
        if missing:
            return [f"{where}.zone.operationId: {zone['operationId']!r} requires parameters {missing} the request does not have"]
        return []
    return [f"{where}.zone.operationId: no operation {zone['operationId']!r} in the document"]


def validate(document):
    """Raise ValueError listing every violation; return None when valid."""
    errors, annotated = [], set()
    components = (document.get("components") or {}).get("parameters") or {}
    for name, raw in components.items():
        parameter = _deref(document, raw)
        if not isinstance(parameter, dict):
            continue
        annotated.add(id(parameter))
        where = f"components.parameters.{name}"
        if "x-filter" in parameter:
            errors += _filter_errors(parameter["x-filter"], where + ".x-filter")
        if "x-time-zone" in parameter:
            errors += _zone_errors(parameter["x-time-zone"], where + ".x-time-zone", parameter)
    for path, method, item, operation in operations(document):
        found = parameters_of(document, item, operation)
        own_path = {name for (kind, name) in found if kind == "path"}
        for (kind, name), parameter in found.items():
            where = f"paths.{path}.{method}.parameters[{kind}:{name}]"
            first = id(parameter) not in annotated
            annotated.add(id(parameter))
            if first and "x-filter" in parameter:
                errors += _filter_errors(parameter["x-filter"], where + ".x-filter")
            if "x-time-zone" in parameter:
                if first:
                    errors += _zone_errors(parameter["x-time-zone"], where + ".x-time-zone", parameter)
                errors += _zone_operation_errors(document, parameter["x-time-zone"].get("zone")
                                                 if isinstance(parameter["x-time-zone"], dict) else None,
                                                 where + ".x-time-zone", own_path)
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
    """Every UTC instant a naive wall-clock datetime can mean in `zone`, ascending.

    One normally, two in a repeated hour. In a skipped hour none is valid, so
    the two instants given by the offsets on either side of the gap.
    """
    tz = ZoneInfo(zone)
    candidates = sorted({wall.replace(tzinfo=tz, fold=fold).astimezone(UTC) for fold in (0, 1)})
    valid = [at for at in candidates if at.astimezone(tz).replace(tzinfo=None) == wall]
    return valid or candidates


def covered_span(start_wall, end_wall, zone, ambiguous="unspecified"):
    """Step 3: the UTC (from, to) a read with these wall-clock bounds is known to cover.

    `zone` None means the zone could not be read and the bounds were sent as
    UTC digits: each bound then covers 14 hours less.
    """
    if zone is None:
        return (start_wall.replace(tzinfo=UTC) + MAX_OFFSET, end_wall.replace(tzinfo=UTC) - MAX_OFFSET)
    starts, ends = instants_of(start_wall, zone), instants_of(end_wall, zone)
    if ambiguous == "earlier":
        return starts[0], ends[0]
    if ambiguous == "later":
        return starts[-1], ends[-1]
    return starts[-1], ends[0]


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
