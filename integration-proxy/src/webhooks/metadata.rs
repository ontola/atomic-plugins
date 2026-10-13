//! `x-webhook-deliveries` (Webhook Deliveries 0.1.0-draft), read from a
//! platform's composed catalog document. Generic: every platform's
//! declaration is read the same way, and nothing here names a provider.
//! What a document cannot express in this version (handshakes, other
//! algorithms, non-JSON bodies) is refused, not guessed.

use std::collections::BTreeMap;

use serde_json::Value;

/// A JSON Pointer from a `$request.body#` or `$response.body#` expression.
/// `*` selects each element of an array where the spec allows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pointer(Vec<String>);

impl Pointer {
    fn parse(expression: &str, prefix: &str) -> Result<Self, String> {
        let pointer = expression
            .strip_prefix(prefix)
            .ok_or_else(|| format!("{expression}: expected {prefix}"))?;
        if pointer.is_empty() {
            return Ok(Self(Vec::new()));
        }
        let rest = pointer
            .strip_prefix('/')
            .ok_or_else(|| format!("{expression}: not a JSON Pointer"))?;
        let mut segments = Vec::new();
        for segment in rest.split('/') {
            if segment.replace("~0", "").replace("~1", "").contains('~') {
                return Err(format!("{expression}: invalid escape"));
            }
            segments.push(segment.replace("~1", "/").replace("~0", "~"));
        }
        Ok(Self(segments))
    }

    /// `(before, after)` the single `*`: the array, and the path inside each
    /// element.
    pub fn split_wildcard(&self) -> Option<(Pointer, Pointer)> {
        let at = self.0.iter().position(|segment| segment == "*")?;
        Some((Self(self.0[..at].to_vec()), Self(self.0[at + 1..].to_vec())))
    }

    fn wildcards(&self) -> usize {
        self.0.iter().filter(|segment| *segment == "*").count()
    }

    /// Every value the pointer selects.
    pub fn select<'a>(&self, value: &'a Value) -> Vec<&'a Value> {
        let mut current = vec![value];
        for segment in &self.0 {
            let mut next = Vec::new();
            for item in current {
                match (segment.as_str(), item) {
                    ("*", Value::Array(items)) => next.extend(items.iter()),
                    (key, Value::Object(map)) => next.extend(map.get(key)),
                    (index, Value::Array(items)) => {
                        if let Some(item) = index
                            .parse::<usize>()
                            .ok()
                            .filter(|_| index == "0" || !index.starts_with('0'))
                            .and_then(|index| items.get(index))
                        {
                            next.push(item);
                        }
                    }
                    _ => {}
                }
            }
            current = next;
        }
        current
    }

    /// The one key the pointer selects (Webhook Deliveries §3).
    pub fn key(&self, value: &Value) -> Option<String> {
        match self.select(value).as_slice() {
            [one] => key_of(one),
            _ => None,
        }
    }

    /// Every key the pointer selects, deduplicated and sorted.
    pub fn keys(&self, value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = self.select(value).into_iter().filter_map(key_of).collect();
        keys.sort();
        keys.dedup();
        keys
    }
}

