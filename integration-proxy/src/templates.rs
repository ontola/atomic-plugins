//! Minimal, dependency-free HTML rendering. The proxy has no accounts and
//! no login (issue #54): the only pages are the landing page and the
//! per-platform consent screen.
//!
//! Every value that reaches the HTML goes through [`escape`]: the operator
//! name and URL come from the environment, the host from `BASE_URL`, and the
//! platform, destination and CSRF token from the request.

use crate::config::DEFAULT_OPERATOR_NAME;

/// Who runs this proxy and where it lives, as the pages show it:
/// `OPERATOR_NAME`, `OPERATOR_URL`, and the host of `BASE_URL`.
#[derive(Clone, Debug)]
pub(crate) struct Operator {
    name: String,
    url: Option<String>,
    host: String,
}

impl Operator {
    pub(crate) fn new(name: &str, url: Option<&str>, host: &str) -> Self {
        Self {
            name: name.to_owned(),
            url: url.map(str::to_owned),
            host: host.to_owned(),
        }
    }

    pub(crate) fn from_config(config: &crate::Config) -> Self {
        Self::new(
            &crate::config::operator_name(Some(&config.operator_name)),
            config.operator_url.as_deref(),
            &config.public_host(),
        )
    }

    /// Whether `OPERATOR_NAME` named someone, rather than the neutral default.
    fn is_named(&self) -> bool {
        self.name != DEFAULT_OPERATOR_NAME
    }

    /// A heading-sized name, escaped: the operator's, or "Integration proxy".
    fn title(&self) -> String {
        if self.is_named() {
            escape(&self.name)
        } else {
            "Integration proxy".to_owned()
        }
    }

    /// The operator's name, escaped and linked to `OPERATOR_URL` when set.
    fn linked_name(&self) -> String {
        match &self.url {
            Some(url) => format!(
                r#"<a href="{}" rel="noopener noreferrer">{}</a>"#,
                escape(url),
                escape(&self.name)
            ),
            None => escape(&self.name),
        }
    }
}

