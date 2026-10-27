"""Validate experimental Embedded Resources 0.1.0-draft metadata; no requests.

Runtime record values and persistence/merging policy are outside this validator.
"""
import json
import re
import sys

FIELD = "x-embeddedResources"
DOT_PATH = re.compile(r"^[^.\s[\]\x00-\x1f\x7f]+(?:\.[^.\s[\]\x00-\x1f\x7f]+)*$")
VARIABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESERVED = {"__proto__", "constructor", "prototype"}
DATA_KEYS = {"example", "examples", "default", "enum", "const"}
NAME_MAPS = {"properties", "patternProperties"}


def _object_schema(document, schema):
    seen = set()
    while isinstance(schema, dict) and "$ref" in schema:
        reference = schema["$ref"]
        if not isinstance(reference, str) or not reference.startswith("#/") or reference in seen:
            return False
        seen.add(reference)
        schema = document
        for key in reference[2:].split("/"):
            key = key.replace("~1", "/").replace("~0", "~")
            if not isinstance(schema, dict) or key not in schema:
                return False
            schema = schema[key]
    return isinstance(schema, dict) and (
        "type" not in schema or schema["type"] == "object"
    ) and (
        "properties" not in schema or isinstance(schema["properties"], dict)
    ) and (
        schema.get("type") == "object" or isinstance(schema.get("properties"), dict)
    )


def _identity(identity, where):
    if not isinstance(identity, dict) or not isinstance(identity.get("urlTemplate"), str):
        return [f"{where}.identity.urlTemplate is required"]
    template = identity["urlTemplate"]
    errors = []
    if not template.startswith("/") or template.startswith("//") or any(
        char <= " " or char == "\x7f" or char == "\\" for char in template
    ):
        errors.append(f"{where}.identity.urlTemplate: expected a safe path starting with one /")
    names = re.findall(r"\{([^}]+)\}", template)
    if any(not VARIABLE.fullmatch(name) or name in RESERVED for name in names) or re.search(
        r"[{}]", re.sub(r"\{[^}]+\}", "", template)
    ):
        errors.append(f"{where}: malformed identity template variables")
    bindings = identity.get("bindings", {})
    if not isinstance(bindings, dict):
        return errors + [f"{where}.identity.bindings must be an object"]
    for name, binding in bindings.items():
        if name not in names:
            errors.append(f"{where}: binding {name} is not an identity template variable")
        path = binding.get("field") if isinstance(binding, dict) else None
        if not isinstance(path, str) or not DOT_PATH.fullmatch(path):
            errors.append(f"{where}.identity.bindings.{name}.field: expected a dot-path")
    return errors


def _declaration(document, resources, raw, where):
    if not isinstance(raw, dict):
        return [f"{where}: expected an object"]
    errors = []
    paths = []
    for field, entry in raw.items():
        at = f"{where}.{field}"
        if not isinstance(field, str) or not DOT_PATH.fullmatch(field):
            errors.append(f"{at}: expected a nonempty dot-path")
        elif any(field.startswith(other + ".") or other.startswith(field + ".") for other in paths):
            errors.append(f"{at}: overlapping source field paths")
        if isinstance(field, str):
            paths.append(field)
        if not isinstance(entry, dict):
            errors.append(f"{at}: expected an object")
            continue
        for key in entry:
            if key not in ("resource", "cardinality") and not key.startswith("x-"):
                errors.append(f"{at}.{key}: unknown field")
        if entry.get("cardinality") not in ("one", "many"):
            errors.append(f"{at}.cardinality must be one or many")
        target_name = entry.get("resource")
        target = resources.get(target_name) if isinstance(target_name, str) else None
        if not isinstance(target, dict):
            errors.append(f"{at}.resource must name a declared CRUD resource")
            continue
        if not _object_schema(document, target.get("schema")):
            errors.append(f"{at}: {target_name}.schema must be a resolvable object schema")
        errors += _identity(target.get("identity"), f"{at}: {target_name}")
    return errors


def _misplaced(node, path, allowed, errors, names=False, parent=None):
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else key
            if key == FIELD and not names and id(node) not in allowed:
                errors.append(f"{here}: allowed only on a CRUD Resource Object")
            if not names and key in DATA_KEYS and not (key == "default" and parent == "responses"):
                continue
            _misplaced(value, here, allowed, errors,
                       names=not names and key in NAME_MAPS, parent=None if names else key)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _misplaced(value, f"{path}[{index}]", allowed, errors)


def validate(document):
    """Check declaration metadata; raise ValueError with every violation."""
    if not isinstance(document, dict):
        raise ValueError("document: expected an object")
    components = document.get("components")
    resources = components.get("crudResources", {}) if isinstance(components, dict) else {}
    errors = []
    allowed = set()
    if isinstance(resources, dict):
        for name, resource in resources.items():
            if not isinstance(resource, dict):
                continue
            allowed.add(id(resource))
            if FIELD in resource:
                errors += _declaration(document, resources, resource[FIELD],
                                       f"components.crudResources.{name}.{FIELD}")
    _misplaced(document, "", allowed, errors)
    if errors:
        raise ValueError("\n".join(errors))


def _load(path):
    with open(path, encoding="utf-8") as source:
        if path.endswith(".json"):
            return json.load(source)
        import yaml
        return yaml.safe_load(source)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        validate(_load(path))
        print(f"{path}: experimental embedded resources valid")