/// A string, or a non-negative integer as decimal text.
pub fn key_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() && text.len() <= 512 => Some(text.clone()),
        Value::Number(number) => number.as_u64().map(|n| n.to_string()),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Encoding {
    Hex,
    Base64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretSource {
    ReceiverGenerated,
    OperatorConfigured,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub signature_header: String,
    pub prefix: String,
    pub encoding: Encoding,
    /// `Some` for `timestampDotRawBody`: header and tolerance.
    pub timestamp: Option<(String, u64)>,
    pub secret: SecretSource,
    pub min_secret_bytes: usize,
}

#[derive(Clone, Debug)]
pub enum EventType {
    Header(String),
    Body(Pointer),
}

#[derive(Clone, Debug)]
pub struct Source {
    pub key: Pointer,
    pub access_path: String,
    pub access_key: Pointer,
    pub context: BTreeMap<String, Pointer>,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub source: String,
}

#[derive(Clone, Debug)]
pub struct Revocation {
    pub event: String,
    pub actions: Option<Vec<String>>,
    pub source: String,
    pub context: Option<String>,
    pub keys: Pointer,
}

#[derive(Clone, Debug)]
pub struct Operation {
    pub method: String,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct Dedicated {
    pub profile: String,
    pub source: String,
    pub delete: Operation,
    pub hook_id_parameter: String,
    /// `list`: its path, and per listed hook its URL and id.
    pub list: Option<(String, Pointer, Pointer)>,
}

#[derive(Clone, Debug)]
pub struct Deliveries {
    pub profiles: BTreeMap<String, Profile>,
    pub delivery_id_header: String,
    pub event_type: EventType,
    pub action: Option<Pointer>,
    pub sources: BTreeMap<String, Source>,
    pub shared_profile: Option<String>,
    pub dedicated: Option<Dedicated>,
    pub events: BTreeMap<String, Event>,
    pub revocations: Vec<Revocation>,
}

fn text<'a>(value: &'a Value, field: &str, label: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label}.{field}: expected a string"))
}

fn header_location(value: &Value, label: &str) -> Result<String, String> {
    if value.get("in").and_then(Value::as_str) != Some("header") {
        return Err(format!("{label}: only `in: header` is supported"));
    }
    let name = text(value, "name", label)?;
    axum::http::HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| format!("{label}.name: not a header name"))?;
    Ok(name.to_ascii_lowercase())
}

fn request_pointer(value: &Value, label: &str) -> Result<Pointer, String> {
    let expression = value
        .as_str()
        .ok_or_else(|| format!("{label}: expected an expression"))?;
    Pointer::parse(expression, "$request.body#")
}

fn no_wildcard(pointer: Pointer, label: &str) -> Result<Pointer, String> {
    if pointer.wildcards() > 0 {
        return Err(format!("{label}: '*' is not allowed here"));
    }
    Ok(pointer)
}

