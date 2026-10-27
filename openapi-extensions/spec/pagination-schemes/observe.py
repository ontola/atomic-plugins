"""Pagination Schemes 0.11.0: derive per-response evidence, never a freshness proof.

No HTTP client or persistence. See §4.7 for the contract and implementation
limits. The caller supplies the effective scheme (after overrides), parsed
response, exact request values and references to archived evidence.
"""
import copy
import datetime
from jsonschema import FormatChecker

from validate import (SCHEME_VALIDATOR, _validator, _errors, _guarantee_problems,
                      _item_cursor_problems, _item_cursor_fields, _order_key,
                      _in_order, _present_role_value, _ABSENT, _to_number,
                      _window_carrier_problem, window_request, page_items,
                      response_incomplete, PageReadError)

CONTEXT_VALIDATOR = _validator("observationContext").evolve(format_checker=FormatChecker())


class CoverageError(ValueError):
    """Evidence contradicts the declared contract; no assertion is emitted."""


def _time(value):
    try:
        moment = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if moment.tzinfo is None or "T" not in value:
            raise ValueError()
        return moment
    except (ValueError, TypeError):
        raise CoverageError("observed timestamps must be timezone-aware ISO date-times") from None


def _validate_context(context):
    errors = _errors(CONTEXT_VALIDATOR, context, "context")
    if errors:
        raise CoverageError("\n".join(errors))
    if _time(context["observed"]["startedAt"]) > _time(context["observed"]["endedAt"]):
        raise CoverageError("observed.startedAt is after endedAt")


def _path(body, path):
    value = body
    for name in path.split("."):
        if not isinstance(value, dict) or name not in value:
            return _ABSENT
        value = value[name]
    return value


def _response_value(locator, body, headers):
    if locator["location"] == "bodyFields":
        return _path(body, locator["name"])
    values = [v for k, v in headers.items() if k.lower() == locator["name"].lower()]
    if len(values) > 1:
        raise CoverageError("duplicate case-insensitive evidence header")
    return values[0] if values else _ABSENT


def _request_value(locator, request):
    location, name = locator["location"], locator["name"]
    if location != "headerFields":
        return request.get((location, name), _ABSENT)
    values = [v for (loc, key), v in request.items()
              if loc == location and key.lower() == name.lower()]
    if len(values) > 1:
        raise CoverageError("duplicate case-insensitive request header")
    return values[0] if values else _ABSENT


def _pointer(path):
    return "/" + "/".join(p.replace("~", "~0").replace("/", "~1") for p in path.split("."))


def _key(value):
    key = _order_key(value)
    if value is _ABSENT or value == "" or key is None:
        raise CoverageError("a coverage key must be a nonempty string or nonnegative integer, never a float/bool")
    return key


def _bound(value, inclusive):
    return {"value": value, "inclusive": inclusive}


def _same_scope(a, b):
    return all(a[k] == b[k] for k in ("documentRevision", "overlayRevisions", "scope"))


