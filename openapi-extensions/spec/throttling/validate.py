"""Validate x-throttling structure (0.2.0-draft) and classify responses.

`validate(document)` checks the structural rules; ordinary OpenAPI validation
is separate. `classify(...)` is a reference implementation of signal matching,
the earliest retry time and the classification rule.
"""
import datetime
import email.utils
import json
import re
import sys
from urllib.parse import urlparse

DIMENSIONS = {"sourceIp", "user", "session", "application", "credential", "account", "operation"}
METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
ROLES = {"limit", "remaining", "used", "reset", "retryAfter"}
TIMED_ROLES = {"reset", "retryAfter"}
UNITS = {"epochSeconds", "deltaSeconds", "httpDate", "deltaSecondsOrHttpDate"}
MEANINGS = {"throttled", "quotaExhausted"}
HEADER_OPERATORS = {"equals", "in", "present"}
BODY_OPERATORS = {"equals", "in", "contains", "present", "item"}
DIGITS = re.compile(r"[0-9]+")
POINTER = re.compile(r"(/([^~/]|~[01])*)*")


def require(condition, message):
    if not condition:
        raise ValueError(message)

def strings(value, label):
    require(isinstance(value, list) and all(isinstance(v, str) and v for v in value), f"{label}: expected string array")
    require(len(value) == len(set(value)), f"{label}: duplicate entries")

def positive(value, label):
    require(type(value) is int and value > 0, f"{label}: expected positive integer")

def scalar(value):
    return value is None or isinstance(value, (str, bool, int, float))


def validate(document):
    root = document.get("x-throttling")
    limits = {}
    if root is not None:
        require(isinstance(root, dict), "root: expected object")
        require(set(root) <= {"limits", "applies", "headers", "signals"}, "root: unknown field")
        require(set(root) & {"limits", "headers", "signals"}, "root: expected limits, headers or signals")
        require(("limits" in root) == ("applies" in root), "root: limits and applies go together")
        if "limits" in root:
            limits = root["limits"]
            require(isinstance(limits, dict) and limits, "limits: expected nonempty object")
            for name, limit in limits.items():
                validate_limit(name, limit)
            selection(root["applies"], limits, "root.applies")
        if "headers" in root:
            validate_headers(root["headers"])
        if "signals" in root:
            signals = root["signals"]
            require(isinstance(signals, list) and signals, "signals: expected nonempty array")
            for index, signal in enumerate(signals):
                validate_signal(signal, limits, f"signals[{index}]")
    for path, item in document.get("paths", {}).items():
        for method, operation in item.items():
            if method in METHODS and isinstance(operation, dict) and "x-throttling" in operation:
                require(root is not None and "limits" in root, "operation selection requires root definitions")
                selection(operation["x-throttling"], limits, f"{method} {path}")

