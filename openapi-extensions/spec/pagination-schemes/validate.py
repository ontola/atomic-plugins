"""Validate Pagination Schemes 0.4.0 in an OpenAPI document, and resolve links.

`validate(document)` checks every scheme in `components.paginationSchemes`
(or the provisional Swagger 2.0 root `x-paginationSchemes`) and every
operation's `x-pagination` against schema.json (rules 1-4 and 8-10), that each
application names a defined scheme (rule 5), and that a `declared` link base
has the origin of each operation's server (rule 11). Rules 6 and 7 need the
response schemas and are not checked. Ordinary OpenAPI validation is separate.

`resolve_link(...)` is a reference implementation of §4.4.3 and §4.4.4: it
returns the absolute URL to request next, None when there is no next page, or
raises LinkRefused for a link a consumer must not follow.
"""
import copy
import json
import pathlib
import re
import sys
from urllib.parse import urljoin, urlsplit

from jsonschema import Draft202012Validator

SCHEMA = json.loads((pathlib.Path(__file__).parent / "schema.json").read_text(encoding="utf-8"))
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
LINK_ROLES = ("nextLink", "previousLink")
DEFAULT_PORTS = {"http": 80, "https": 443}
# Rule 2 of §4.4.3: whitespace, ASCII control characters and backslashes.
UNFOLLOWABLE = re.compile(r"[\s\x00-\x1f\x7f\\]")


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
    """(scheme, host, port) of an absolute http(s) URL; None when not statically known."""
    parts = urlsplit(url)
    if parts.scheme not in DEFAULT_PORTS or not parts.netloc or "{" in parts.scheme + parts.netloc:
        return None
    try:
        port = parts.port or DEFAULT_PORTS[parts.scheme]
    except ValueError:
        return None
    return (parts.scheme, (parts.hostname or "").lower(), port)


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
    parts = urlsplit(url)
    if origin(url) is None:
        return "url must be an absolute http or https URL"
    if "@" in parts.netloc:
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
                for server in server_urls(document, item, operation):
                    expected = origin(server)
                    if expected is not None and expected != declared:
                        errors.append(
                            f"{where}.{field}.linkResolution.url: origin {declared} differs from server {server!r}"
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
        raise LinkRefused("link contains whitespace, a control character or a backslash")
    base_kind = (resolution or {}).get("base", "request")
    if base_kind == "request":
        base = request_url
    elif base_kind == "server":
        base = server_url if urlsplit(server_url).path.endswith("/") else server_url + "/"
    elif base_kind == "declared":
        base = resolution["url"]
    else:
        raise ValueError(f"unknown linkResolution base {base_kind!r}")
    resolved = urljoin(base, value)
    parts = urlsplit(resolved)
    if "@" in parts.netloc:
        raise LinkRefused("link contains userinfo")
    if "#" in value or "#" in resolved:  # urljoin drops an empty fragment ("/next#")
        raise LinkRefused("link contains a fragment")
    allowed = origin(server_url)
    if allowed is None:
        raise ValueError(f"server URL {server_url!r} is not an absolute http or https URL")
    if origin(resolved) != allowed:
        raise LinkRefused(f"link {resolved!r} leaves the server origin {allowed}")
    return resolved


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
