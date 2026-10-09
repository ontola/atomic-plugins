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


def _known_absent(value):
    return isinstance(value, str) and value in ABSENT
FIELDS = {"absent", "notFound", "gone", "parentAbsent", "description"}
READ_FIELDS = ("notFound", "gone")  # describe the resource's read: 404 and 410 (§4.3)
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
    if not _known_absent(value.get("absent")):
        errors.append(f"{where}.absent: expected deleted or removed")
    for field in READ_FIELDS:
        if field in value:
            if not isinstance(value[field], str) or value[field] not in OUTCOMES:
                errors.append(f"{where}.{field}: expected deleted or unavailable")
            elif value.get("absent") == "deleted":
                errors.append(f"{where}.{field}: not allowed with absent: deleted")
    if "parentAbsent" in value:
        if not on_collection:
            errors.append(f"{where}.parentAbsent: only on a Collection Object")
        elif value["parentAbsent"] != "unavailable":
            errors.append(f"{where}.parentAbsent: expected unavailable (0.2.0 has no deleted cascade)")
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


def declarations_of(document, resource_name):
    """{collection name: its Completeness Object, from the Collection Object or else its list operation, or None}."""
    resource = _resources(document).get(resource_name) or {}
    found = {}
    for name, collection in (resource.get("collections") or {}).items():
        if not isinstance(collection, dict):
            continue
        declaration = collection.get("x-completeness")
        fixed = any(k in collection for k in ("listMethod", "listQuery", "listBody", "x-list-method", "x-list-query", "x-list-body"))
        if declaration is None and not fixed:  # §4.1: an operation's declaration covers no fixed read
            for item in document.get("paths", {}).values():
                for method in METHODS:
                    operation = item.get(method) if isinstance(item, dict) else None
                    crud = operation.get("x-crud") if isinstance(operation, dict) else None
                    if isinstance(crud, dict) and crud.get("action") == "list" and crud.get("resource") == resource_name \
                            and crud.get("collection") == name and "x-completeness" in operation:
                        declaration = operation["x-completeness"]
        found[name] = declaration if isinstance(declaration, dict) else None
    return found


def validate(document):
    errors = []
    resources = _resources(document)
    for resource_name, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        declared = declarations_of(document, resource_name)
        for field in READ_FIELDS:
            explicit = {d[field] for d in declared.values()
                        if d and field in d and isinstance(d[field], (str, int, float, bool, type(None)))}
            if len(explicit) > 1:
                errors.append(f"crudResources.{resource_name}: collections declare different {field} values {sorted(map(str, explicit))}")
            if explicit:
                defaulted = sorted(n for n, d in declared.items() if d and d.get("absent") == "removed" and field not in d)
                if defaulted:
                    errors.append(f"crudResources.{resource_name}: {defaulted} default {field} while another collection states it")
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
            declarations = declarations_of(document, parent)
            if not any(declarations.values()):
                errors.append(f"{where}.parentAbsent: parent {parent} has no collection with x-completeness")

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


def classify_read(declaration, tombstone, id_field, object_id, status, body, resource_not_found=None,
                  resource_gone=None):
    """§4.3: 'present', 'deleted', 'unavailable' or 'unknown' for one read of an absent object.

    `declaration` is the collection's Completeness Object (or None), `tombstone`
    the resource's x-read-tombstone (or None), `body` the parsed JSON body (or
    None). `resource_not_found` is the notFound any collection of the resource
    states (resource_not_found(document, resource)); it applies to every read
    of the resource's objects, through any collection (§4.3). Since 0.3.0,
    `resource_gone` (resource_read_value(document, resource, "gone")), else
    the declaration's `gone`, classifies a 410; without either, a 410 is
    classified like a 404.
    """
    if status == 410:
        gone = resource_gone if resource_gone is not None else (declaration or {}).get("gone")
        if gone is not None:
            return gone if gone in OUTCOMES else "unavailable"  # §7: an unrecognised value counts as unavailable
    if status in (404, 410):
        stated = (declaration or {}).get("notFound")
        if resource_not_found is not None:
            value = resource_not_found
        elif stated is not None:
            value = stated  # §4.3: notFound describes the resource's read, whatever absent says
        elif declaration is not None and not _known_absent(declaration.get("absent")):
            value = "unavailable"  # §7: an unrecognised absent never yields the deleted default
        else:
            value = "deleted"
        return value if value in OUTCOMES else "unavailable"  # §7: an unrecognised value counts as unavailable
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


def resource_read_value(document, resource_name, field):
    """The notFound or gone any collection of the resource states, or None; it covers every read of its objects (§4.3)."""
    declared = declarations_of(document, resource_name).values()
    values = {d[field] if d[field] in OUTCOMES else "unavailable"
              for d in declared if d and field in d and isinstance(d[field], (str, type(None)))}
    if any(d and field in d and not isinstance(d[field], (str, type(None))) for d in declared):
        values.add("unavailable")
    return values.pop() if len(values) == 1 else ("unavailable" if values else None)


def resource_not_found(document, resource_name):
    """The notFound any collection of the resource states, or None (0.2.0 name, kept)."""
    return resource_read_value(document, resource_name, "notFound")


def members_of_gone_parent(declaration, parent_outcome):
    """§4.4: 'unavailable' for members of a nested collection whose parent is concluded gone.

    `parent_outcome` is 'deleted' or 'unavailable'. None means no conclusion:
    no parentAbsent, or the parent is not gone. 0.2.0 has no deleted cascade,
    and an unrecognised parentAbsent value also means unavailable (§7).
    """
    if parent_outcome not in OUTCOMES or not declaration or "parentAbsent" not in declaration:
        return None
    if not _known_absent(declaration.get("absent")):
        return None  # §7: an unrecognised absent means no Completeness Object
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