/// The landing page at `/`.
pub fn render_home(operator: &Operator) -> String {
    let brand = match &operator.url {
        Some(url) => format!(
            r#"<a class="brand" href="{}" rel="noopener noreferrer">{}</a>"#,
            escape(url),
            operator.title()
        ),
        None => format!(r#"<a class="brand" href="/">{}</a>"#, operator.title()),
    };
    let run_by = if operator.is_named() {
        operator.linked_name()
    } else {
        format!(
            "the operator of <strong>{}</strong>",
            escape(&operator.host)
        )
    };
    fill(
        include_str!("../static/index.html"),
        &[
            ("title", &operator.title()),
            ("brand", &brand),
            ("host", &escape(&operator.host)),
            ("operator", &run_by),
        ],
    )
}

/// Replaces each `{{key}}` in `template` with its already-escaped value, in
/// one pass, so a value can never introduce a placeholder of its own. An
/// unknown key is left as it is (the tests look for a leftover `{{`).
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let found = after.find("}}").and_then(|end| {
            values
                .iter()
                .find(|(key, _)| *key == &after[..end])
                .map(|(_, value)| (end, *value))
        });
        match found {
            Some((end, value)) => {
                out.push_str(value);
                rest = &after[end + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Renders the consent screen for one selected platform. `destination` is
/// where the browser returns to (an origin, or the app's deep link).
pub fn render_platform_connect(
    operator: &Operator,
    platform: &str,
    destination: &str,
    csrf: &str,
    requires_api_key: bool,
) -> String {
    let (api_key_field, button_label) = if requires_api_key {
        (
            r#"<p class="secret-help">Find this in your account settings on the platform's own site. It is stored encrypted on this proxy and never sent back to the destination.</p>
               <input class="button" style="background:white;color:#202124;border:1px solid #ccc" type="password" name="api_key" autocomplete="off" placeholder="API key" required />"#,
            format!("Connect {}", escape(&platform_label(platform))),
        )
    } else {
        (
            "",
            format!(
                "Use {} to sync {} with this destination",
                escape(&operator.name),
                escape(&platform_label(platform))
            ),
        )
    };
    let run_by = if operator.is_named() {
        operator.linked_name()
    } else {
        "an operator it does not name".to_owned()
    };
    let body = format!(
        r#"
        <div class="card">
          <h1>Connect {platform}</h1>
          <p class="operator">Integration proxy <strong>{host}</strong>, run by {run_by}.</p>
          <p>Destination: <span class="email">{destination}</span></p>
          <p class="secret-help">Connecting lets this proxy use your {platform} account on your behalf. The destination finishes connecting by signing with your Atomic key; it becomes the connection's owner.</p>
          <form method="post" action="/connect/authorize">
            <input type="hidden" name="csrf" value="{csrf}" />
            {api_key_field}
            <button class="button" type="submit">{button_label}</button>
          </form>
        </div>
        <script>{script}</script>
        "#,
        script = CONSENT_SCRIPT,
        platform = escape(&platform_label(platform)),
        host = escape(&operator.host),
        destination = escape(destination),
        csrf = escape(csrf),
    );
    page(
        operator,
        &format!("Connect {}", platform_label(platform)),
        "",
        &body,
    )
}

/// The consent page's only script: it disables the approve button once the
/// form is submitted, so a double click cannot send a second approval that
/// would find the first one's single-use consent already spent. A page
/// restored from the back/forward cache gets its button back (approving
/// again then says it was already approved). The consent page's CSP allows
/// exactly this text by hash ([`consent_script_hash`]); nothing else runs.
pub(crate) const CONSENT_SCRIPT: &str = r#"(function(){var f=document.forms[0];if(!f)return;var b=f.querySelector('button[type="submit"]');f.addEventListener('submit',function(e){if(f.getAttribute('data-sent')){e.preventDefault();return;}f.setAttribute('data-sent','1');if(b)b.disabled=true;});window.addEventListener('pageshow',function(e){if(e.persisted){f.removeAttribute('data-sent');if(b)b.disabled=false;}});})();"#;

/// The CSP source (`'sha256-…'`) that allows [`CONSENT_SCRIPT`] and nothing
/// else.
pub(crate) fn consent_script_hash() -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use sha2::{Digest, Sha256};
    format!(
        "'sha256-{}'",
        STANDARD.encode(Sha256::digest(CONSENT_SCRIPT.as_bytes()))
    )
}

/// The page `POST /connect/authorize` answers for an OAuth platform: a
/// `<meta>` refresh to `authorization_url`, with the same address as a
/// button in case the browser does not follow refreshes.
///
/// It is a page rather than a `303` because a form submission's whole
/// redirect chain is held to the consent page's CSP `form-action`: a
/// provider whose authorization endpoint first redirects to another origin
/// of its own (an API host handing over to a separate sign-in host) would be
/// blocked there. A navigation this page starts is not a form submission, so
/// `form-action` does not govern it, and the proxy never needs to know which
/// origins a provider passes through.
pub fn render_oauth_continue(
    operator: &Operator,
    platform: &str,
    authorization_url: &str,
) -> String {
    let destination = url::Url::parse(authorization_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let head = format!(
        r#"<meta http-equiv="refresh" content="0;url={url}" />
  <meta name="referrer" content="no-referrer" />"#,
        url = escape(authorization_url),
    );
    let body = format!(
        r#"
        <div class="card">
          <h1>Continue to {platform}</h1>
          <p>Taking you to <strong>{destination}</strong> to authorize the connection.</p>
          <a class="button" href="{url}" rel="noreferrer">Continue to {platform}</a>
          <p class="secret-help">If nothing happens, use the button. Approving again on the previous page will not work: each approval is used once.</p>
        </div>
        "#,
        platform = escape(&platform_label(platform)),
        destination = escape(&destination),
        url = escape(authorization_url),
    );
    page(
        operator,
        &format!("Continue to {}", platform_label(platform)),
        &head,
        &body,
    )
}

fn platform_label(platform: &str) -> String {
    platform
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `head` is trusted, already-escaped markup for `<head>` (or empty).
fn page(operator: &Operator, heading: &str, head: &str, body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  {head}
  <title>{heading} · {host}</title>
  <link rel="icon" type="image/png" href="/logo.png" />
  <style>
    :root {{ color-scheme: light dark; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      margin: 0;
      background: #f5f5f7;
    }}
    .card {{
      background: white;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
      padding: 2.5rem;
      text-align: center;
      max-width: 24rem;
    }}
    .avatar {{
      width: 4rem;
      height: 4rem;
      border-radius: 50%;
      margin-bottom: 1rem;
    }}
    .email {{ color: #666; margin-top: -0.5rem; }}
    .secret-help {{ color: #666; font-size: 0.85rem; }}
    .operator {{ overflow-wrap: anywhere; }}
    .operator a {{ color: inherit; }}
    .button {{
      display: inline-block;
      margin-top: 1rem;
      padding: 0.6rem 1.4rem;
      background: #1a73e8;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      font-size: 1rem;
    }}
    .button-secondary {{ background: #5f6368; }}
    @media (prefers-color-scheme: dark) {{
      body {{ background: #202124; }}
      .card {{ background: #303134; color: #e8eaed; }}
      .email {{ color: #9aa0a6; }}
      .secret-help {{ color: #9aa0a6; }}
    }}
  </style>
</head>
<body>
  <main>
    <a href="/" aria-label="{title} home" style="display:block;text-align:center;margin-bottom:1rem"><img src="/logo.png" alt="" width="80" height="80" style="border-radius:8px" /></a>
    {body}
  </main>
</body>
</html>"#,
        heading = escape(heading),
        head = head,
        host = escape(&operator.host),
        title = operator.title(),
        body = body
    )
}

/// Escapes text for an HTML text node or a double- or single-quoted
/// attribute value.
fn escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unnamed() -> Operator {
        Operator::new(DEFAULT_OPERATOR_NAME, None, "proxy.example.org")
    }

    fn named() -> Operator {
        Operator::new(
            "Atomic Data",
            Some("https://atomic.place/"),
            "integrations.atomic.place",
        )
    }

    #[test]
    fn home_has_no_login() {
        for operator in [unnamed(), named()] {
            let html = render_home(&operator);
            assert!(!html.contains("/auth/login"));
            assert!(!html.contains("{{"));
            assert!(!html.contains("LocalThought"));
        }
    }

    #[test]
    fn home_names_the_operator_and_host() {
        let html = render_home(&named());
        assert!(html.contains("<title>Atomic Data · Connect your tools</title>"));
        assert!(html.contains(
            r#"<a class="brand" href="https://atomic.place/" rel="noopener noreferrer">Atomic Data</a>"#
        ));
        assert!(html.contains("Integrations · integrations.atomic.place"));
        assert!(html.contains(
            r#"It is run by <a href="https://atomic.place/" rel="noopener noreferrer">Atomic Data</a>."#
        ));
    }

    #[test]
    fn home_without_an_operator_name_stays_neutral() {
        let html = render_home(&unnamed());
        assert!(html.contains("<title>Integration proxy · Connect your tools</title>"));
        assert!(html.contains(r#"<a class="brand" href="/">Integration proxy</a>"#));
        assert!(html.contains("It is run by the operator of <strong>proxy.example.org</strong>."));
    }

    #[test]
    fn home_escapes_the_operator_name_url_and_host() {
        let html = render_home(&Operator::new(
            r#"<script>alert("x")</script> & {{host}}"#,
            Some(r#"https://evil.example/"><script>"#),
            "h<o>st",
        ));
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; {{host}}"));
        assert!(html.contains(r#"href="https://evil.example/&quot;&gt;&lt;script&gt;""#));
        assert!(html.contains("h&lt;o&gt;st"));
    }

    #[test]
    fn platform_connect_shows_one_selected_platform_and_escapes_fields() {
        let html = render_platform_connect(
            &unnamed(),
            "google-calendar",
            "https://hub.example/\"><script>alert(1)</script>",
            "csrf&<\"'",
            false,
        );
        assert!(html.contains("Google Calendar"));
        assert!(html
            .contains("Use this integration proxy to sync Google Calendar with this destination"));
        assert_eq!(html.matches(r#"action="/connect/authorize""#).count(), 1);
        assert!(html.contains("name=\"csrf\" value=\"csrf&amp;&lt;&quot;&#39;\""));
        assert!(!html.contains("<script>alert"));
        assert_eq!(html.matches("<script>").count(), 1, "only CONSENT_SCRIPT");
        assert!(!html.contains("api_key"));
        assert!(!html.contains("LocalThought"));
        assert!(!html.to_lowercase().contains("log in"));
    }

    #[test]
    fn consent_page_shows_the_proxy_host_and_operator() {
        let html = render_platform_connect(
            &named(),
            "google-calendar",
            "https://hub.example",
            "csrf",
            false,
        );
        assert!(html.contains("<title>Connect Google Calendar · integrations.atomic.place</title>"));
        assert!(html.contains(
            r#"Integration proxy <strong>integrations.atomic.place</strong>, run by <a href="https://atomic.place/" rel="noopener noreferrer">Atomic Data</a>."#
        ));
        assert!(html.contains("Use Atomic Data to sync Google Calendar with this destination"));
        assert!(html.contains(r#"aria-label="Atomic Data home""#));
    }

    #[test]
    fn consent_page_without_an_operator_name_still_shows_the_host() {
        let html =
            render_platform_connect(&unnamed(), "clockify", "https://hub.example", "csrf", true);
        assert!(html.contains(
            "Integration proxy <strong>proxy.example.org</strong>, run by an operator it does not name."
        ));
        assert!(html.contains(r#"aria-label="Integration proxy home""#));
    }

    #[test]
    fn consent_page_escapes_the_operator_name_url_and_host() {
        let html = render_platform_connect(
            &Operator::new(
                "Evil <img src=x onerror=alert(1)> 'Co'",
                Some(r#"https://evil.example/" onmouseover="alert(1)"#),
                r#"host"><script>"#,
            ),
            "google-calendar",
            "https://hub.example",
            "csrf",
            false,
        );
        assert_eq!(html.matches("<script>").count(), 1, "only CONSENT_SCRIPT");
        assert!(!html.contains(r#""><script>"#));
        assert!(!html.contains("<img src=x"));
        assert!(!html.contains(r#"" onmouseover="#));
        assert!(html.contains("Evil &lt;img src=x onerror=alert(1)&gt; &#39;Co&#39;"));
        assert!(html.contains(r#"href="https://evil.example/&quot; onmouseover=&quot;alert(1)""#));
        assert!(html.contains("<strong>host&quot;&gt;&lt;script&gt;</strong>"));
        assert!(
            html.contains("<title>Connect Google Calendar · host&quot;&gt;&lt;script&gt;</title>")
        );
    }

    #[test]
    fn api_key_platforms_ask_for_the_key_on_the_proxy_page() {
        let html =
            render_platform_connect(&unnamed(), "clockify", "https://hub.example", "csrf", true);
        assert!(html.contains(r#"name="api_key""#));
        assert!(html.contains("Connect Clockify"));
    }

    #[test]
    fn oauth_continue_page_refreshes_to_the_provider_and_links_it() {
        let url = "https://api.provider.example/v1/oauth/authorize?client_id=c&state=s&scope=a+b";
        let html = render_oauth_continue(&named(), "notion", url);
        let escaped =
            "https://api.provider.example/v1/oauth/authorize?client_id=c&amp;state=s&amp;scope=a+b";
        assert!(html.contains(&format!(
            r#"<meta http-equiv="refresh" content="0;url={escaped}" />"#
        )));
        assert!(html.contains(&format!(
            r#"<a class="button" href="{escaped}" rel="noreferrer">Continue to Notion</a>"#
        )));
        assert!(html.contains(r#"<meta name="referrer" content="no-referrer" />"#));
        assert!(html.contains("<strong>api.provider.example</strong>"));
        assert!(html.contains("<title>Continue to Notion · integrations.atomic.place</title>"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("<form"));
    }

    #[test]
    fn oauth_continue_page_escapes_the_address() {
        let html = render_oauth_continue(
            &unnamed(),
            "x",
            r#"https://auth.example/a?b="><script>alert(1)</script>"#,
        );
        assert!(!html.contains("<script"));
        assert!(html.contains("&quot;&gt;&lt;script&gt;"));
    }

    #[test]
    fn the_consent_script_hash_is_its_sha256() {
        // Independently of the helper: base64 of SHA-256 over the exact text.
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use sha2::{Digest, Sha256};
        let expected = STANDARD.encode(Sha256::digest(CONSENT_SCRIPT.as_bytes()));
        assert_eq!(consent_script_hash(), format!("'sha256-{expected}'"));
        let html =
            render_platform_connect(&unnamed(), "clockify", "https://hub.example", "csrf", true);
        assert!(html.contains(&format!("<script>{CONSENT_SCRIPT}</script>")));
    }

    #[test]
    fn fill_replaces_known_placeholders_once() {
        assert_eq!(
            fill("a {{x}} b {{y}} {{z", &[("x", "{{y}}"), ("y", "2")]),
            "a {{y}} b 2 {{z"
        );
    }
}
