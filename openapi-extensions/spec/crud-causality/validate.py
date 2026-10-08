"""Validate CRUD Causality 0.5.0 collection reads and compound creates (rules 2, 4, 14-19 and 20-24).

`validate(document)` raises ValueError listing every violation it finds and
returns None for a valid document. It checks the Collection Object's
`listMethod`, `listQuery` and `listBody` (§4.2.1) against the document's
operations and their explicit pagination, and the `resource`/`collection`
names of `x-crud` that those checks depend on. The other rules of §8 and
ordinary OpenAPI validation are separate.

`read_request(document, resource, collection, context)` returns the request a
read's first page sends (§4.2.1, steps 1-3), as a reference for consumers.
`compound_create(crud, planned, send_create, send_follow_up, context)` makes a
compound create as §4.7.2 says, and `validate` checks its `followUps`.
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


STANDARD = ("listMethod", "listQuery", "listBody")
LEGACY = {"listMethod": "x-list-method", "listQuery": "x-list-query", "listBody": "x-list-body"}
SEGMENT = re.compile(r'\["((?:[^"\\]|\\.)*)"\]|([^.\[\]]+)')


def defines_read(collection):
    """§4.2.1: a standard field or an x-list-* form; the read a consumer makes."""
    return any(field in collection or LEGACY[field] in collection for field in STANDARD)


def declares_standard(collection):
    """Rules 14-18 apply to collections with a standard field only."""
    return any(field in collection for field in STANDARD)


def as_text(value):
    """syncables' asText: a string as is, null as '', anything else as JSON."""
    if isinstance(value, str):
        return value
    return "" if value is None else json.dumps(value)


def effective(collection):
    """(method, query, body, legacy fields used) after the field-by-field x-list-* fallback (§4.2.1)."""
    used = []
    if "listMethod" in collection:
        method = collection["listMethod"]
    elif "x-list-method" in collection:
        method = str(collection["x-list-method"]).upper()
        used.append("x-list-method")
    else:
        method = "GET"
    if "listQuery" in collection:
        query = collection["listQuery"]
    elif "x-list-query" in collection:
        raw = collection["x-list-query"]
        query = {k: as_text(v) for k, v in raw.items()} if isinstance(raw, dict) else raw
        used.append("x-list-query")
    else:
        query = None
    if "listBody" in collection:
        body = collection["listBody"]
    elif "x-list-body" in collection:
        body = collection["x-list-body"]
        used.append("x-list-body")
    else:
        body = None
    return method, query, body, used


def dot_path(key):
    """A dot-path as a tuple of segments; a segment holding a '.' is written ["a.b"]."""
    segments, position = [], 0
    while position < len(key):
        match = SEGMENT.match(key, position)
        if not match:
            return (key,)
        segments.append(match.group(1).replace('\\"', '"') if match.group(1) is not None else match.group(2))
        position = match.end()
        if position < len(key):
            if key[position] != ".":
                return (key,)
            position += 1
    return tuple(segments)


def _body_paths(value, prefix=()):
    """Every path in a nested object: objects on the way and leaves."""
    paths = set()
    for key, child in value.items():
        path = prefix + (key,)
        paths.add(path)
        if isinstance(child, dict):
            paths |= _body_paths(child, path)
    return paths


def _leaves(value, prefix=()):
    leaves = set()
    for key, child in value.items():
        path = prefix + (key,)
        if isinstance(child, dict) and child:
            leaves |= _leaves(child, path)
        else:
            leaves.add(path)
    return leaves


def _paging_fields(document, operation):
    """Query names and body paths to which the operation's explicit pagination gives a role other than pageSize."""
    query, body = set(), set()
    schemes = _schemes(document)
    for application in operation.get("x-pagination", []) or []:
        if not isinstance(application, dict) or application.get("scheme") not in schemes:
            continue
        scheme = _merge(schemes[application["scheme"]], application.get("overrides", {}))
        request = scheme.get("request", {})
        for name, field in request.get("queryParameters", {}).items():
            if isinstance(field, dict) and field.get("role") != "pageSize":
                query.add(name)
        for name, field in request.get("bodyFields", {}).items():
            if isinstance(field, dict) and field.get("role") != "pageSize":
                body.add(dot_path(name))
    return query, body


