"""Validate Pagination Schemes 0.6.0 in an OpenAPI document, resolve links, read short-page lists and range windows.

`validate(document)` checks every scheme in `components.paginationSchemes`
(or the provisional Swagger 2.0 root `x-paginationSchemes`) and every
operation's `x-pagination` against schema.json (rules 1-4, 8-10, 12-16, 19 and 20),
that each application names a defined scheme (rule 5), that a `declared` link
base has the origin of one of each explicitly applying operation's servers
(rule 11), that a `rangeWindow` scheme has exactly one way of carrying its
window (rule 14), is applied alone (rule 17) and names parameters the
operation has (rule 18), and that a Short Page Object has the request fields
it needs (rules 21 and 22). Rules 6 and 7 need the response schemas and are
not checked. Ordinary OpenAPI validation is separate.

`read_pages(...)` is a reference implementation of a page-number read with
`start` and a Short Page Object (§4.4.5).

`read_range(...)` is a reference implementation of §4.6.3 and §4.6.4: it reads
one range through a caller-supplied request function, halving full windows,
and returns the items of a complete read or raises WindowReadError.

`resolve_link(...)` is a reference implementation of §4.4.3 and §4.4.4: it
returns the absolute URL to request next, None when there is no next page, or
raises LinkRefused for a link a consumer must not follow. It resolves with its
own implementation of RFC 3986 §5.2 (not urllib's urljoin, which differs on
some inputs), and the string it returns is the one to request.
"""
import copy
import datetime
import json
import pathlib
import re
import sys
from jsonschema import Draft202012Validator

SCHEMA = json.loads((pathlib.Path(__file__).parent / "schema.json").read_text(encoding="utf-8"))
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
LINK_ROLES = ("nextLink", "previousLink")
DEFAULT_PORTS = {"http": 80, "https": 443}
# Rule 2 of §4.4.3: whitespace, control characters, backslashes and anything outside ASCII.
UNFOLLOWABLE = re.compile(r"[\s\x00-\x1f\x7f\\]|[^\x00-\x7f]")
# Rule 2 of §4.4.3: a scheme not followed by "//", three or more leading slashes, an empty authority.
SCHEME_PREFIX = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:")
# RFC 3986 Appendix B.
URI_PARTS = re.compile(r"^(?:([^:/?#]+):)?(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$")
AUTHORITY = re.compile(r"^(?:(?P<userinfo>[^@]*)@)?(?P<host>\[[^\]]*\]|[^:]*)(?::(?P<port>[0-9]*))?$")


WINDOW_ROLES = ("windowStart", "windowEnd", "windowRange")
FIELD_LOCATIONS = {"queryParameters": "query", "bodyFields": None, "headerFields": "header"}


class WindowReadError(RuntimeError):
    """A windowed read that is not complete (§4.6.4 rule 4)."""


class LinkRefused(ValueError):
    """A next or previous link that §4.4.3 or §4.4.4 forbids following."""


def _validator(definition):
    schema = dict(SCHEMA)
    schema.pop("$ref", None)
    schema["$ref"] = "#/$defs/" + definition
    return Draft202012Validator(schema)


SCHEME_VALIDATOR = _validator("scheme")
APPLICATION_VALIDATOR = _validator("application")


def merge(base, override):
    """Deep-merge `override` onto a copy of `base` (§5)."""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def pagination_schemes(document):
    if "swagger" in document:
        return document.get("x-paginationSchemes", {})
    return document.get("components", {}).get("paginationSchemes", {})


def operations(document):
    for path, item in document.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method in METHODS:
            operation = item.get(method)
            if isinstance(operation, dict):
                yield path, method, item, operation


def server_urls(document, item, operation):
    """The server URLs an operation may be sent to, as written (variables unsubstituted)."""
    if "swagger" in document:
        host = document.get("host")
        if not host:
            return []
        base_path = document.get("basePath", "")
        schemes = operation.get("schemes") or document.get("schemes") or []
        return [f"{scheme}://{host}{base_path}" for scheme in schemes]
    for source in (operation, item, document):
        servers = source.get("servers")
        if servers:
            return [server.get("url", "") for server in servers if isinstance(server, dict)]
    return ["/"]


