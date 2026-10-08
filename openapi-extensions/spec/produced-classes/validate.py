"""Validate Produced Classes 0.1.0-draft (`x-produces`) in an OpenAPI document.

`validate(document)` checks rules 1-6 of README §7 and raises ValueError
listing every violation. `validate_selection(selection, document)` checks the
catalog fallback of §5. Neither fetches a class or lens URI. Ordinary OpenAPI
validation is separate.
"""
import json
import re
import sys

FIELD = "x-produces"
KNOWN = {"class", "lens", "description"}
SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:")
FORBIDDEN = re.compile(r"[\s\x00-\x1f\x7f<>\"{}|\\^`]")


def absolute_uri(value):
    """An RFC 3986 absolute URI: a scheme, something after it, no whitespace."""
    if not isinstance(value, str) or FORBIDDEN.search(value):
        return False
    match = SCHEME.match(value)
    if not match or len(value) == match.end():
        return False
    scheme = value[: match.end() - 1].lower()
    if scheme in ("http", "https"):
        rest = value[match.end():]
        return rest.startswith("//") and len(rest) > 2 and rest[2] not in "/?#"
    return True


def check_list(value, where):
    """Rules 2-6 for one `x-produces` array."""
    if not isinstance(value, list) or not value:
        return [f"{where}: expected a nonempty array"]
    errors = []
    seen = set()
    for index, entry in enumerate(value):
        at = f"{where}[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{at}: expected an object")
            continue
        for key in entry:
            if key not in KNOWN and not (isinstance(key, str) and key.startswith("x-")):
                errors.append(f"{at}.{key}: unknown field")
        if "class" not in entry:
            errors.append(f"{at}: class is required")
        for key in ("class", "lens"):
            if key in entry and not absolute_uri(entry[key]):
                errors.append(f"{at}.{key}: expected an absolute URI")
        if "description" in entry and not isinstance(entry["description"], str):
            errors.append(f"{at}.description: expected a string")
        subject = entry.get("class")
        if isinstance(subject, str):
            if subject in seen:
                errors.append(f"{at}.class: {subject} appears twice")
            seen.add(subject)
    return errors


def _resource_maps(document):
    """(location, crudResources map) pairs present in the document."""
    found = []
    components = document.get("components")
    if isinstance(components, dict) and isinstance(components.get("crudResources"), dict):
        found.append(("components.crudResources", components["crudResources"]))
    if isinstance(document.get("x-crudResources"), dict):
        found.append(("x-crudResources", document["x-crudResources"]))
    return found


def _misplaced(node, path, allowed, errors):
    """Rule 1: report every `x-produces` key that is not on a Resource Object."""
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else str(key)
            if key == FIELD and id(node) not in allowed:
                errors.append(f"{here}: x-produces is allowed only on a CRUD Resource Object")
            _misplaced(value, here, allowed, errors)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _misplaced(value, f"{path}[{index}]", allowed, errors)


def validate(document):
    if not isinstance(document, dict):
        raise ValueError("document: expected an object")
    errors = []
    allowed = set()
    for location, resources in _resource_maps(document):
        for name, resource in resources.items():
            if isinstance(resource, dict):
                allowed.add(id(resource))
                if FIELD in resource:
                    errors += check_list(resource[FIELD], f"{location}.{name}.{FIELD}")
    _misplaced(document, "", allowed, errors)
    if errors:
        raise ValueError("\n".join(errors))


def validate_selection(selection, document):
    """The catalog fallback (§5): `selection["x-produces"]`, if present."""
    if not isinstance(selection, dict) or FIELD not in selection:
        return
    value = selection[FIELD]
    if not isinstance(value, dict) or not value:
        raise ValueError(f"selection.{FIELD}: expected a nonempty object keyed by CRUD resource name")
    names = {name for _, resources in _resource_maps(document) for name in resources}
    errors = []
    for name, entries in value.items():
        if name not in names:
            errors.append(f"selection.{FIELD}.{name}: no such CRUD resource in the document")
        errors += check_list(entries, f"selection.{FIELD}.{name}")
    if errors:
        raise ValueError("\n".join(errors))


def _load(path):
    with open(path, encoding="utf-8") as source:
        if path.endswith(".json"):
            return json.load(source)
        import yaml
        return yaml.safe_load(source)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        validate(_load(name))
        print(f"{name}: x-produces valid")