impl Deliveries {
    /// Parses a composed document's declaration.
    pub fn from_document(document: &Value) -> Result<Self, String> {
        let root = document
            .get("x-webhook-deliveries")
            .ok_or("no x-webhook-deliveries")?;
        let mut profiles = BTreeMap::new();
        for (name, profile) in root
            .get("verificationProfiles")
            .and_then(Value::as_object)
            .ok_or("verificationProfiles: expected an object")?
        {
            let label = format!("verificationProfiles.{name}");
            if profile.get("algorithm").and_then(Value::as_str) != Some("hmac-sha256") {
                return Err(format!("{label}: only hmac-sha256 is supported"));
            }
            let signature = profile
                .get("signature")
                .ok_or_else(|| format!("{label}.signature: required"))?;
            let encoding = match signature.get("encoding").and_then(Value::as_str) {
                Some("hex") => Encoding::Hex,
                Some("base64") => Encoding::Base64,
                _ => return Err(format!("{label}.signature.encoding: hex or base64")),
            };
            let timestamp = match profile.get("signedContent").and_then(Value::as_str) {
                Some("rawBody") if profile.get("timestamp").is_none() => None,
                Some("timestampDotRawBody") => {
                    let stamp = profile
                        .get("timestamp")
                        .ok_or_else(|| format!("{label}.timestamp: required"))?;
                    if stamp.get("format").and_then(Value::as_str) != Some("unixSeconds") {
                        return Err(format!("{label}.timestamp.format: unixSeconds"));
                    }
                    let tolerance = stamp
                        .get("toleranceSeconds")
                        .and_then(Value::as_u64)
                        .filter(|t| (1..=900).contains(t))
                        .ok_or_else(|| format!("{label}.timestamp.toleranceSeconds: 1 to 900"))?;
                    Some((header_location(stamp, &label)?, tolerance))
                }
                _ => return Err(format!("{label}: invalid signedContent or timestamp")),
            };
            let secret = profile
                .get("secret")
                .ok_or_else(|| format!("{label}.secret: required"))?;
            let source = match secret.get("source").and_then(Value::as_str) {
                Some("receiverGenerated") => SecretSource::ReceiverGenerated,
                Some("operatorConfigured") => SecretSource::OperatorConfigured,
                _ => return Err(format!("{label}.secret.source: invalid")),
            };
            let min_secret_bytes = match secret.get("minBytes") {
                None => 32,
                Some(value) => value
                    .as_u64()
                    .filter(|n| (32..=1024).contains(n))
                    .ok_or_else(|| format!("{label}.secret.minBytes: 32 to 1024"))?
                    as usize,
            };
            profiles.insert(
                name.clone(),
                Profile {
                    signature_header: header_location(signature, &format!("{label}.signature"))?,
                    prefix: signature
                        .get("prefix")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    encoding,
                    timestamp,
                    secret: source,
                    min_secret_bytes,
                },
            );
        }

        let delivery = root.get("delivery").ok_or("delivery: required")?;
        let delivery_id_header = header_location(
            delivery.get("id").ok_or("delivery.id: required")?,
            "delivery.id",
        )?;
        let event_type = match delivery.get("eventType") {
            Some(value @ Value::Object(_)) => {
                EventType::Header(header_location(value, "delivery.eventType")?)
            }
            Some(value) => EventType::Body(no_wildcard(
                request_pointer(value, "delivery.eventType")?,
                "delivery.eventType",
            )?),
            None => return Err("delivery.eventType: required".into()),
        };
        let action = delivery
            .get("action")
            .map(|value| {
                request_pointer(value, "delivery.action")
                    .and_then(|p| no_wildcard(p, "delivery.action"))
            })
            .transpose()?;

        let mut sources = BTreeMap::new();
        for (kind, source) in root
            .get("sources")
            .and_then(Value::as_object)
            .ok_or("sources: expected an object")?
        {
            let label = format!("sources.{kind}");
            let access = source
                .get("access")
                .ok_or_else(|| format!("{label}.access: required"))?;
            let operation = access
                .get("operation")
                .ok_or_else(|| format!("{label}.access.operation: required"))?;
            if operation.get("method").and_then(Value::as_str) != Some("get") {
                return Err(format!("{label}.access.operation: must be a get"));
            }
            let mut context = BTreeMap::new();
            for (name, expression) in source
                .get("context")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                context.insert(
                    name.clone(),
                    no_wildcard(request_pointer(expression, &label)?, &label)?,
                );
            }
            sources.insert(
                kind.clone(),
                Source {
                    key: no_wildcard(
                        request_pointer(source.get("key").unwrap_or(&Value::Null), &label)?,
                        &label,
                    )?,
                    access_path: text(operation, "path", &label)?.to_owned(),
                    access_key: no_wildcard(
                        Pointer::parse(text(access, "key", &label)?, "$response.body#")?,
                        &label,
                    )?,
                    context,
                },
            );
        }

        let hooks = root.get("hooks").ok_or("hooks: required")?;
        let shared_profile = hooks
            .get("sharedApplication")
            .map(|shared| text(shared, "verificationProfile", "hooks.sharedApplication"))
            .transpose()?
            .map(str::to_owned);
        if let Some(name) = &shared_profile {
            if profiles.get(name).map(|p| &p.secret) != Some(&SecretSource::OperatorConfigured) {
                return Err("hooks.sharedApplication: needs an operatorConfigured profile".into());
            }
        }
        let dedicated = match hooks.get("dedicated") {
            None => None,
            Some(dedicated) => {
                let label = "hooks.dedicated";
                let profile = text(dedicated, "verificationProfile", label)?.to_owned();
                if profiles.get(&profile).map(|p| &p.secret)
                    != Some(&SecretSource::ReceiverGenerated)
                {
                    return Err(format!("{label}: needs a receiverGenerated profile"));
                }
                let delete = dedicated
                    .get("delete")
                    .ok_or_else(|| format!("{label}.delete: required"))?;
                Some(Dedicated {
                    profile,
                    source: text(dedicated, "source", label)?.to_owned(),
                    delete: Operation {
                        method: text(delete, "method", label)?.to_owned(),
                        path: text(delete, "path", label)?.to_owned(),
                    },
                    hook_id_parameter: text(dedicated, "hookIdParameter", label)?.to_owned(),
                    list: match dedicated.get("list") {
                        None => None,
                        Some(list) => {
                            if list.get("method").and_then(Value::as_str) != Some("get") {
                                return Err(format!("{label}.list: must be a get"));
                            }
                            let url = Pointer::parse(text(list, "url", label)?, "$response.body#")?;
                            let id =
                                Pointer::parse(text(list, "hookId", label)?, "$response.body#")?;
                            if url.wildcards() != 1 || id.wildcards() != 1 {
                                return Err(format!("{label}.list: '*' exactly once"));
                            }
                            Some((text(list, "path", label)?.to_owned(), url, id))
                        }
                    },
                })
            }
        };
        if shared_profile.is_none() && dedicated.is_none() {
            return Err("hooks: at least one model".into());
        }