def _body_conflicts(body, paging):
    """listBody paths that set, or sit on the way to, a paging body field."""
    conflicts = set()
    every = _body_paths(body)
    leaves = _leaves(body)
    for field in paging:
        if field in every:
            conflicts.add(field)  # the field itself, or an object in its place
        for leaf in leaves:
            if field[: len(leaf)] == leaf and len(leaf) < len(field):
                conflicts.add(leaf)  # a scalar where the field's parent object must be
    return conflicts


def _json_request_body(document, item, operation):
    if "swagger" in document:
        return any(_resolve(document, p).get("in") == "body"
                   for p in item.get("parameters", []) + operation.get("parameters", []))
    body = _resolve(document, operation.get("requestBody", {}))
    content = body.get("content", {}) if isinstance(body, dict) else {}
    return any(media == "application/json" or media.endswith("+json") for media in content)


def validate(document, warnings=None):
    """Raise ValueError for violations of rules 2, 4, 14-18 and 20-24; append rule 19 to `warnings`.

    Rules 14-18 apply to the standard fields only. The x-list-* forms are a
    consumer fallback (§4.2.1) and are not checked, so a 0.3.0 document that
    uses them stays valid.
    """
    errors = []
    warnings = warnings if warnings is not None else []
    resources = _resources(document)
    paths = document.get("paths", {})

    for resource_name, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        for name, collection in (resource.get("collections") or {}).items():
            if not isinstance(collection, dict) or not declares_standard(collection):
                continue
            where = f"crudResources.{resource_name}.collections.{name}"
            for field in STANDARD:
                if field in collection and LEGACY[field] in collection:
                    warnings.append(f"{where}: carries both {field} and {LEGACY[field]} (rule 19, SHOULD NOT)")
            template = collection.get("urlTemplate")
            if not isinstance(template, str):
                errors.append(f"{where}: a collection that defines its read needs a urlTemplate")
                continue
            method, query, body, used = effective(collection)
            # A field that falls back to its x-list-* form is a consumer fallback, not checked here.
            query = None if "x-list-query" in used else query
            body = None if "x-list-body" in used else body
            if method not in ("GET", "POST"):
                errors.append(f"{where}.listMethod: expected GET or POST")
                continue
            item = paths.get(template)
            operation = item.get(method.lower()) if isinstance(item, dict) else None
            if not isinstance(operation, dict):
                errors.append(f"{where}: no operation at paths[{template!r}].{method.lower()}")
                continue
            paging_query, paging_body = _paging_fields(document, operation)

            if query is not None:
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

            if body is not None:
                if not isinstance(body, dict):
                    errors.append(f"{where}.listBody: expected an object")
                elif method != "POST":
                    errors.append(f"{where}.listBody: only with listMethod POST")
                else:
                    if not _json_request_body(document, item, operation):
                        errors.append(f"{where}.listBody: {method} {template} declares no JSON request body")
                    for path in sorted(_body_conflicts(body, paging_body)):
                        errors.append(f"{where}.listBody.{'.'.join(path)}: owned by the operation's pagination scheme")

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
            errors += _follow_up_errors(document, crud, where, item, operation)
            if crud.get("action") != "list":
                continue
            collection = (resource.get("collections") or {}).get(crud.get("collection"))
            if not isinstance(collection, dict):
                errors.append(f"{where}.collection: {crud.get('collection')!r} is not a collection of {crud['resource']}")
                continue
            if not declares_standard(collection):
                continue  # rule 15 covers only collections with a standard field
            template = collection.get("urlTemplate")
            expected = str(effective(collection)[0]).lower()
            if isinstance(template, str) and (template != path or expected != method):
                errors.append(f"{where}: collection {crud['collection']} is read at {expected.upper()} {template}")
    if errors:
        raise ValueError("\n".join(errors))


FOLLOW_UP_FIELDS = {"field", "create", "itemKey", "operation", "bind", "description"}
BIND_FROM = ("created", "planned", "missing")


def _well_formed_path(value):
    """A nonempty dot-path whose every segment is a name or a bracketed name."""
    if not isinstance(value, str) or not value:
        return False
    position = 0
    while True:
        match = SEGMENT.match(value, position)
        if not match or match.end() == position:
            return False
        position = match.end()
        if position == len(value):
            return True
        if value[position] != "." or position + 1 == len(value):
            return False
        position += 1


