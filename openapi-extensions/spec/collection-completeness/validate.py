"""Validate Collection Completeness 0.2.0-draft declarations, and classify reads.

`validate(document)` raises ValueError listing every violation of the document
rules of §7 that the document alone can show; it returns None when there is
none. It cannot check the evidence rules (a `deleted` value needs provider
documentation).

`classify_read(...)` (§4.3) and `members_of_gone_parent(...)` (§4.4) are
reference implementations for consumers.
"""
import json
import re
import sys

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
ABSENT = {"deleted", "removed"}
OUTCOMES = {"deleted", "unavailable"}
FIELDS = {"absent", "notFound", "parentAbsent", "description"}
VARIABLE = re.compile(r"\{([^{}]+)\}")


def _resources(document):
    if "swagger" in document:
        return document.get("x-crudResources", {})
    return document.get("components", {}).get("crudResources", {})


def _object(value, where, errors, on_collection):
    if not isinstance(value, dict):
        errors.append(f"{where}: expected an object")
        return
    unknown = {k for k in value if k not in FIELDS and not k.startswith("x-")}
    if unknown:
        errors.append(f"{where}: unknown fields {sorted(unknown)}")
    if value.get("absent") not in ABSENT:
        errors.append(f"{where}.absent: expected deleted or removed")
    if "notFound" in value:
        if value["notFound"] not in OUTCOMES:
            errors.append(f"{where}.notFound: expected deleted or unavailable")
        elif value.get("absent") == "deleted":
            errors.append(f"{where}.notFound: not allowed with absent: deleted")
    if "parentAbsent" in value:
        if not on_collection:
            errors.append(f"{where}.parentAbsent: only on a Collection Object")
        elif value["parentAbsent"] not in OUTCOMES:
            errors.append(f"{where}.parentAbsent: expected deleted or unavailable")
    if "description" in value and not isinstance(value["description"], str):
        errors.append(f"{where}.description: expected a string")



def parents(document, resource_name, collection):
    """Parent resources of a collection: {path variable: [other resources whose identity binds it]}."""
    variables = set(VARIABLE.findall(collection.get("urlTemplate", "")))
    found = {}
    for name, resource in _resources(document).items():
        if name == resource_name or not isinstance(resource, dict):
            continue
        bindings = (resource.get("identity") or {}).get("bindings") or {}
        for variable in sorted(variables & set(bindings)):
            found.setdefault(variable, []).append(name)
    return found


def validate(document):
    errors = []
    resources = _resources(document)
    for resource_name, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        for name, collection in (resource.get("collections") or {}).items():
            if not isinstance(collection, dict) or "x-completeness" not in collection:
                continue
            where = f"crudResources.{resource_name}.collections.{name}.x-completeness"
            declaration = collection["x-completeness"]
            _object(declaration, where, errors, on_collection=True)
            if not isinstance(declaration, dict) or "parentAbsent" not in declaration:
                continue
            found = parents(document, resource_name, collection)
            candidates = sorted({parent for names in found.values() for parent in names})
            if not candidates:
                errors.append(f"{where}.parentAbsent: the collection is not nested (§4.4)")
                continue
            if len(candidates) > 1:
                errors.append(f"{where}.parentAbsent: more than one parent resource {candidates} (§4.4)")
                continue
            parent = candidates[0]
            declarations = [c["x-completeness"] for c in (resources[parent].get("collections") or {}).values()
                            if isinstance(c, dict) and isinstance(c.get("x-completeness"), dict)]
            if not declarations:
                errors.append(f"{where}.parentAbsent: parent {parent} has no collection with x-completeness")
            elif declaration.get("parentAbsent") == "deleted" and not all("notFound" in d for d in declarations):
                errors.append(f"{where}.parentAbsent: deleted needs an explicit notFound on every collection of {parent}")
    for path, item in document.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method in METHODS:
            operation = item.get(method)
            if isinstance(operation, dict) and "x-completeness" in operation:
                _object(operation["x-completeness"], f"paths.{path}.{method}.x-completeness", errors, on_collection=False)
    if errors:
        raise ValueError("\n".join(errors))


def _field(value, path):
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return None, False
        value = value[key]
    return value, True


def _same(a, b):
    return type(a) is type(b) and a == b


def classify_read(declaration, tombstone, id_field, object_id, status, body):
    """§4.3: 'present', 'deleted', 'unavailable' or 'unknown' for one read of an absent object.

    `declaration` is the collection's Completeness Object (or None), `tombstone`
    the resource's x-read-tombstone (or None), `body` the parsed JSON body (or None).
    """
    if status in (404, 410):
        return (declaration or {}).get("notFound", "deleted")
    if not isinstance(status, int) or not 200 <= status < 300:
        return "unknown"
    identifier, found = _field(body, id_field)
    if not found or identifier is None or str(identifier) != str(object_id):
        return "unknown"
    if tombstone:
        value, found = _field(body, tombstone["field"])
        if found and any(_same(value, v) for v in tombstone["values"]):
            return "deleted"
    return "present"


def members_of_gone_parent(declaration, parent_outcome):
    """§4.4: the outcome for members of a nested collection whose parent is 'deleted' or 'unavailable'.

    None means no conclusion: the declaration has no parentAbsent, or the parent is not gone.
    """
    if parent_outcome not in OUTCOMES or not declaration or "parentAbsent" not in declaration:
        return None
    if declaration["parentAbsent"] == "deleted" and parent_outcome == "deleted":
        return "deleted"
    return "unavailable"


def _load(path):
    with open(path, encoding="utf-8") as source:
        if path.endswith(".json"):
            return json.load(source)
        import yaml
        return yaml.safe_load(source)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        validate(_load(name))
        print(f"{name}: completeness declarations valid")
