"""Validate x-webhook-deliveries (0.1.0-draft) and check its text with fixtures.

validate(document) checks a loaded OpenAPI document's x-webhook-deliveries
against schema.json, then the cross-references schema.json cannot express
(README section 7). verify_delivery and route_delivery follow README
sections 4.2.1 and 4.3-4.6 so the tests can run signed fixtures through the
text; they are a reference for the rules, not a receiver.
"""
import base64
import binascii
import hashlib
import hmac
import json
import pathlib
import re
import sys
import urllib.parse

import jsonschema
import yaml

ROOT = pathlib.Path(__file__).parent
SCHEMA = json.loads((ROOT / "schema.json").read_text(encoding="utf-8"))
TOKENS = {"$receiver.url", "$receiver.secret", "$events"}
TEMPLATE_VARIABLE = re.compile(r"\{([^{}]+)\}")


class VerificationError(ValueError):
    """A delivery that fails README section 4.2.1."""


def require(condition, message):
    if not condition:
        raise ValueError(message)


# --- expressions -----------------------------------------------------------

def pointer_segments(expression):
    """Split a $request.body# / $response.body# expression into segments."""
    _, _, pointer = expression.partition("#")
    if pointer == "":
        return []
    return [s.replace("~1", "/").replace("~0", "~") for s in pointer[1:].split("/")]


def wildcards(expression):
    return pointer_segments(expression).count("*")


def select(value, segments):
    """Every value a pointer selects; '*' selects each array element."""
    current = [value]
    for segment in segments:
        following = []
        for item in current:
            if segment == "*":
                if isinstance(item, list):
                    following.extend(item)
            elif isinstance(item, dict) and segment in item:
                following.append(item[segment])
            elif isinstance(item, list) and re.fullmatch(r"0|[1-9][0-9]*", segment):
                index = int(segment)
                if index < len(item):
                    following.append(item[index])
        current = following
    return current