def _operation_by_id(document, operation_id):
    found = []
    for path, item in (document.get("paths") or {}).items():
        if not isinstance(item, dict):
            continue
        for method in METHODS:
            operation = item.get(method)
            if isinstance(operation, dict) and operation.get("operationId") == operation_id:
                found.append((path, method, item, operation))
    return found


def _parameters(document, item, operation):
    found = {}
    for source in (item, operation):
        for raw in source.get("parameters") or []:
            parameter = _resolve(document, raw)
            if isinstance(parameter, dict) and "name" in parameter and "in" in parameter:
                found[(parameter["in"], parameter["name"])] = parameter
    return found


def _follow_up_errors(document, crud, where, create_item, create_operation):
    """Rules 20-24 for one x-crud."""
    if "followUps" not in crud:
        return []
    if crud.get("action") != "create":
        return [f"{where}.followUps: allowed only on action create (rule 20)"]
    follow_ups = crud["followUps"]
    if not isinstance(follow_ups, list) or not follow_ups:
        return [f"{where}.followUps: expected a nonempty array (rule 20)"]
    errors = []
    create_path = {name for (kind, name) in _parameters(document, create_item, create_operation) if kind == "path"}
    for index, follow_up in enumerate(follow_ups):
        at = f"{where}.followUps[{index}]"
        if not isinstance(follow_up, dict):
            errors.append(f"{at}: expected an object")
            continue
        errors += [f"{at}.{key}: unknown member" for key in follow_up
                   if key not in FOLLOW_UP_FIELDS and not key.startswith("x-")]
        for key in ("field", "operation", "bind"):
            if key not in follow_up:
                errors.append(f"{at}: {key} is required (rule 21)")
        if follow_up.get("create") not in ("include", "omit"):
            errors.append(f"{at}.create: expected include or omit (rule 21)")
        for key in ("field", "itemKey"):
            if key in follow_up and not _well_formed_path(follow_up[key]):
                errors.append(f"{at}.{key}: expected a dot-path (rule 21)")
        targets = _operation_by_id(document, follow_up.get("operation"))
        if len(targets) != 1:
            errors.append(f"{at}.operation: {follow_up.get('operation')!r} names {len(targets)} operations, not one (rule 22)")
            continue
        _, _, item, operation = targets[0]
        target_crud = operation.get("x-crud")
        if not isinstance(target_crud, dict) or target_crud.get("action") != "update" \
                or target_crud.get("resource") != crud.get("resource"):
            errors.append(f"{at}.operation: {follow_up['operation']!r} is not an update of {crud.get('resource')!r} (rule 22)")
        bind = follow_up.get("bind")
        if not isinstance(bind, dict):
            errors.append(f"{at}.bind: expected an object (rule 23)")
            continue
        parameters = _parameters(document, item, operation)
        body_keys = [key for key in bind if key == "body" or key.startswith("body.")]
        if body_keys and not _json_request_body(document, item, operation):
            errors.append(f"{at}.bind: {follow_up['operation']!r} declares no JSON request body (rule 23)")
        if "body" in bind and len(body_keys) > 1:
            errors.append(f"{at}.bind: body excludes body.<field> keys (rule 23)")
        for key, source in bind.items():
            kind, _, name = key.partition(".")
            if kind == "body":
                if key != "body" and not _well_formed_path(name):
                    errors.append(f"{at}.bind.{key}: expected body.<dot-path> (rule 23)")
            elif kind in ("path", "query", "header") and name:
                if (kind, name) not in parameters:
                    errors.append(f"{at}.bind.{key}: {follow_up['operation']!r} has no {kind} parameter {name!r} (rule 23)")
            else:
                errors.append(f"{at}.bind.{key}: expected body, body.<dot-path>, path.<name>, query.<name> or header.<name> (rule 23)")
            if not isinstance(source, dict) or source.get("from") not in BIND_FROM \
                    or not _well_formed_path(source.get("field")):
                errors.append(f"{at}.bind.{key}: expected {{from: created|planned|missing, field: <dot-path>}} (rule 23)")
            elif source["from"] == "missing" and source["field"] != follow_up.get("field"):
                errors.append(f"{at}.bind.{key}: from missing needs the follow-up's own field (rule 23)")
        for (kind, name), parameter in parameters.items():
            if kind == "path" and f"path.{name}" not in bind and name not in create_path:
                errors.append(f"{at}.bind: path parameter {name!r} is neither bound nor carried from the create (rule 24)")
    return errors


