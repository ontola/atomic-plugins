"""Validate experimental Embedded Resources 0.2.0-draft metadata; no requests.

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


def _target(document, resources, name, where):
    target = resources.get(name) if isinstance(name, str) else None
    if not isinstance(target, dict):
        return [f"{where}.resource must name a declared CRUD resource"]
    errors = []
    if not _object_schema(document, target.get("schema")):
        errors.append(f"{where}: {name}.schema must be a resolvable object schema")
    return errors + _identity(target.get("identity"), f"{where}: {name}")


def _declaration(document, resources, source, raw, where):
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
            if key not in ("representation", "resource", "cardinality", "discriminator", "reference") and not (isinstance(key, str) and key.startswith("x-")):
                errors.append(f"{at}.{key}: unknown field")
        if entry.get("cardinality") not in ("one", "many"):
            errors.append(f"{at}.cardinality must be one or many")
        representation = entry.get("representation", "object")
        if representation not in ("object", "identity"):
            errors.append(f"{at}.representation must be object or identity")
            continue
        if representation == "identity":
            if entry.get("cardinality") != "one":
                errors.append(f"{at}: identity representation supports cardinality one only")
            if "resource" in entry or "discriminator" in entry:
                errors.append(f"{at}: identity representation uses reference only")
            references = source.get("references", {})
            name = entry.get("reference")
            reference = references.get(name) if isinstance(references, dict) and isinstance(name, str) else None
            if not isinstance(reference, dict):
                errors.append(f"{at}.reference must name a declared source CRUD reference")
                continue
            target_name = reference.get("resource")
            errors += _target(document, resources, target_name, at)
            target = resources.get(target_name) if isinstance(target_name, str) else None
            identity = target.get("identity") if isinstance(target, dict) else None
            if isinstance(identity, dict):
                errors += _identity({"urlTemplate": identity.get("urlTemplate"),
                                     "bindings": reference.get("bindings")}, f"{at}.reference {name}")
            continue
        if "reference" in entry:
            errors.append(f"{at}: object representation cannot use reference")
        if ("resource" in entry) == ("discriminator" in entry):
            errors.append(f"{at}: object representation requires exactly one of resource or discriminator")
            continue
        if "resource" in entry:
            errors += _target(document, resources, entry["resource"], at)
            continue
        discriminator = entry["discriminator"]
        if not isinstance(discriminator, dict):
            errors.append(f"{at}.discriminator must be an object")
            continue
        for key in discriminator:
            if key not in ("field", "mapping") and not (isinstance(key, str) and key.startswith("x-")):
                errors.append(f"{at}.discriminator.{key}: unknown field")
        path = discriminator.get("field")
        if not isinstance(path, str) or not DOT_PATH.fullmatch(path):
            errors.append(f"{at}.discriminator.field: expected a dot-path")
        mapping = discriminator.get("mapping")
        if not isinstance(mapping, dict) or not mapping:
            errors.append(f"{at}.discriminator.mapping must be a nonempty object")
            continue
        for variant, target in mapping.items():
            if not isinstance(variant, str) or not variant:
                errors.append(f"{at}.discriminator.mapping: variants must be nonempty strings")
            errors += _target(document, resources, target, f"{at}.discriminator.mapping.{variant}")
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
                errors += _declaration(document, resources, resource, resource[FIELD],
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