def observe_page(scheme, request, body, *, context, headers=None, status=200,
                 window=None, previous=None):
    """Return four independent contracts plus provenance for one response.

    request maps (queryParameters|bodyFields|headerFields, name) to decoded
    values, not wire encodings. window, when given, is the actual (start,end)
    pair in window.format, checked against every declared window carrier.
    previous is the preceding assertion in this logical read, so a promised
    read snapshot is checked across pages. It is not an aggregate snapshot.
    No wall-clock freshness or permanent cursor-retirement decision is inferred.
    """
    errors = _errors(SCHEME_VALIDATOR, scheme, "scheme")
    if not errors:
        errors += _item_cursor_problems(scheme) + _guarantee_problems(scheme)
        if scheme.get("type") == "rangeWindow":
            problem = _window_carrier_problem(scheme)
            if problem:
                errors.append(problem)
    if errors:
        raise CoverageError("\n".join(errors))
    _validate_context(context)
    if type(status) is not int or not 200 <= status < 300:
        raise CoverageError("a non-2xx response establishes no coverage")
    if response_incomplete(scheme, body):
        raise CoverageError("an incomplete response establishes no coverage")
    if previous is not None:
        _validate_context(previous["provenance"])
        if not _same_scope(context, previous["provenance"]) or context["read"] != previous["provenance"]["read"]:
            raise CoverageError("previous observation has another scope, revision or logical read")
        if _time(context["observed"]["startedAt"]) < _time(previous["provenance"]["observed"]["endedAt"]):
            raise CoverageError("previous observation is not a preceding sequential request")
        if previous["freshness"] != scheme.get("freshness", {"mode": "unknown"}):
            raise CoverageError("freshness contract changed within a logical read")
    headers = headers or {}
    consistency = {"mode": scheme.get("consistency", {}).get("mode", "unknown")}
    if previous is not None and previous["consistency"]["mode"] != consistency["mode"]:
        raise CoverageError("consistency contract changed within a logical read")
    if consistency["mode"] == "readSnapshot":
        locators = scheme["consistency"]["snapshot"]
        token = _response_value(locators["response"], body, headers)
        if not isinstance(token, str) or token == "":
            raise CoverageError("missing or invalid read snapshot token")
        sent = _request_value(locators["request"], request)
        if sent is not _ABSENT and sent != token:
            raise CoverageError("response snapshot differs from requested snapshot")
        if previous is not None:
            expected = previous["consistency"]["snapshot"]
            if token != expected or sent != expected:
                raise CoverageError("read snapshot changed or was not carried to the next request")
        consistency["snapshot"] = token
        consistency["requestBound"] = sent is not _ABSENT
    result = {"specVersion": "0.11.0", "coverage": None,
              "freshness": copy.deepcopy(scheme.get("freshness", {"mode": "unknown"})),
              "consistency": consistency, "closedPrefix": None,
              "provenance": copy.deepcopy(context)}
    declaration = scheme.get("coverage")
    if declaration is None:
        return result
    try:
        items = page_items(body, scheme)
    except PageReadError as exc:
        raise CoverageError(str(exc)) from exc
    if declaration["basis"] == "rangeWindow":
        if window is None or len(window) != 2:
            raise CoverageError("rangeWindow observation needs the actual requested window")
        model = scheme["window"]
        low, high = window
        try:
            a, b = _to_number(low, model), _to_number(high, model)
            if b < a or (model["bounds"] == "halfOpen" and a == b):
                raise ValueError("empty or inverted window")
            for key, value in window_request(scheme, low, high).items():
                if _request_value({"location": key[0], "name": key[1]}, request) != value:
                    raise ValueError("window does not match the request carriers")
        except (ValueError, TypeError) as exc:
            raise CoverageError(str(exc)) from exc
        # A full answer may be truncated. Even when empty, only a below-cap
        # answer can assert the whole requested window (§4.6.4).
        if len(items) >= model["cap"]:
            return result
        for item in items:
            value = item
            for part in model["field"][1:].split("/"):
                name = part.replace("~1", "/").replace("~0", "~")
                if isinstance(value, dict) and name in value:
                    value = value[name]
                else:
                    raise CoverageError("window field is absent; array traversal is unsupported by this reference observer")
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                raise CoverageError("window item field is not comparable in window.format")
            try:
                number = _to_number(str(value), model)
            except ValueError as exc:
                raise CoverageError("reference observer requires item values in window.format; no rounding") from exc
            if number < a or number > b or (number == b and model["bounds"] == "halfOpen"):
                raise CoverageError("item lies outside the requested window")
        result["coverage"] = {"field": model["field"], "comparison": copy.deepcopy(model),
                              "lower": _bound(low, True), "upper": _bound(high, model["bounds"] == "closed")}
        return result
    [(location, name, path)] = _item_cursor_fields(scheme)
    order = scheme["request"][location][name]["order"]
    cursor = _request_value({"location": location, "name": name}, request)
    for other_location in ("queryParameters", "bodyFields", "headerFields"):
        for other_name, field in scheme.get("request", {}).get(other_location, {}).items():
            if field.get("role") in ("pageToken", "cursor", "previousPageToken") and (other_location, other_name) != (location, name):
                if _request_value({"location": other_location, "name": other_name}, request) is not _ABSENT:
                    raise CoverageError("an item-cursor read must not send another cursor field")
    if previous is not None:
        traversal = previous.get("traversal", {})
        if traversal.get("terminal") is not False or cursor is _ABSENT:
            raise CoverageError("cannot continue a terminal page or omit the preceding last-item cursor")
        if traversal.get("order") != order or traversal.get("field") != _pointer(path):
            raise CoverageError("cursor strategy changed within the logical read")
        if _key(cursor) != _key(traversal.get("lastItem")):
            raise CoverageError("request cursor is not the preceding last item")
    last_key = _key(cursor) if cursor is not _ABSENT else None
    keys = []
    for item in items:
        value = _path(item, path)
        key = _key(value)
        if last_key is not None and not _in_order(last_key, key, order):
            raise CoverageError("item violates the cursor bound or unique declared order")
        keys.append(value)
        last_key = key
    more = _present_role_value(body, scheme, "hasMore")
    if more is not _ABSENT and type(more) is not bool:
        raise CoverageError("hasMore is not a boolean")
    if not items and more is True:
        raise CoverageError("an empty page says hasMore true")
    terminal = more is False or not items
    result["traversal"] = {"field": _pointer(path), "order": order, "terminal": terminal,
                           "lastItem": keys[-1] if keys else None}
    start = _bound(cursor, False) if cursor is not _ABSENT else (
        None if declaration.get("initial", "unknown") == "unbounded" else (
            _bound(keys[0], True) if keys else _ABSENT))
    end = None if terminal and declaration.get("terminal", "unknown") == "exhaustive" else (
        _bound(keys[-1], True) if keys else _ABSENT)
    # Empty+unknown terminal supplies no last key; don't invent an interval.
    if start is not _ABSENT and end is not _ABSENT:
        low, high = (start, end) if order == "ascending" else (end, start)
        result["coverage"] = {"field": _pointer(path), "comparison": "itemCursor",
                              "lower": low, "upper": high}
    prefix = scheme.get("closedPrefix")
    if prefix:
        boundary = (keys[-1] if keys else _ABSENT) if prefix["source"] == "lastItem" else _response_value(prefix["value"], body, headers)
        if boundary is _ABSENT and prefix["source"] == "response":
            raise CoverageError("closed-prefix watermark is missing")
        if boundary is not _ABSENT:
            key = _key(boundary)
            if last_key is not None and key[0] != last_key[0]:
                raise CoverageError("closed-prefix watermark uses a different comparison domain")
            result["closedPrefix"] = {"field": _pointer(path), "direction": order,
                                      "through": boundary, "inclusive": True}
    return result


