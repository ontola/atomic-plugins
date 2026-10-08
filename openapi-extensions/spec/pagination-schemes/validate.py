"""Validate Pagination Schemes 0.4.0 in an OpenAPI document, and resolve links.

`validate(document)` checks every scheme in `components.paginationSchemes`
(or the provisional Swagger 2.0 root `x-paginationSchemes`) and every
operation's `x-pagination` against schema.json (rules 1-4 and 8-10), that each
application names a defined scheme (rule 5), and that a `declared` link base
has the origin of one of each explicitly applying operation's servers (rule
11). Rules 6 and 7 need the response schemas and are not checked. Ordinary
OpenAPI validation is separate.

`resolve_link(...)` is a reference implementation of §4.4.3 and §4.4.4: it
returns the absolute URL to request next, None when there is no next page, or
raises LinkRefused for a link a consumer must not follow. It resolves with its
own implementation of RFC 3986 §5.2 (not urllib's urljoin, which differs on
some inputs), and the string it returns is the one to request.
"""
import copy
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
