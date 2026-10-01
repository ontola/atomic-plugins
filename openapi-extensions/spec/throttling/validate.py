"""Validate x-throttling structure; ordinary OpenAPI validation is separate."""
import datetime
import json
import re
import sys
from urllib.parse import urlparse

DIMENSIONS = {"sourceIp", "user", "session", "application", "credential", "account", "operation"}
METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def strings(value, label):
    require(isinstance(value, list) and all(isinstance(v, str) and v for v in value), f"{label}: expected string array")
    require(len(value) == len(set(value)), f"{label}: duplicate entries")

def positive(value, label):
    require(type(value) is int and value > 0, f"{label}: expected positive integer")

def validate(document):
    root = document.get("x-throttling")
    limits = {}
    if root is not None:
        require(isinstance(root, dict), "root: expected object")
        require(set(root) == {"limits", "applies"}, "root: expected limits and applies")
        limits = root["limits"]
        require(isinstance(limits, dict) and limits, "limits: expected nonempty object")
        for name, limit in limits.items():
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
        selection(root["applies"], limits, "root.applies")
    for path, item in document.get("paths", {}).items():
        for method, operation in item.items():
            if method in METHODS and isinstance(operation, dict) and "x-throttling" in operation:
                require(root is not None, "operation selection requires root definitions")
                selection(operation["x-throttling"], limits, f"{method} {path}")

def selection(value, limits, label):
    strings(value, label)
    require(all(name in limits for name in value), f"{label}: undefined bucket")

if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as source:
        validate(json.load(source))
    print("Throttling structure valid")
