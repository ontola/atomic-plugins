"""Validate CRUD Causality 0.4.0 collection reads (rules 2, 4 and 14-18).

`validate(document)` raises ValueError listing every violation it finds and
returns None for a valid document. It checks the Collection Object's
`listMethod`, `listQuery` and `listBody` (§4.2.1) against the document's
operations and their explicit pagination, and the `resource`/`collection`
names of `x-crud` that those checks depend on. The other rules of §8 and
ordinary OpenAPI validation are separate.

`read_request(document, resource, collection, context)` returns the request a
read's first page sends (§4.2.1, steps 1-3), as a reference for consumers.
"""
import copy
import json
import re
import sys
from urllib.parse import quote

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
VARIABLE = re.compile(r"\{([^{}]+)\}")


def _resources(document):
    if "swagger" in document:
        return document.get("x-crudResources", {})
    return document.get("components", {}).get("crudResources", {})


def _schemes(document):
    if "swagger" in document:
        return document.get("x-paginationSchemes", {})
    return document.get("components", {}).get("paginationSchemes", {})


def _resolve(document, value):
    seen = set()
    while isinstance(value, dict) and isinstance(value.get("$ref"), str) and value["$ref"].startswith("#/"):
        reference = value["$ref"]
        if reference in seen:
            return {}
        seen.add(reference)
        node = document
        for token in reference[2:].split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            if not isinstance(node, dict) or token not in node:
                return {}
            node = node[token]
        value = node
    return value


def _merge(base, override):
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _flat_keys(value, prefix=""):
    """Dot-path keys of a nested object's leaves and of every object on the way."""
    keys = set()
    for key, child in value.items():
        path = prefix + key
        keys.add(path)
        if isinstance(child, dict):
            keys |= _flat_keys(child, path + ".")
    return keys


def _paging_fields(document, operation):
    """Query and body fields to which the operation's explicit pagination gives a role other than pageSize."""
    query, body = set(), set()
    schemes = _schemes(document)
    for application in operation.get("x-pagination", []) or []:
        if not isinstance(application, dict) or application.get("scheme") not in schemes:
            continue
        scheme = _merge(schemes[application["scheme"]], application.get("overrides", {}))
        request = scheme.get("request", {})
        for target, location in ((query, "queryParameters"), (body, "bodyFields")):
            for name, field in request.get(location, {}).items():
                if isinstance(field, dict) and field.get("role") != "pageSize":
                    target.add(name)
    return query, body


def validate(document):
    errors = []
    resources = _resources(document)
    paths = document.get("paths", {})

    for resource_name, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        for name, collection in (resource.get("collections") or {}).items():
            if not isinstance(collection, dict):
                continue
            where = f"crudResources.{resource_name}.collections.{name}"
            reads = {"listMethod", "listQuery", "listBody"} & set(collection)
            if not reads:
                continue
            template = collection.get("urlTemplate")
            if not isinstance(template, str):
                errors.append(f"{where}: {', '.join(sorted(reads))} need a urlTemplate")
                continue
            method = collection.get("listMethod", "GET")
            if method not in ("GET", "POST"):
                errors.append(f"{where}.listMethod: expected GET or POST")
                continue
            item = paths.get(template)
            operation = item.get(method.lower()) if isinstance(item, dict) else None
            if not isinstance(operation, dict):
                errors.append(f"{where}: no operation at paths[{template!r}].{method.lower()}")
                continue
            paging_query, paging_body = _paging_fields(document, operation)

            if "listQuery" in collection:
                query = collection["listQuery"]
                if not isinstance(query, dict) or not query:
                    errors.append(f"{where}.listQuery: expected a nonempty object")
                else:
                    parameters = [_resolve(document, p) for p in item.get("parameters", []) + operation.get("parameters", [])]
                    declared = {p.get("name") for p in parameters if p.get("in") == "query"}
                    path_variables = set(VARIABLE.findall(template))
                    for key, value in query.items():
                        if key in path_variables:
                            errors.append(f"{where}.listQuery.{key}: is a path parameter")
                        elif key not in declared:
                            errors.append(f"{where}.listQuery.{key}: not a query parameter of {method} {template}")
                        if not isinstance(value, str):
                            errors.append(f"{where}.listQuery.{key}: value must be a string")
                        if key in paging_query:
                            errors.append(f"{where}.listQuery.{key}: owned by the operation's pagination scheme")

            if "listBody" in collection:
                body = collection["listBody"]
                if not isinstance(body, dict):
                    errors.append(f"{where}.listBody: expected an object")
                elif method != "POST":
                    errors.append(f"{where}.listBody: only with listMethod POST")
                else:
                    if "swagger" in document:
                        has_body = any(_resolve(document, p).get("in") == "body"
                                       for p in item.get("parameters", []) + operation.get("parameters", []))
                    else:
                        has_body = "requestBody" in operation
                    if not has_body:
                        errors.append(f"{where}.listBody: {method} {template} declares no request body")
                    for key in sorted(_flat_keys(body) & paging_body):
                        errors.append(f"{where}.listBody.{key}: owned by the operation's pagination scheme")

    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        for method in METHODS:
            operation = item.get(method)
            crud = operation.get("x-crud") if isinstance(operation, dict) else None
            if not isinstance(crud, dict):
                continue
            where = f"paths.{path}.{method}.x-crud"
            resource = resources.get(crud.get("resource"))
            if not isinstance(resource, dict):
                errors.append(f"{where}.resource: {crud.get('resource')!r} is not a crudResources key")
                continue
            if crud.get("action") != "list":
                continue
            collection = (resource.get("collections") or {}).get(crud.get("collection"))
            if not isinstance(collection, dict):
                errors.append(f"{where}.collection: {crud.get('collection')!r} is not a collection of {crud['resource']}")
                continue
            if not {"listMethod", "listQuery", "listBody"} & set(collection):
                continue  # rule 15 covers only collections that define their reads (0.4.0)
            template = collection.get("urlTemplate")
            expected = str(collection.get("listMethod", "GET")).lower()
            if isinstance(template, str) and (template != path or expected != method):
                errors.append(f"{where}: collection {crud['collection']} is read at {expected.upper()} {template}")
    if errors:
        raise ValueError("\n".join(errors))


def read_request(document, resource, collection, context):
    """(method, path with query, JSON body or None) of a read's first page, before pagination fields."""
    definition = _resources(document)[resource]["collections"][collection]
    path = VARIABLE.sub(lambda m: quote(str(context[m.group(1)]), safe=""), definition["urlTemplate"])
    query = definition.get("listQuery", {})
    if query:
        path += "?" + "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in query.items())
    method = definition.get("listMethod", "GET")
    body = copy.deepcopy(definition.get("listBody")) if method == "POST" else None
    return method, path, body


def _load(path):
    with open(path, encoding="utf-8") as source:
        if path.endswith(".json"):
            return json.load(source)
        import yaml
        return yaml.safe_load(source)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        validate(_load(name))
        print(f"{name}: collection reads valid")