        let mut events = BTreeMap::new();
        for (event_type, event) in root
            .get("events")
            .and_then(Value::as_object)
            .ok_or("events: expected an object")?
        {
            let source = text(event, "source", &format!("events.{event_type}"))?;
            if !sources.contains_key(source) {
                return Err(format!("events.{event_type}: undeclared source"));
            }
            events.insert(
                event_type.clone(),
                Event {
                    source: source.to_owned(),
                },
            );
        }

        let mut revocations = Vec::new();
        for (index, revocation) in root
            .get("revocations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let label = format!("revocations[{index}]");
            let source = text(revocation, "source", &label)?.to_owned();
            let context = revocation
                .get("context")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let declared = sources
                .get(&source)
                .ok_or_else(|| format!("{label}: undeclared source"))?;
            if context
                .as_ref()
                .is_some_and(|c| !declared.context.contains_key(c))
            {
                return Err(format!("{label}: undeclared context"));
            }
            let keys = request_pointer(revocation.get("keys").unwrap_or(&Value::Null), &label)?;
            if keys.wildcards() > 1 {
                return Err(format!("{label}.keys: at most one '*'"));
            }
            revocations.push(Revocation {
                event: text(revocation, "event", &label)?.to_owned(),
                actions: revocation
                    .get("actions")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    }),
                source,
                context,
                keys,
            });
        }

        Ok(Self {
            profiles,
            delivery_id_header,
            event_type,
            action,
            sources,
            shared_profile,
            dedicated,
            events,
            revocations,
        })
    }
}

/// Fills a path template with values, each percent-encoded as one segment
/// (Webhook Deliveries §4.4.1): every byte outside RFC 3986 `unreserved`
/// is encoded, `.`, `..` and empty values are refused, and the values must
/// be exactly the template's variables.
pub fn fill_path(template: &str, values: &BTreeMap<String, String>) -> Result<String, String> {
    let mut path = String::new();
    let mut rest = template;
    let mut used = 0;
    while let Some(open) = rest.find('{') {
        let close = rest[open..]
            .find('}')
            .ok_or("unterminated template variable")?
            + open;
        path.push_str(&rest[..open]);
        let name = &rest[open + 1..close];
        let value = values
            .get(name)
            .ok_or_else(|| format!("missing parameter {name}"))?;
        if value.is_empty() || value == "." || value == ".." || value.len() > 512 {
            return Err(format!("parameter {name}: not a single path segment"));
        }
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                path.push(byte as char);
            } else {
                path.push_str(&format!("%{byte:02X}"));
            }
        }
        used += 1;
        rest = &rest[close + 1..];
    }
    path.push_str(rest);
    if used != values.len() {
        return Err("parameters must be exactly the template's variables".into());
    }
    Ok(path)
}

