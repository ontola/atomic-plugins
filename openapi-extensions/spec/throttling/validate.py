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
        require(set(root) <= {"limits", "applies", "headers", "bodyFields", "signals"}, "root: unknown field")
        require(set(root) & {"limits", "headers", "bodyFields", "signals"}, "root: expected limits, headers, bodyFields or signals")
        require(("limits" in root) == ("applies" in root), "root: limits and applies go together")
        if "limits" in root:
            limits = root["limits"]
            require(isinstance(limits, dict) and limits, "limits: expected nonempty object")
            for name, limit in limits.items():
                validate_limit(name, limit)
            selection(root["applies"], limits, "root.applies")
        if "headers" in root:
            validate_headers(root["headers"])
        if "bodyFields" in root:
            validate_roles(root["bodyFields"], "bodyFields", case_insensitive=False)
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
    validate_roles(headers, "headers", case_insensitive=True)


def validate_roles(headers, where, case_insensitive):
    """A map of header name (or body dot-path) to Header Role Object."""
    require(isinstance(headers, dict) and headers, f"{where}: expected nonempty object")
    names = [name.lower() if case_insensitive else name for name in headers if isinstance(name, str)]
    require(len(names) == len(headers) and all(names), f"{where}: expected nonempty names")
    require(len(set(names)) == len(names), f"{where}: names must be unique" + (" case-insensitively" if case_insensitive else ""))
    roles = []
    for name, header in headers.items():
        label = f"{where}.{name}"
        require(isinstance(header, dict) and set(header) <= {"role", "unit", "description"}, f"{label}: unknown field")
        require(header.get("role") in ROLES, f"{label}: unknown role")
        roles.append(header["role"])
        if header["role"] in TIMED_ROLES:
            require(header.get("unit") in UNITS, f"{label}: {header['role']} needs a known unit")
        else:
            require("unit" not in header, f"{label}: unit only for reset and retryAfter")
        if "description" in header:
            require(isinstance(header["description"], str), f"{label}.description: expected string")
    require(len(set(roles)) == len(roles), f"{where}: each role at most once")

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
        require(predicate["in"], f"{label}.in: expected nonempty array")
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

def single_header(headers, name):
    """The stripped value of one header, None when absent, _REPEATED when it appears more than once."""
    value = headers.get(name.lower())
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            return _REPEATED if value else None
        value = value[0]
    return value.strip()

_REPEATED = object()

def header_matches(predicate, headers):
    value = single_header(headers, predicate["name"])
    if value is None:
        return False
    if "present" in predicate:
        return True
    if value is _REPEATED:
        return False
    if "equals" in predicate:
        return value == predicate["equals"]
    return value in predicate["in"]

def _integer(value):
    """A non-negative decimal integer, or None (also for one too long for int())."""
    if not DIGITS.fullmatch(value):
        return None
    try:
        return int(value)
    except ValueError:
        return None

def _http_date(value):
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:  # an obsolete format without a zone is GMT (RFC 9110 §5.6.7)
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    try:
        return parsed.timestamp()
    except (OverflowError, ValueError):
        return None

def parse_time(value, unit, received_at, date_header=None):
    """Epoch seconds at which the header's time falls, or None when it does not parse."""
    if unit in ("deltaSeconds", "deltaSecondsOrHttpDate"):
        delta = _integer(value)
        if delta is not None:
            return received_at + delta
        if unit == "deltaSeconds":
            return None
    if unit == "epochSeconds":
        absolute = _integer(value)
    elif unit in ("httpDate", "deltaSecondsOrHttpDate"):
        absolute = _http_date(value)
    else:
        absolute = None
    if absolute is None:
        return None
    return _absolute(absolute, received_at, date_header)

def _absolute(absolute, received_at, date_header):
    """The later of the time on the consumer's clock and the same offset from the response's Date header."""
    times = [absolute]
    server_now = _http_date(date_header) if isinstance(date_header, str) else None
    if server_now is not None:
        times.append(received_at + (absolute - server_now))
    return max(times)

def _body_text(body, path):
    """A body field's value as text (§ Response body fields): a string, or an integer's decimal form."""
    value = body
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    return value if isinstance(value, str) else None


def classify(document, status, headers, body, received_at):
    """Classify one response under the document's x-throttling.

    `headers` maps names (any case) to a value, or to a list of values when the
    header appeared more than once. `body` is the parsed JSON body, or None when
    there is none or it is not JSON. `received_at` is epoch seconds. Returns None
    when the response is not throttling, else a dict with `meaning`, `bucket`
    (or None) and `retryAt` (epoch seconds, or None when the consumer's own
    backoff applies). A 429 is throttling with or without declared signals.
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
    # role -> [(value, unit), ...]: headers first, then body fields (0.3.0).
    roles = {}
    for name, header in root.get("headers", {}).items():
        value = single_header(headers, name)
        if value is not None and value is not _REPEATED:
            roles.setdefault(header["role"], []).append((value, header.get("unit")))
    for path, field in root.get("bodyFields", {}).items():
        value = _body_text(body, path)
        if value is not None:
            roles.setdefault(field["role"], []).append((value, field.get("unit")))
    date_header = single_header(headers, "date")
    date_header = date_header if isinstance(date_header, str) else None
    times = []
    for value, unit in roles.get("retryAfter", []):
        times.append(parse_time(value, unit, received_at, date_header))
    remaining = next((n for n in (_integer(v) for v, _ in roles.get("remaining", [])) if n is not None), None)
    exhausted = matched["meaning"] == "quotaExhausted" or remaining == 0
    if exhausted:
        for value, unit in roles.get("reset", []):
            times.append(parse_time(value, unit, received_at, date_header))
    times = [t for t in times if t is not None]
    bucket = matched.get("bucket")
    if times:
        retry_at = max(times)
    elif "minDelaySeconds" in matched:
        retry_at = received_at + matched["minDelaySeconds"]
    elif matched["meaning"] == "quotaExhausted" and bucket in root.get("limits", {}):
        retry_at = received_at + root["limits"][bucket]["window"]["seconds"]
    else:
        retry_at = None
    return {"meaning": matched["meaning"], "bucket": bucket, "retryAt": retry_at}



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
