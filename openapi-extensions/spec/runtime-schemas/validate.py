"""Validate Runtime Schemas 0.1.0-draft in an OpenAPI document, and read members.

`validate(document)` checks every `x-runtime-schema` against schema.json
(rules 2, 3, 6, 7 and 8), that it sits on a CRUD Causality Resource Object
(rule 1), that its `describedBy.reference` names a Reference Object of the
same resource whose resource exists (rule 4), and that the describer's
`identity.urlTemplate`, when the document has that path, has a `get` (rule
5). Ordinary OpenAPI validation is separate.

`derive_class(...)` and `read_members(...)` are a reference implementation of
§5.1 to §5.4: they derive the class one describer defines, and read one
item's members against it.
"""
import json
import pathlib
import re
import sys

from jsonschema import Draft202012Validator

SCHEMA = json.loads((pathlib.Path(__file__).parent / "schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA)
SEGMENT = re.compile(r'\["([^"]+)"\]|([^.\[\]]+)')
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
MISSING = object()


def segments(path):
    """The segments of a dot-path (§3); [] for the empty path."""
    if path == "":
        return []
    found, position = [], 0
    while True:
        match = SEGMENT.match(path, position)
        if not match:
            raise ValueError(f"malformed dot-path {path!r}")
        found.append(match.group(1) or match.group(2))
        position = match.end()
        if position == len(path):
            return found
        if path[position] != ".":
            raise ValueError(f"malformed dot-path {path!r}")
        position += 1


def get_path(value, path):
    """The value at a dot-path, or MISSING."""
    for segment in segments(path):
        if not isinstance(value, dict) or segment not in value:
            return MISSING
        value = value[segment]
    return value


def _errors(value, location):
    return [
        f"{location}{''.join('.' + str(p) for p in error.absolute_path)}: {error.message}"
        for error in sorted(VALIDATOR.iter_errors(value), key=lambda e: list(e.absolute_path))
    ]


def _misplaced(value, location, errors):
    """Rule 1: report x-runtime-schema anywhere but on a CRUD Resource Object."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "x-runtime-schema":
                errors.append(f"{location}.x-runtime-schema: allowed only on a CRUD Resource Object")
            _misplaced(child, f"{location}.{key}", errors)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _misplaced(child, f"{location}[{index}]", errors)


def validate(document, warnings=None):
    """Raise ValueError listing every violation; return None when valid.

    `warnings`, when a list, receives rule-5 checks that could not be made,
    and a warning for `keyedBy: name` with `match: key` (§4.1).
    """
    errors = []
    resources = document.get("components", {}).get("crudResources", {})
    if not isinstance(resources, dict):
        raise ValueError("components.crudResources: expected an object")
    for key, value in document.items():
        if key != "components":
            _misplaced(value, key, errors)
    for key, value in document.get("components", {}).items():
        if key != "crudResources":
            _misplaced(value, f"components.{key}", errors)
    for name, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        location = f"components.crudResources.{name}"
        for key, value in resource.items():
            if key != "x-runtime-schema":
                _misplaced(value, f"{location}.{key}", errors)
        runtime = resource.get("x-runtime-schema")
        if runtime is None:
            continue
        where = f"{location}.x-runtime-schema"
        found = _errors(runtime, where)
        errors += found
        if found:
            continue
        if runtime["keyedBy"] == "name" and runtime["match"] == "key" and warnings is not None:
            warnings.append(f"{where}: keyedBy name with match key races renames; use match id when members carry their id")
        reference_name = runtime["describedBy"]["reference"]
        references = resource.get("references")
        reference = references.get(reference_name) if isinstance(references, dict) else None
        if not isinstance(reference, dict):
            errors.append(f"{where}.describedBy.reference: {location}.references has no {reference_name!r}")
            continue
        target = reference.get("resource")
        if not isinstance(target, str) or not isinstance(resources.get(target), dict):
            errors.append(f"{where}.describedBy.reference: references.{reference_name}.resource {target!r} is not a crudResources key")
            continue
        identity = resources[target].get("identity")
        template = identity.get("urlTemplate") if isinstance(identity, dict) else None
        paths = document.get("paths")
        item = paths.get(template) if isinstance(paths, dict) and isinstance(template, str) else None
        if item is None:
            if warnings is not None:
                warnings.append(f"{where}: no paths entry {template!r} for the describer's read; rule 5 not checked")
        elif not isinstance(item, dict) or not isinstance(item.get("get"), dict):
            errors.append(f"{where}.describedBy: the describer's identity.urlTemplate {template!r} has no get operation")
    if errors:
        raise ValueError("\n".join(errors))


def _definitions(runtime, describer):
    """[(key, definition)] of a describer; key is the map key, or None for an array."""
    found = get_path(describer, runtime["describedBy"]["definitions"])
    if runtime["describedBy"]["shape"] == "map":
        return list(found.items()) if isinstance(found, dict) else []
    return [(None, d) for d in found] if isinstance(found, list) else []


def derive_class(runtime, describer):
    """§5.1: the class one describer defines.

    Returns {"properties": {id: property}, "undescribed": [id], "names":
    {id: name} for every definition, "duplicates": [id], "duplicateNames":
    [name], "duplicateOptions": {id: [option id]}}. Each property is {"name",
    "type", "schema", "key"}, with "description" when the document names
    that field, and for an option type "options" (option id -> name or None,
    the first of a repeated id kept) and "multiple". A definition id that
    occurs more than once gets no property.
    """
    fields = runtime["definition"]
    properties, undescribed, names = {}, [], {}
    seen, duplicates, name_count, duplicate_options = set(), [], {}, {}
    for key, definition in _definitions(runtime, describer):
        if not isinstance(definition, dict):
            continue
        identifier = get_path(definition, fields["id"])
        kind = get_path(definition, fields["type"])
        if not isinstance(identifier, str) or not isinstance(kind, str):
            continue
        if identifier in seen:
            if identifier not in duplicates:
                duplicates.append(identifier)
            continue
        seen.add(identifier)
        name = get_path(definition, fields["name"]) if "name" in fields else MISSING
        if name is MISSING:
            name = key if key is not None and runtime["keyedBy"] == "name" else identifier
        names[identifier] = name
        name_count[name] = name_count.get(name, 0) + 1
        described = runtime["types"].get(kind)
        if described is None:
            undescribed.append(identifier)
            continue
        prop = {"name": name, "type": kind, "schema": described["schema"], "key": key}
        if "description" in fields:
            text = get_path(definition, fields["description"])
            prop["description"] = None if text is MISSING else text
        if "options" in described:
            spec = described["options"]
            options = get_path(definition, spec["field"])
            prop["options"] = {}
            for option in options if isinstance(options, list) else []:
                option_id = get_path(option, spec["id"]) if isinstance(option, dict) else MISSING
                if not isinstance(option_id, str):
                    continue
                if option_id in prop["options"]:
                    duplicate_options.setdefault(identifier, []).append(option_id)
                    continue
                option_name = get_path(option, spec["name"])
                prop["options"][option_id] = None if option_name is MISSING else option_name
            prop["multiple"] = described.get("multiple", False)
        properties[identifier] = prop
    for identifier in duplicates:
        properties.pop(identifier, None)
        if identifier in undescribed:
            undescribed.remove(identifier)
    return {
        "properties": properties,
        "undescribed": undescribed,
        "names": names,
        "duplicates": duplicates,
        "duplicateNames": [name for name, count in name_count.items() if count > 1],
        "duplicateOptions": duplicate_options,
    }


def _option_ids(value, spec, multiple):
    """The option id or ids of an option value, or MISSING when its shape is wrong (§4.5)."""
    def one(ref):
        identifier = get_path(ref, spec["valueId"]) if isinstance(ref, dict) else MISSING
        return identifier if isinstance(identifier, str) else MISSING

    if multiple:
        if not isinstance(value, list):
            return MISSING
        ids = [one(ref) for ref in value]
        return MISSING if any(i is MISSING for i in ids) else ids
    return None if value is None else one(value)


def read_members(runtime, derived, item):
    """§5.1 to §5.4: one item's values by definition id.

    Returns {"values": {id: value}, "unmatched": [member key], "undescribed":
    [member key], "invalid": [member key], "conflicting": [member key]}. An
    option value is its option id (or a list of them); an option id the
    definition no longer lists is kept (§5.3 rule 4). A member without a
    value at its type's `value` path has no value (§4.4). A member whose
    option value has the wrong shape is "invalid" and has no value. Two or
    more members that match the same definition are all "conflicting", and
    none gives a value.
    """
    members = get_path(item, runtime["field"])
    result = {"values": {}, "unmatched": [], "undescribed": [], "invalid": [], "conflicting": []}
    if not isinstance(members, dict):
        return result
    properties = derived["properties"]
    names = derived.get("names") or {i: p["name"] for i, p in properties.items()}
    skipped = set(derived["undescribed"]) | set(derived.get("duplicates", []))
    ambiguous_names = set(derived.get("duplicateNames", []))
    by_key = {}
    if runtime["keyedBy"] == "id":
        by_key = {identifier: identifier for identifier in names}
        by_key.update({identifier: identifier for identifier in skipped})
    else:
        by_key = {name: identifier for identifier, name in names.items() if name not in ambiguous_names}
    matched = {}
    for key, member in members.items():
        if runtime["match"] == "id":
            identifier = get_path(member, runtime["memberId"]) if isinstance(member, dict) else MISSING
        else:
            identifier = by_key.get(key, MISSING)
        if identifier in skipped:
            result["undescribed"].append(key)
            continue
        prop = properties.get(identifier) if isinstance(identifier, str) else None
        if prop is None:
            result["unmatched"].append(key)
            continue
        if "memberType" in runtime and get_path(member, runtime["memberType"]) != prop["type"]:
            result["unmatched"].append(key)
            continue
        matched.setdefault(identifier, []).append(key)
    for identifier, keys in matched.items():
        if len(keys) > 1:
            result["conflicting"].extend(keys)
            continue
        key, prop = keys[0], properties[identifier]
        value = get_path(members[key], runtime["types"][prop["type"]]["value"])
        if value is MISSING:
            continue
        if "options" in prop:
            value = _option_ids(value, runtime["types"][prop["type"]]["options"], prop["multiple"])
            if value is MISSING:
                result["invalid"].append(key)
                continue
        result["values"][identifier] = value
    return result


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
        notes = []
        validate(_load(name), notes)
        for note in notes:
            print(f"{name}: warning: {note}")
        print(f"{name}: runtime schemas valid")