def validate_limit(name, limit):
    require(isinstance(name, str) and name, "empty bucket identifier")
    require(isinstance(limit, dict) and "window" in limit, f"{name}: window required")
    require(set(limit) <= {"requests", "window", "partitionBy", "description"}, f"{name}: unknown field")
    if "requests" in limit:
        positive(limit["requests"], f"{name}.requests")
    if "description" in limit:
        require(isinstance(limit["description"], str), f"{name}.description: expected string")
    window = limit["window"]
    require(isinstance(window, dict) and {"seconds", "kind"} <= set(window) <= {"seconds", "kind", "anchor"}, f"{name}.window: invalid fields")
    positive(window["seconds"], f"{name}.window.seconds")
    require(window["kind"] in ("fixed", "sliding", "unspecified"), f"{name}: invalid window kind")
    if "anchor" in window:
        anchor = window["anchor"]
        require(window["kind"] == "fixed", f"{name}: anchor only valid for fixed windows")
        require(isinstance(anchor, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", anchor), f"{name}: anchor must be RFC3339 timestamp")
        datetime.datetime.fromisoformat(anchor.replace("Z", "+00:00"))
    if "partitionBy" in limit:
        strings(limit["partitionBy"], f"{name}.partitionBy")
        for dimension in limit["partitionBy"]:
            uri = urlparse(dimension)
            require(dimension in DIMENSIONS or (uri.scheme and (uri.path or uri.netloc)), f"{name}: unknown non-URI dimension")

def validate_headers(headers):
    require(isinstance(headers, dict) and headers, "headers: expected nonempty object")
    lowered = [name.lower() for name in headers if isinstance(name, str)]
    require(len(lowered) == len(headers) and all(lowered), "headers: expected nonempty header names")
    require(len(set(lowered)) == len(lowered), "headers: names must be unique case-insensitively")
    roles = []
    for name, header in headers.items():
        label = f"headers.{name}"
        require(isinstance(header, dict) and set(header) <= {"role", "unit", "description"}, f"{label}: unknown field")
        require(header.get("role") in ROLES, f"{label}: unknown role")
        roles.append(header["role"])
        if header["role"] in TIMED_ROLES:
            require(header.get("unit") in UNITS, f"{label}: {header['role']} needs a known unit")
        else:
            require("unit" not in header, f"{label}: unit only for reset and retryAfter")
        if "description" in header:
            require(isinstance(header["description"], str), f"{label}.description: expected string")
    require(len(set(roles)) == len(roles), "headers: each role at most once")

def validate_signal(signal, limits, label):
    require(isinstance(signal, dict), f"{label}: expected object")
    require(set(signal) <= {"status", "header", "body", "meaning", "bucket", "minDelaySeconds", "description"}, f"{label}: unknown field")
    status = signal.get("status")
    require(isinstance(status, list) and status and all(type(s) is int and 100 <= s <= 599 for s in status), f"{label}.status: expected integer statuses 100-599")
    require(len(set(status)) == len(status), f"{label}.status: duplicate entries")
    require(signal.get("meaning") in MEANINGS, f"{label}.meaning: expected throttled or quotaExhausted")
    if "bucket" in signal:
        require(signal["bucket"] in limits, f"{label}.bucket: undefined bucket")
    if "minDelaySeconds" in signal:
        positive(signal["minDelaySeconds"], f"{label}.minDelaySeconds")
    if "description" in signal:
        require(isinstance(signal["description"], str), f"{label}.description: expected string")
    if "header" in signal:
        header_predicate(signal["header"], f"{label}.header")
    if "body" in signal:
        body_predicate(signal["body"], f"{label}.body")

def header_predicate(predicate, label):
    require(isinstance(predicate, dict) and isinstance(predicate.get("name"), str) and predicate["name"], f"{label}: name required")
    operators = set(predicate) - {"name"}
    require(len(operators) == 1 and operators <= HEADER_OPERATORS, f"{label}: exactly one of equals, in, present")
    if "equals" in predicate:
        require(isinstance(predicate["equals"], str), f"{label}.equals: expected string")
    if "in" in predicate:
        strings(predicate["in"], f"{label}.in")
    if "present" in predicate:
        require(predicate["present"] is True, f"{label}.present: expected true")

def body_predicate(predicate, label):
    require(isinstance(predicate, dict) and isinstance(predicate.get("pointer"), str), f"{label}: pointer required")
    require(POINTER.fullmatch(predicate["pointer"]), f"{label}.pointer: invalid JSON Pointer")
    operators = set(predicate) - {"pointer"}
    require(len(operators) == 1 and operators <= BODY_OPERATORS, f"{label}: exactly one of equals, in, contains, present, item")
    if "equals" in predicate:
        require(scalar(predicate["equals"]), f"{label}.equals: expected JSON scalar")
    if "in" in predicate:
        values = predicate["in"]
        require(isinstance(values, list) and values and all(scalar(v) for v in values), f"{label}.in: expected nonempty scalar array")
    if "contains" in predicate:
        require(isinstance(predicate["contains"], str) and predicate["contains"], f"{label}.contains: expected nonempty string")
    if "present" in predicate:
        require(predicate["present"] is True, f"{label}.present: expected true")
    if "item" in predicate:
        body_predicate(predicate["item"], f"{label}.item")

def selection(value, limits, label):
    strings(value, label)
    require(all(name in limits for name in value), f"{label}: undefined bucket")


# --- Reference classification -------------------------------------------------

_MISSING = object()


def resolve_pointer(value, pointer):
    if pointer == "":
        return value
    for token in pointer[1:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict) and token in value:
            value = value[token]
        elif isinstance(value, list) and DIGITS.fullmatch(token) and (token == "0" or not token.startswith("0")) and int(token) < len(value):
            value = value[int(token)]
        else:
            return _MISSING
    return value

def json_equal(a, b):
    # JSON equality: booleans are not numbers, and "0" is not 0.
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b

def body_matches(predicate, body):
    value = resolve_pointer(body, predicate["pointer"])
    if value is _MISSING:
        return False
    if "present" in predicate:
        return True
    if "equals" in predicate:
        return json_equal(value, predicate["equals"])
    if "in" in predicate:
        return any(json_equal(value, v) for v in predicate["in"])
    if "contains" in predicate:
        return isinstance(value, str) and predicate["contains"].lower() in value.lower()
    return isinstance(value, list) and any(body_matches(predicate["item"], element) for element in value)

def header_matches(predicate, headers):
    value = headers.get(predicate["name"].lower())
    if value is None:
        return False
    if "present" in predicate:
        return True
    if "equals" in predicate:
        return value == predicate["equals"]
    return value in predicate["in"]

def parse_time(value, unit, received_at, date_header=None):
    """Seconds since the epoch at which the header's time falls, or None when it does not parse."""
    value = value.strip()
    if unit in ("deltaSeconds", "deltaSecondsOrHttpDate") and DIGITS.fullmatch(value):
        return received_at + int(value)
    if unit == "epochSeconds" and DIGITS.fullmatch(value):
        return _skewed(int(value), received_at, date_header)
    if unit in ("httpDate", "deltaSecondsOrHttpDate"):
        try:
            parsed = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if parsed is None or parsed.tzinfo is None:
            return None
        return _skewed(parsed.timestamp(), received_at, date_header)
    return None

def _skewed(absolute, received_at, date_header):
    """Measure an absolute time against the response's Date header when present."""
    if date_header:
        try:
            server_now = email.utils.parsedate_to_datetime(date_header).timestamp()
            return received_at + (absolute - server_now)
        except (TypeError, ValueError, AttributeError):
            pass
    return absolute

def classify(document, status, headers, body, received_at):
    """Classify one response under the document's x-throttling.

    `headers` maps names (any case) to values; `body` is the parsed JSON body or
    None; `received_at` is epoch seconds. Returns None when the response is not
    throttling (or the document declares no signals and the status is not 429),
    else a dict with `meaning`, `bucket` (or None) and `retryAt` (epoch seconds,
    or None when the consumer's own backoff applies).
    """
    root = document.get("x-throttling") or {}
    headers = {name.lower(): value for name, value in headers.items()}
    matched = None
    for signal in root.get("signals", []):
        if status not in signal["status"]:
            continue
        if "header" in signal and not header_matches(signal["header"], headers):
            continue
        if "body" in signal and (body is None or not body_matches(signal["body"], body)):
            continue
        matched = signal
        break
    if matched is None:
        if status != 429:
            return None
        matched = {"meaning": "throttled"}
    roles = {}
    for name, header in root.get("headers", {}).items():
        if name.lower() in headers:
            roles[header["role"]] = (headers[name.lower()], header.get("unit"))
    date_header = headers.get("date")
    times = []
    if "retryAfter" in roles:
        value, unit = roles["retryAfter"]
        times.append(parse_time(value, unit, received_at, date_header))
    exhausted = matched["meaning"] == "quotaExhausted" or ("remaining" in roles and roles["remaining"][0].strip() == "0")
    if "reset" in roles and exhausted:
        value, unit = roles["reset"]
        times.append(parse_time(value, unit, received_at, date_header))
    times = [t for t in times if t is not None]
    if times:
        retry_at = max(times)
    elif "minDelaySeconds" in matched:
        retry_at = received_at + matched["minDelaySeconds"]
    else:
        retry_at = None
    return {"meaning": matched["meaning"], "bucket": matched.get("bucket"), "retryAt": retry_at}


def _load(path):
    with open(path, encoding="utf-8") as source:
        if path.endswith(".json"):
            return json.load(source)
        import yaml
        return yaml.safe_load(source)

if __name__ == "__main__":
    for name in sys.argv[1:]:
        validate(_load(name))
        print(f"{name}: throttling structure valid")