def origin(url):
    """(scheme, host, port) of an absolute http(s) URL; None when not statically known.

    Hosts compare as ASCII-lowercased strings, so a Unicode host and its
    punycode form differ: such a mismatch fails closed.
    """
    scheme, authority, _, _, _ = _split(url)
    scheme = (scheme or "").lower()
    if scheme not in DEFAULT_PORTS or not authority or "{" in authority:
        return None
    parts = AUTHORITY.match(authority)
    if not parts or not parts.group("host"):
        return None
    port = parts.group("port")
    port = int(port) if port else DEFAULT_PORTS[scheme]
    return (scheme, parts.group("host").lower(), port)


def _errors(validator, value, location):
    return [
        f"{location}{''.join('.' + str(p) for p in error.absolute_path)}: {error.message}"
        for error in sorted(validator.iter_errors(value), key=lambda e: list(e.absolute_path))
    ]


def _link_fields(scheme):
    response = scheme.get("response", {})
    for location in ("bodyFields", "headers"):
        for name, field in response.get(location, {}).items():
            if isinstance(field, dict) and "linkResolution" in field:
                yield f"response.{location}.{name}", field["linkResolution"]


def _declared_url_problem(url):
    """Rule 10 beyond the schema's pattern: an absolute http(s) URL, no userinfo or fragment."""
    if origin(url) is None:
        return "url must be an absolute http or https URL"
    if "@" in _split(url)[1]:
        return "url must not contain userinfo"
    if "#" in url:
        return "url must not contain a fragment"
    return None


def window_fields(scheme):
    """[(location, name, role)] of a scheme's request fields with a window role."""
    found = []
    for location in FIELD_LOCATIONS:
        for name, field in scheme.get("request", {}).get(location, {}).items():
            if isinstance(field, dict) and field.get("role") in WINDOW_ROLES:
                found.append((location, name, field["role"]))
    return found


def _window_carrier_problem(scheme):
    """Rule 14: one windowRange field, or one windowStart and one windowEnd field."""
    roles = sorted(role for _, _, role in window_fields(scheme))
    if roles in (["windowRange"], ["windowEnd", "windowStart"]):
        return None
    return (
        "a rangeWindow request needs one windowRange field, or one windowStart and one windowEnd field;"
        f" found {roles}"
    )


def _deref(document, value):
    """Follow local $refs (#/a/b); None when one does not resolve."""
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


def operation_parameters(document, item, operation):
    """{(in, name)} of an operation's own and its path item's parameters; header names lower-cased."""
    found = set()
    for source in (item, operation):
        for parameter in source.get("parameters", []) or []:
            parameter = _deref(document, parameter)
            if isinstance(parameter, dict) and isinstance(parameter.get("name"), str) and "in" in parameter:
                name = parameter["name"].lower() if parameter["in"] == "header" else parameter["name"]
                found.add((parameter["in"], name))
    return found