def key_of(value):
    """README section 3: a key is a string or a non-negative integer, as text."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value) if value >= 0 else None
    if isinstance(value, str):
        return value
    return None


def single_key(body, expression):
    selected = select(body, pointer_segments(expression))
    return key_of(selected[0]) if len(selected) == 1 else None


def template_variables(template):
    return TEMPLATE_VARIABLE.findall(template)


# --- validation ------------------------------------------------------------

def operation_exists(document, reference, label):
    paths = document.get("paths")
    require(isinstance(paths, dict), f"{label}: document has no paths")
    item = paths.get(reference["path"])
    require(isinstance(item, dict), f"{label}: path {reference['path']} is not in paths")
    require(isinstance(item.get(reference["method"]), dict),
            f"{label}: {reference['method']} {reference['path']} is not in paths")


def body_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from body_strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from body_strings(item)


def check_bindings(bindings, template, label):
    variables = set(template_variables(template))
    bound = set(bindings or {})
    require(bound == variables,
            f"{label}: bindings {sorted(bound)} must be exactly the variables {sorted(variables)} of {template}")


def validate(document):
    require(isinstance(document, dict), "document: expected an object")
    root = document.get("x-webhook-deliveries")
    require(root is not None, "document: no x-webhook-deliveries")
    try:
        jsonschema.validate(root, SCHEMA)
    except jsonschema.ValidationError as error:
        location = "/".join(str(p) for p in error.absolute_path)
        raise ValueError(f"x-webhook-deliveries/{location}: {error.message}") from None

    profiles = root["verificationProfiles"]
    sources = root["sources"]
    events = root["events"]

    for name, profile in profiles.items():
        timed = profile["signedContent"] == "timestampDotRawBody"
        require(("timestamp" in profile) == timed,
                f"verificationProfiles.{name}: timestamp is declared exactly when signedContent is timestampDotRawBody")

    delivery = root["delivery"]
    for field in ("eventType", "action"):
        if isinstance(delivery.get(field), str):
            require(wildcards(delivery[field]) == 0, f"delivery.{field}: '*' is not allowed here")

    for kind, source in sources.items():
        require(wildcards(source["key"]) == 0, f"sources.{kind}.key: '*' is not allowed here")
        require(wildcards(source["access"]["key"]) == 0, f"sources.{kind}.access.key: '*' is not allowed here")
        for name, expression in source.get("context", {}).items():
            require(wildcards(expression) == 0, f"sources.{kind}.context.{name}: '*' is not allowed here")
        access = source["access"]["operation"]
        require(access["method"] == "get", f"sources.{kind}.access.operation: must be a get")
        operation_exists(document, access, f"sources.{kind}.access.operation")

    hooks = root["hooks"]
    shared = hooks.get("sharedApplication")
    if shared:
        profile = profiles.get(shared["verificationProfile"])
        require(profile is not None, "hooks.sharedApplication: undeclared verificationProfile")
        require(profile["secret"]["source"] == "operatorConfigured",
                "hooks.sharedApplication: its profile's secret source must be operatorConfigured")
    dedicated = hooks.get("dedicated")
    if dedicated:
        profile = profiles.get(dedicated["verificationProfile"])
        require(profile is not None, "hooks.dedicated: undeclared verificationProfile")
        require(profile["secret"]["source"] == "receiverGenerated",
                "hooks.dedicated: its profile's secret source must be receiverGenerated")
        source = sources.get(dedicated["source"])
        require(source is not None, "hooks.dedicated: undeclared source")
        access_parameters = set(template_variables(source["access"]["operation"]["path"]))
        require(dedicated["hookIdParameter"] not in access_parameters,
                "hooks.dedicated.hookIdParameter: must not be an access operation parameter")
        require(wildcards(dedicated["hookId"]) == 0, "hooks.dedicated.hookId: '*' is not allowed here")
        for field in ("create", "delete", "list"):
            if field not in dedicated:
                continue
            operation = dedicated[field]
            operation_exists(document, operation, f"hooks.dedicated.{field}")
            parameters = set(template_variables(operation["path"]))
            allowed = access_parameters | ({dedicated["hookIdParameter"]} if field == "delete" else set())
            require(parameters <= allowed,
                    f"hooks.dedicated.{field}: path parameters {sorted(parameters - allowed)} are not access operation parameters")
            if field == "delete":
                require(dedicated["hookIdParameter"] in parameters,
                        "hooks.dedicated.delete: path must contain hookIdParameter")
            for text in body_strings(operation.get("body")):
                require(not text.startswith("$") or text in TOKENS,
                        f"hooks.dedicated.{field}.body: unknown token {text}")
        tokens = list(body_strings(dedicated["create"].get("body")))
        for token in ("$receiver.url", "$receiver.secret"):
            require(token in tokens, f"hooks.dedicated.create.body: must contain {token}")
        if "list" in dedicated:
            for field in ("url", "hookId"):
                require(wildcards(dedicated["list"][field]) == 1,
                        f"hooks.dedicated.list.{field}: must use '*' exactly once")

    crud = (document.get("components") or {}).get("crudResources")
    for event_type, event in events.items():
        label = f"events.{event_type}"
        require(event["source"] in sources, f"{label}: undeclared source")
        reads = event.get("resources", []) + event.get("collections", [])
        if reads:
            require(isinstance(crud, dict),
                    f"{label}: names resources but the document has no components.crudResources")
        for read in event.get("resources", []):
            resource = crud.get(read["resource"])
            require(isinstance(resource, dict), f"{label}: unknown resource {read['resource']}")
            check_bindings(read["bindings"], resource["identity"]["urlTemplate"], f"{label}.resources.{read['resource']}")
        for read in event.get("collections", []):
            resource = crud.get(read["resource"])
            require(isinstance(resource, dict), f"{label}: unknown resource {read['resource']}")
            collection = (resource.get("collections") or {}).get(read["collection"])
            require(isinstance(collection, dict),
                    f"{label}: unknown collection {read['resource']}.{read['collection']}")
            check_bindings(read.get("bindings"), collection["urlTemplate"],
                           f"{label}.collections.{read['collection']}")
        for read in reads:
            for name, expression in (read.get("bindings") or {}).items():
                require(wildcards(expression) == 0, f"{label}: binding {name} may not use '*'")

    for index, revocation in enumerate(root.get("revocations", [])):
        label = f"revocations[{index}]"
        source = sources.get(revocation["source"])
        require(source is not None, f"{label}: undeclared source")
        if "context" in revocation:
            require(revocation["context"] in source.get("context", {}),
                    f"{label}: context {revocation['context']} is not declared on source {revocation['source']}")
        require(wildcards(revocation["keys"]) <= 1, f"{label}.keys: at most one '*'")


# --- reference verification and routing ---------------------------------------

def header(headers, name):
    """The one value of a header; headers are (name, value) pairs."""
    values = [value for key, value in headers if key.lower() == name.lower()]
    if len(values) != 1:
        raise VerificationError(f"header {name}: expected exactly one, got {len(values)}")
    return values[0]


def decode_signature(signature, text):
    prefix = signature.get("prefix", "")
    if not text.startswith(prefix):
        raise VerificationError("signature: missing prefix")
    encoded = text[len(prefix):]
    if signature["encoding"] == "hex":
        if not re.fullmatch(r"[0-9A-Fa-f]{64}", encoded):
            raise VerificationError("signature: not 64 hex digits")
        return bytes.fromhex(encoded)
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except binascii.Error:
        raise VerificationError("signature: not base64") from None
    if len(decoded) != 32:
        raise VerificationError("signature: not 32 bytes")
    return decoded


def verify_delivery(profile, headers, body, secret, now):
    """README 4.2.1 steps 3-5. body and secret are bytes; now is Unix seconds."""
    if len(secret) < profile["secret"].get("minBytes", 32):
        raise VerificationError("secret: shorter than minBytes")
    signature = decode_signature(profile["signature"], header(headers, profile["signature"]["name"]))
    content = body
    if profile["signedContent"] == "timestampDotRawBody":
        stamp = header(headers, profile["timestamp"]["name"])
        if not re.fullmatch(r"[0-9]{1,12}", stamp):
            raise VerificationError("timestamp: not decimal seconds")
        if abs(now - int(stamp)) > profile["timestamp"]["toleranceSeconds"]:
            raise VerificationError("timestamp: outside tolerance")
        content = stamp.encode("ascii") + b"." + body
    expected = hmac.new(secret, content, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, signature):
        raise VerificationError("signature: mismatch")


def fill(template, values):
    return TEMPLATE_VARIABLE.sub(lambda m: urllib.parse.quote(values[m.group(1)], safe=""), template)


def route_delivery(document, headers, body):
    """What a receiver reads from a verified delivery (README 4.3-4.6)."""
    root = document["x-webhook-deliveries"]
    delivery = root["delivery"]
    parsed = json.loads(body.decode("utf-8"))
    delivery_id = header(headers, delivery["id"]["name"])
    if not re.fullmatch(r"[\x21-\x7e]{1,255}", delivery_id):
        raise VerificationError("delivery id: not 1-255 printable ASCII characters")
    if isinstance(delivery["eventType"], dict):
        event_type = header(headers, delivery["eventType"]["name"])
    else:
        event_type = single_key(parsed, delivery["eventType"])
    action = single_key(parsed, delivery["action"]) if "action" in delivery else None
    result = {"deliveryId": delivery_id, "eventType": event_type, "action": action,
              "source": None, "context": {}, "revoked": [], "resources": [], "collections": []}

    for revocation in root.get("revocations", []):
        if revocation["event"] != event_type:
            continue
        if "actions" in revocation and action not in revocation["actions"]:
            continue
        keys = sorted({k for k in map(key_of, select(parsed, pointer_segments(revocation["keys"]))) if k is not None})
        result["revoked"].append({"source": revocation["source"], "context": revocation.get("context"), "keys": keys})

    event = root["events"].get(event_type)
    if event is None:
        return result
    source = root["sources"][event["source"]]
    key = single_key(parsed, source["key"])
    if key is None:
        return result
    result["source"] = {"kind": event["source"], "key": key}
    for name, expression in source.get("context", {}).items():
        value = single_key(parsed, expression)
        if value is not None:
            result["context"][name] = value

    crud = document["components"]["crudResources"] if event.get("resources") or event.get("collections") else {}
    for read in event.get("resources", []):
        values = {name: single_key(parsed, expr) for name, expr in read["bindings"].items()}
        if None not in values.values():
            template = crud[read["resource"]]["identity"]["urlTemplate"]
            result["resources"].append({"resource": read["resource"], "path": fill(template, values)})
    for read in event.get("collections", []):
        values = {name: single_key(parsed, expr) for name, expr in (read.get("bindings") or {}).items()}
        if None not in values.values():
            template = crud[read["resource"]]["collections"][read["collection"]]["urlTemplate"]
            result["collections"].append({"resource": read["resource"], "collection": read["collection"],
                                          "path": fill(template, values)})
    return result


def load(path):
    with open(path, encoding="utf-8") as source:
        return yaml.safe_load(source)


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        validate(load(argument))
        print(f"{argument}: x-webhook-deliveries valid")