def collect_observations(observations):
    """Retain evidence separately; identify a common snapshot only with proof.

    This does not fill gaps, merge intervals, infer field completeness or
    declare an authoritative collection state. Snapshot IDs compare only
    inside one logical read with the same revision/selection/auth scope.
    """
    if not observations:
        raise CoverageError("no observations")
    first = observations[0]
    for current in observations:
        _validate_context(current["provenance"])
        if current.get("specVersion") != "0.11.0" or not _same_scope(first["provenance"], current["provenance"]):
            raise CoverageError("cannot compose observations with different scope or specification revisions")
    same_read = len({o["provenance"]["read"] for o in observations}) == 1
    snapshots = [o["consistency"].get("snapshot") for o in observations]
    all_pinned = all(o["consistency"]["mode"] == "readSnapshot" for o in observations)
    if same_read and all_pinned and any(s != snapshots[0] for s in snapshots):
        raise CoverageError("contradictory snapshots in the same logical read")
    if same_read and all_pinned and any(not o["consistency"].get("requestBound") for o in observations[1:]):
        raise CoverageError("a subsequent snapshot observation did not request its pinned snapshot")
    same_snapshot = same_read and all_pinned and all(s == snapshots[0] for s in snapshots)
    return {"singleSnapshot": same_snapshot,
            "observations": copy.deepcopy(observations)}