def validate(document):
    """Raise ValueError listing every violation found; return None when valid."""
    errors = []
    schemes = pagination_schemes(document)
    root = "x-paginationSchemes" if "swagger" in document else "components.paginationSchemes"
    if not isinstance(schemes, dict):
        raise ValueError(f"{root}: expected an object")
    for name, scheme in schemes.items():
        location = f"{root}.{name}"
        found = _errors(SCHEME_VALIDATOR, scheme, location)
        errors += found
        if not found and scheme.get("type") == "rangeWindow":
            problem = _window_carrier_problem(scheme)
            if problem:
                errors.append(f"{location}.request: {problem}")
        if not found:
            for field, resolution in _link_fields(scheme):
                if resolution.get("base") == "declared":
                    problem = _declared_url_problem(resolution["url"])
                    if problem:
                        errors.append(f"{location}.{field}.linkResolution: {problem}")

    for path, method, item, operation in operations(document):
        applications = operation.get("x-pagination")
        if applications is None:
            continue
        location = f"paths.{path}.{method}.x-pagination"
        if not isinstance(applications, list):
            errors.append(f"{location}: expected an array")
            continue
        def merged_type(application):
            """The type after overrides (§5), so an override cannot hide a rangeWindow."""
            if not isinstance(application, dict):
                return None
            overrides = application.get("overrides")
            if isinstance(overrides, dict) and "type" in overrides:
                return overrides["type"]
            scheme = schemes.get(application.get("scheme"))
            return scheme.get("type") if isinstance(scheme, dict) else None

        windowed = [a for a in applications if merged_type(a) == "rangeWindow"]
        if windowed and len(applications) != 1:
            # Rule 17.
            errors.append(f"{location}: an operation that applies a rangeWindow scheme applies no other scheme")
        for index, application in enumerate(applications):
            where = f"{location}[{index}]"
            found = _errors(APPLICATION_VALIDATOR, application, where)
            errors += found
            if found:
                continue
            if application["scheme"] not in schemes:
                errors.append(f"{where}.scheme: {application['scheme']!r} is not defined in {root}")
                continue
            merged = merge(schemes[application["scheme"]], application.get("overrides", {}))
            found = _errors(SCHEME_VALIDATOR, merged, where + "(merged)")
            errors += found
            if found:
                continue
            errors += [f"{where}(merged).{problem}" for problem in _short_page_problems(merged, applied=True)]
            if merged.get("type") == "rangeWindow":
                problem = _window_carrier_problem(merged)
                if problem:
                    errors.append(f"{where}(merged).request: {problem}")
                known = operation_parameters(document, item, operation)
                for field_location, name, _ in window_fields(merged):
                    kind = FIELD_LOCATIONS[field_location]
                    key = name.lower() if kind == "header" else name
                    # Rule 18.
                    if kind and (kind, key) not in known:
                        errors.append(
                            f"{where}.request.{field_location}.{name}: the operation has no {kind} parameter {name!r}"
                        )
            for field, resolution in _link_fields(merged):
                if resolution.get("base") != "declared":
                    continue
                declared = origin(resolution["url"])
                if declared is None:
                    errors.append(f"{where}.{field}.linkResolution: url must be an absolute http or https URL")
                    continue
                servers = server_urls(document, item, operation)
                known = [origin(server) for server in servers if origin(server) is not None]
                # Rule 11: one of the operation's servers; a server without a static origin is a runtime check.
                if known and len(known) == len(servers) and declared not in known:
                    errors.append(
                        f"{where}.{field}.linkResolution.url: origin {declared} differs from every server {servers!r}"
                    )
    if errors:
        raise ValueError("\n".join(errors))


def resolve_link(value, *, request_url, server_url, resolution=None):
    """Resolve one nextLink/previousLink value under §4.4.3 and check it under §4.4.4.

    `request_url` is the request that returned the value and `server_url` the
    server it was sent to (variables substituted), both provider-side and
    absolute. `resolution` is the field's Link Resolution Object, or None.
    """
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise LinkRefused("link is not a string")
    if UNFOLLOWABLE.search(value):
        raise LinkRefused("link contains whitespace, a control character, a backslash or a non-ASCII character")
    scheme = SCHEME_PREFIX.match(value)
    rest = value[scheme.end():] if scheme else value
    if scheme and not rest.startswith("//"):
        raise LinkRefused("link has a scheme not followed by //")
    if rest.startswith("///"):
        raise LinkRefused("link starts with three or more slashes")
    if rest.startswith("//") and rest[2:3] in ("", "/", "?", "#"):
        raise LinkRefused("link has an empty authority")
    base_kind = (resolution or {}).get("base", "request")
    if base_kind == "request":
        base = request_url
    elif base_kind == "server":
        base = server_url if _split(server_url)[2].endswith("/") else server_url + "/"
    elif base_kind == "declared":
        base = resolution["url"]
    else:
        raise ValueError(f"unknown linkResolution base {base_kind!r}")
    if "#" in value:
        raise LinkRefused("link contains a fragment")
    resolved = rfc3986_resolve(base, value)
    authority = _split(resolved)[1]
    if authority is None or "@" in authority:
        raise LinkRefused("link has no authority or contains userinfo")
    allowed = origin(server_url)
    if allowed is None:
        raise ValueError(f"server URL {server_url!r} is not an absolute http or https URL")
    if origin(resolved) != allowed:
        raise LinkRefused(f"link {resolved!r} leaves the server origin {allowed}")
    # §4.4.4 rule 4: this exact string is what a consumer requests.
    return resolved