MISSING = object()


def get_path(value, path):
    """The value at a dot-path, or MISSING."""
    for segment in dot_path(path):
        if not isinstance(value, dict) or segment not in value:
            return MISSING
        value = value[segment]
    return value


def _set_path(target, path, value):
    segments = dot_path(path)
    for segment in segments[:-1]:
        target = target.setdefault(segment, {})
    target[segments[-1]] = value


def _drop_path(target, path):
    segments = dot_path(path)
    for segment in segments[:-1]:
        target = target.get(segment)
        if not isinstance(target, dict):
            return
    target.pop(segments[-1], None)


def missing_value(follow_up, planned, created):
    """§4.7.2 step 4: the part of the planned value the create did not apply, or MISSING for none."""
    wanted = get_path(planned, follow_up["field"])
    if wanted is MISSING:
        return MISSING
    if follow_up["create"] == "omit" or created is None:
        return wanted
    shown = get_path(created, follow_up["field"])
    if isinstance(wanted, list):
        shown = shown if isinstance(shown, list) else []
        key = follow_up.get("itemKey")
        values = [get_path(item, key) if key and isinstance(item, dict) else item for item in shown]
        rest = [item for item in wanted if item not in values]
        return rest if rest else MISSING
    return MISSING if shown == wanted else wanted


def follow_up_request(follow_up, planned, created, missing, context):
    """The follow-up request filled by `bind`: {"path", "query", "header", "body"}."""
    request = {"path": dict(context or {}), "query": {}, "header": {}, "body": None}
    for key, source in follow_up["bind"].items():
        if source["from"] == "missing":
            value = missing
        else:
            value = get_path(created if source["from"] == "created" else planned, source["field"])
        kind, _, name = key.partition(".")
        if kind == "body":
            if key == "body":
                request["body"] = value
            else:
                request["body"] = request["body"] if isinstance(request["body"], dict) else {}
                _set_path(request["body"], name, value)
        else:
            request[kind][name] = value
    return request


def compound_create(crud, planned, send_create, send_follow_up, context=None):
    """A reference implementation of §4.7.2.

    `send_create(body)` returns ("ok", created object), ("refused", None) or
    ("unknown", None). `send_follow_up(operation_id, request)` returns "ok",
    "refused" or "unknown". `context` holds the create request's path
    parameters, carried to follow-ups that do not bind them. Returns
    {"state": "refused" | "uncertain" | "applied" | "partlyApplied",
    "created": the created object or None, "pending": [(operation_id,
    request)] still to send as updates of the bound object}.
    """
    follow_ups = crud.get("followUps", [])
    body = copy.deepcopy(planned)
    for follow_up in follow_ups:
        if follow_up["create"] == "omit":
            _drop_path(body, follow_up["field"])
    outcome, created = send_create(body)
    if outcome == "refused":
        return {"state": "refused", "created": None, "pending": []}
    if outcome != "ok":
        return {"state": "uncertain", "created": None, "pending": []}
    pending, failed = [], False
    for follow_up in follow_ups:
        missing = missing_value(follow_up, planned, created)
        if missing is MISSING:
            continue
        request = follow_up_request(follow_up, planned, created, missing, context)
        if failed:
            pending.append((follow_up["operation"], request))
            continue
        if send_follow_up(follow_up["operation"], request) != "ok":
            failed = True
            pending.append((follow_up["operation"], request))
    return {"state": "partlyApplied" if failed else "applied", "created": created, "pending": pending}


def read_request(document, resource, collection, context):
    """(method, path with query, JSON body or None) of a read's first page, before pagination fields."""
    definition = _resources(document)[resource]["collections"][collection]
    path = VARIABLE.sub(lambda m: quote(str(context[m.group(1)]), safe=""), definition["urlTemplate"])
    method, query, body, _ = effective(definition)
    if query:
        path += "?" + "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in query.items())
    body = copy.deepcopy(body) if method == "POST" else None
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
        print(f"{name}: collection reads and compound creates valid")