/// The nesting depth of a JSON text, counted without parsing it, so a body
/// deeper than the limit is refused before a recursive parser sees it.
pub fn json_depth(bytes: &[u8]) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for &byte in bytes {
        if in_string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../openapi-extensions/spec/webhook-deliveries/examples")
            .join(name);
        serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn the_specs_examples_parse() {
        let github = Deliveries::from_document(&fixture("github-fixture.yaml")).unwrap();
        assert_eq!(github.delivery_id_header, "x-github-delivery");
        assert!(matches!(&github.event_type, EventType::Header(h) if h == "x-github-event"));
        assert_eq!(github.shared_profile.as_deref(), Some("githubApp"));
        assert_eq!(github.profiles["githubApp"].prefix, "sha256=");
        assert_eq!(
            github.sources["repository"].access_path,
            "/repos/{owner}/{repo}"
        );
        assert_eq!(github.revocations.len(), 2);
        let tracker = Deliveries::from_document(&fixture("tracker.yaml")).unwrap();
        assert_eq!(
            tracker.profiles["projectHook"].timestamp,
            Some(("tracker-timestamp".into(), 300))
        );
        assert!(matches!(tracker.event_type, EventType::Body(_)));
    }

    #[test]
    fn unsupported_declarations_are_refused() {
        let mut document = fixture("tracker.yaml");
        document["x-webhook-deliveries"]["verificationProfiles"]["appHook"]["algorithm"] =
            "ed25519".into();
        assert!(Deliveries::from_document(&document).is_err());
        let mut document = fixture("tracker.yaml");
        document["x-webhook-deliveries"]["hooks"]["sharedApplication"]["verificationProfile"] =
            "projectHook".into();
        assert!(Deliveries::from_document(&document).is_err());
        let mut document = fixture("tracker.yaml");
        document["x-webhook-deliveries"]["sources"]["project"]["key"] =
            "$request.body#/projects/*/id".into();
        assert!(Deliveries::from_document(&document).is_err());
    }

    #[test]
    fn keys_are_strings_or_non_negative_integers() {
        let pointer = Pointer::parse("$request.body#/a", "$request.body#").unwrap();
        for (value, key) in [
            (serde_json::json!({"a": 42}), Some("42")),
            (serde_json::json!({"a": "42"}), Some("42")),
            (serde_json::json!({"a": -1}), None),
            (serde_json::json!({"a": 1.5}), None),
            (serde_json::json!({"a": true}), None),
            (serde_json::json!({"a": null}), None),
            (serde_json::json!({"a": ""}), None),
            (serde_json::json!({}), None),
        ] {
            assert_eq!(pointer.key(&value).as_deref(), key, "{value}");
        }
        let all = Pointer::parse("$request.body#/r/*/id", "$request.body#").unwrap();
        assert_eq!(
            all.keys(&serde_json::json!({"r": [{"id": 2}, {"id": 1}, {"id": 2}]})),
            ["1", "2"]
        );
        let escaped = Pointer::parse("$request.body#/a~1b/c~0d", "$request.body#").unwrap();
        assert_eq!(
            escaped
                .key(&serde_json::json!({"a/b": {"c~d": "x"}}))
                .as_deref(),
            Some("x")
        );
    }

    #[test]
    fn path_values_are_single_encoded_segments() {
        let values = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(
            fill_path(
                "/repos/{owner}/{repo}",
                &values(&[("owner", "a/b"), ("repo", "c?d#e%f g")])
            )
            .unwrap(),
            "/repos/a%2Fb/c%3Fd%23e%25f%20g"
        );
        for bad in [
            values(&[("owner", ".."), ("repo", "x")]),
            values(&[("owner", "."), ("repo", "x")]),
            values(&[("owner", ""), ("repo", "x")]),
            values(&[("owner", "x")]),
            values(&[("owner", "x"), ("repo", "y"), ("extra", "z")]),
        ] {
            assert!(fill_path("/repos/{owner}/{repo}", &bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn json_depth_ignores_brackets_in_strings() {
        assert_eq!(json_depth(br#"{"a":[1,{"b":"[[[{"}]}"#), 3);
        assert_eq!(json_depth(br#""\"[""#), 0);
        assert_eq!(json_depth(&b"[".repeat(100)), 100);
    }
}