def _to_number(bound, window):
    """A bound in the window's format as an integer number of units (§4.6.2)."""
    if not isinstance(bound, str):
        raise ValueError(f"bound {bound!r} is not a string")
    form = window["format"]
    if form == "date" and re.fullmatch(r"\d{4}-\d{2}-\d{2}", bound):
        return datetime.date.fromisoformat(bound).toordinal()
    if form == "basicDate" and re.fullmatch(r"\d{8}", bound):
        return datetime.date(int(bound[:4]), int(bound[4:6]), int(bound[6:])).toordinal()
    if form == "dateTime" and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", bound):
        moment = datetime.datetime.strptime(bound, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        return int(moment.timestamp())
    if form in ("unixSeconds", "integer") and re.fullmatch(r"-?(0|[1-9]\d*)", bound) and bound != "-0":
        return int(bound)
    raise ValueError(f"bound {bound!r} is not in the format {form!r}")


def _to_bound(number, window):
    """The inverse of _to_number."""
    form = window["format"]
    if form == "date":
        return datetime.date.fromordinal(number).isoformat()
    if form == "basicDate":
        return datetime.date.fromordinal(number).strftime("%Y%m%d")
    if form == "dateTime":
        return datetime.datetime.fromtimestamp(number, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(number)


def _width(first, last, window):
    return last - first + 1 if window["bounds"] == "closed" else last - first


def window_request(scheme, start, end):
    """{(location, name): value} for one window; start and end in the window's format."""
    values = {}
    for location, name, role in window_fields(scheme):
        if role == "windowStart":
            values[(location, name)] = start
        elif role == "windowEnd":
            values[(location, name)] = end
        else:
            template = scheme["request"][location][name]["template"]
            values[(location, name)] = template.replace("{start}", start).replace("{end}", end)
    return values


def halves(start, end, window):
    """The default split of §4.6.3 step 3 as two (start, end) pairs; None when the window is too narrow."""
    first, last = _to_number(start, window), _to_number(end, window)
    width = _width(first, last, window)
    if width < 2 * window.get("minimumWidth", 1):
        return None
    middle = first + (width + 1) // 2  # the first unit of the second window
    head_end = middle - 1 if window["bounds"] == "closed" else middle
    return (start, _to_bound(head_end, window)), (_to_bound(middle, window), end)


def _role_fields(scheme, role):
    """[(location, name)] of a scheme's request fields with this role."""
    return [
        (location, name)
        for location in FIELD_LOCATIONS
        for name, field in scheme.get("request", {}).get(location, {}).items()
        if isinstance(field, dict) and field.get("role") == role
    ]


def _short_page_problems(scheme, applied):
    """Rules 21 and 22 (22 only for a scheme applied to an operation)."""
    short = scheme.get("response", {}).get("shortPage")
    if not isinstance(short, dict):
        return []
    problems = []
    if short.get("size") == "request" and not _role_fields(scheme, "pageSize"):
        problems.append("response.shortPage.size: 'request' needs a request field with role pageSize (rule 21)")
    if applied and len(_role_fields(scheme, "page")) != 1:
        problems.append("response.shortPage: needs exactly one request field with role page (rule 22)")
    return problems


class PageReadError(RuntimeError):
    """A page-number read that ended with an error (§4.4.5 step 3)."""


def _items(body, scheme):
    path = scheme.get("response", {}).get("envelope", {}).get("itemsField")
    value = body
    if path:
        for segment in path.split("."):
            value = value.get(segment) if isinstance(value, dict) else None
    if not isinstance(value, list):
        raise PageReadError("the response holds no item array")
    return value


def _role_value(body, scheme, role):
    """The value of the response body field with this role, or None (top-level and dot-paths)."""
    for name, field in scheme.get("response", {}).get("bodyFields", {}).items():
        if isinstance(field, dict) and field.get("role") == role:
            value = body
            for segment in name.split("."):
                value = value.get(segment) if isinstance(value, dict) else None
            return value
    return None


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def read_pages(scheme, request, *, page_size=None, maximum=None, identity=lambda item: item["id"], max_pages=None):
    """A page-number read with `start` and a Short Page Object (§4.3.1, §4.4.5).

    `request(values)` sends one page, with `values` mapping (location, name)
    of the `page` field (and the `pageSize` field, when `page_size` is given)
    to their values, and returns the response body. `maximum` is the
    documented maximum of the pageSize parameter; a `page_size` above it is
    refused. A body field with the `totalPages` role (a count: the last page
    is `start + totalPages - 1`) or the `totalCount` role ends the read on a
    full page, and a `pageSize` role field reports the size applied.

    Returns {"items", "pages", "complete"}. "complete" is True for a read
    ended by `totalPages` or `totalCount`, and for one ended by a short page
    only when the assurance is `documented`. Raises PageReadError for a page
    with more than the full size, a page holding an item an earlier page
    returned, a short page that `totalPages` or `totalCount` contradicts
    under `documented`, or `max_pages` pages requested without reaching the
    end; such a read is not complete.
    """
    short = scheme["response"]["shortPage"]
    page_fields = _role_fields(scheme, "page")
    if len(page_fields) != 1:
        raise ValueError("a shortPage scheme has exactly one page field (rule 22)")
    [page_field] = page_fields
    location, name = page_field
    first = scheme["request"][location][name].get("start", 1)
    if short["size"] == "request" and page_size is None:
        raise ValueError("size 'request' needs the page size the client sends")
    if page_size is not None and maximum is not None and page_size > maximum:
        raise ValueError(f"page size {page_size} is above the documented maximum {maximum}")
    # The full size: size, or the page size sent when it is smaller (or size is "request").
    size_fields = _role_fields(scheme, "pageSize") if page_size is not None else []
    # The full size: size, or the page size sent when it is smaller. A page
    # size is only sent through a pageSize field; without one it changes nothing.
    size = page_size if short["size"] == "request" else (
        min(short["size"], page_size) if size_fields else short["size"])
    items, seen, pages = [], set(), 0
    number = first
    while True:
        if max_pages is not None and pages >= max_pages:
            raise PageReadError(f"requested {max_pages} pages without reaching the end; the read is not complete")
        values = {page_field: number}
        values.update({field: page_size for field in size_fields})
        body = request(values)
        page = _items(body, scheme)
        pages += 1
        reported = _count(_role_value(body, scheme, "pageSize"))
        full = reported if reported else size
        if len(page) > full:
            raise PageReadError(f"page {number} holds {len(page)} items, more than the declared {full}")
        ids = [identity(item) for item in page]
        if any(i in seen for i in ids):
            raise PageReadError(f"page {number} holds an item an earlier page returned")
        seen.update(ids)
        items.extend(page)
        total_pages = _count(_role_value(body, scheme, "totalPages"))
        total_count = _count(_role_value(body, scheme, "totalCount"))
        last = first + total_pages - 1 if total_pages is not None else None
        ended = (last is not None and number >= last) or (total_count is not None and len(items) >= total_count)
        more = (last is not None and number < last) or (total_count is not None and len(items) < total_count)
        if len(page) < full:
            if more:
                if short["assurance"] == "documented":
                    raise PageReadError(f"page {number} is short, but the response says more pages follow")
                return {"items": items, "pages": pages, "complete": False}
            return {"items": items, "pages": pages, "complete": ended or short["assurance"] == "documented"}
        if ended:
            return {"items": items, "pages": pages, "complete": True}
        number += 1


def read_range(scheme, start, end, request, *, identity=lambda item: item["id"], max_requests=None):
    """Read the range from start to end of a rangeWindow scheme under §4.6.3 and §4.6.4.

    `request(values)` makes one window request, with `values` as
    window_request returns them, and returns the located item array; it
    raises for a non-2xx answer, which ends the read. Returns a dict with
    "items" (one per identity, the later answer winning), "windows" (the
    windows whose answers were complete for them, in range order) and
    "requests". Raises WindowReadError when the read is not complete.
    """
    window = scheme["window"]
    if _width(_to_number(start, window), _to_number(end, window), window) < 1:
        raise ValueError("the range is empty")
    items, windows, count = {}, [], 0
    pending = [(start, end)]
    while pending:
        low, high = pending.pop(0)
        if max_requests is not None and count >= max_requests:
            raise WindowReadError(f"stopped after {max_requests} requests; the read is not complete")
        count += 1
        answer = request(window_request(scheme, low, high))
        if len(answer) < window["cap"]:
            for item in answer:
                items[identity(item)] = item
            windows.append((low, high))
            continue
        split = halves(low, high, window)
        if split is None:
            raise WindowReadError(
                f"the window {low}..{high} answered {len(answer)} items, at least the cap,"
                " and cannot be split; the read is not complete"
            )
        pending[:0] = list(split)
    return {"items": list(items.values()), "windows": windows, "requests": count}


def _split(uri):
    """(scheme, authority, path, query, fragment) by RFC 3986 Appendix B; absent parts are None."""
    match = URI_PARTS.match(uri)
    scheme, authority, path, query, fragment = match.groups()
    return scheme, authority, path or "", query, fragment


def remove_dot_segments(path):
    """RFC 3986 §5.2.4."""
    output = []
    while path:
        if path.startswith("../"):
            path = path[3:]
        elif path.startswith("./"):
            path = path[2:]
        elif path.startswith("/./"):
            path = path[2:]
        elif path == "/.":
            path = "/"
        elif path.startswith("/../"):
            path = path[3:]
            if output:
                output.pop()
        elif path == "/..":
            path = "/"
            if output:
                output.pop()
        elif path in (".", ".."):
            path = ""
        else:
            start = 1 if path.startswith("/") else 0
            end = path.find("/", start)
            end = len(path) if end == -1 else end
            output.append(path[:end])
            path = path[end:]
    return "".join(output)


def rfc3986_resolve(base, reference):
    """RFC 3986 §5.2.2 (strict) and §5.3, without a fragment."""
    b_scheme, b_authority, b_path, b_query, _ = _split(base)
    r_scheme, r_authority, r_path, r_query, _ = _split(reference)
    if r_scheme is not None:
        scheme, authority, path, query = r_scheme, r_authority, remove_dot_segments(r_path), r_query
    else:
        scheme = b_scheme
        if r_authority is not None:
            authority, path, query = r_authority, remove_dot_segments(r_path), r_query
        else:
            authority = b_authority
            if r_path == "":
                path = b_path
                query = r_query if r_query is not None else b_query
            else:
                if r_path.startswith("/"):
                    path = remove_dot_segments(r_path)
                elif b_authority is not None and b_path == "":
                    path = remove_dot_segments("/" + r_path)
                else:
                    path = remove_dot_segments(b_path[: b_path.rfind("/") + 1] + r_path)
                query = r_query
    result = f"{scheme}:" if scheme is not None else ""
    if authority is not None:
        result += "//" + authority
    result += path
    if query is not None:
        result += "?" + query
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
        validate(_load(name))
        print(f"{name}: pagination schemes valid")
