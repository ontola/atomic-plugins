"""Validate Produced Classes 0.1.0-draft (`x-produces`) in an OpenAPI document.

`validate(document)` checks rules 1-6 of README §7 and raises ValueError
listing every violation. It fetches no class or lens IRI. Ordinary OpenAPI
validation is separate.
"""
import json
import re
import sys

FIELD = "x-produces"
KNOWN = {"class", "lens", "description"}
SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:")
FORBIDDEN = re.compile(r"[\s\x00-\x1f\x7f<>\"{}|\\^`]")


# Keys whose values are data (examples, defaults, enumerations), not
# document structure, and keys whose own keys are schema property names.
DATA_KEYS = {"example", "examples", "default", "enum", "const"}
NAME_MAPS = {"properties", "patternProperties"}


def absolute_uri(value):
    """An absolute IRI (RFC 3987; every absolute URI is one): a scheme,
    something after it, no whitespace or control characters. Non-ASCII
    characters are allowed."""
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


def same_subject(value):
    """The comparison form of README §3: scheme and host lower-cased."""
    scheme, rest = value.split(":", 1)
    if rest.startswith("//"):
        end = len(rest)
        for stop in "/?#":
            found = rest.find(stop, 2)
            if found != -1:
                end = min(end, found)
        authority = rest[2:end]
        userinfo, at, host = authority.rpartition("@")
        rest = "//" + userinfo + at + host.lower() + rest[end:]
    return scheme.lower() + ":" + rest


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
                errors.append(f"{at}.{key}: expected an absolute IRI")
        if "description" in entry and not isinstance(entry["description"], str):
            errors.append(f"{at}.description: expected a string")
        subject = entry.get("class")
        if isinstance(subject, str) and absolute_uri(subject):
            key = same_subject(subject)
            if key in seen:
                errors.append(f"{at}.class: {subject} appears twice")
            seen.add(key)
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


def _misplaced(node, path, allowed, errors, names=False, parent=None):
    """Rule 1: report every `x-produces` key that is not on a Resource Object.

    Data values (DATA_KEYS) are not searched, except a Responses Object's
    `default`, which is a Response Object; the keys of a NAME_MAPS object
    are property names, not fields, so they are never reported.
    """
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else str(key)
            if key == FIELD and not names and id(node) not in allowed:
                errors.append(f"{here}: x-produces is allowed only on a CRUD Resource Object")
            if not names and key in DATA_KEYS and not (key == "default" and parent == "responses"):
                continue
            _misplaced(
                value,
                here,
                allowed,
                errors,
                names=not names and key in NAME_MAPS,
                parent=None if names else key,
            )
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
