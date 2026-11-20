//! State-free work-account help, rendered only from trusted provider metadata.
use crate::{connect::protected, providers::Provider, templates, AppState};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{Html, Response},
};

pub async fn page(State(state): State<AppState>, Path(platform): Path<String>) -> Response {
    let Ok(provider) = Provider::configured(&state.catalog, &platform) else {
        return protected((
            StatusCode::NOT_FOUND,
            "Authorization help is not available for this provider",
        ));
    };
    if provider.provider.authorization_help.is_none() {
        return protected((
            StatusCode::NOT_FOUND,
            "Authorization help is not available for this provider",
        ));
    }
    let mut response = protected(Html(templates::render_authorization_help(
        &state.operator,
        &platform,
        &provider.provider,
        &provider.client_id,
        &state.public_origin,
    )));
    let base = response.headers()["content-security-policy"]
        .to_str()
        .unwrap();
    let policy = format!(
        "{base}; script-src {}; form-action 'none'",
        templates::admin_copy_script_hash()
    );
    response
        .headers_mut()
        .insert("content-security-policy", policy.parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use serde_json::json;
    use tower::ServiceExt;

    fn document() -> serde_json::Value {
        json!({
            "components": {
                "securitySchemes": {
                    "selected": {
                        "type": "oauth2",
                        "x-oauth-authorization-help": {
                            "summary": "Work accounts may need approval <before> connecting.",
                            "adminApproval": {
                                "description": "Ask an admin to review this OAuth client. </textarea><script>bad()</script>",
                                "documentationUrl": "https://provider.example/admin?one=1&two=2"
                            }
                        },
                        "flows": { "authorizationCode": {
                            "authorizationUrl": "https://provider.example/authorize",
                            "tokenUrl": "https://provider.example/token",
                            "scopes": {"records.read": "Read records", "records.write": "Permanently delete records", "unused": "Unused permission"}
                        }}
                    },
                    "other": {
                        "type": "oauth2",
                        "x-oauth-authorization-help": {"summary": "Wrong scheme help"},
                        "flows": {"authorizationCode": {
                            "authorizationUrl": "https://other.example/authorize",
                            "tokenUrl": "https://other.example/token",
                            "scopes": {"other": "Other permission"}
                        }}
                    }
                },
                "x-authentication-profiles": {"chosen": {"securityScheme": "selected"}}
            },
            "paths": {"/records": {"get": {"security": [{"selected": ["records.read"]}]}, "delete": {"security": [{"selected": ["records.write"]}]}}}
        })
    }

    fn state() -> AppState {
        let mut state = crate::test_support::state(None);
        state.catalog = crate::catalog::Catalog::from_test_document(
            "github-issues",
            document(),
            json!({"authenticationProfile": "chosen"}),
        );
        state
    }

    async fn get(state: AppState, uri: &str) -> Response {
        crate::router(state)
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn reusable_help_needs_no_cookie_database_or_attempt_and_exposes_only_public_details() {
        let state = state();
        let configured = Provider::configured(&state.catalog, "github-issues")
            .expect("fixture OAuth credentials");
        let response = get(
            state,
            "/oauth/help/github-issues?state=attempt-private&code=secret-code&email=person-private",
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert!(csp.contains(&templates::admin_copy_script_hash()));
        assert!(csp.contains("form-action 'none'"));
        let html = String::from_utf8(
            to_bytes(response.into_body(), 65536)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        for expected in [
            configured.client_id.as_str(),
            "records.read: Read records",
            "records.write: Permanently delete records",
            "Start a new connection",
            "readonly",
            "role=\"status\"",
        ] {
            assert!(html.contains(expected), "missing {expected}");
        }
        for secret in [
            configured.client_secret.as_str(),
            "attempt-private",
            "secret-code",
            "person-private",
            "Unused permission",
            "Wrong scheme help",
            "<script>bad()",
            "<form",
        ] {
            assert!(!html.contains(secret), "unexpected {secret}");
        }
        assert!(html.contains("&lt;/textarea&gt;&lt;script&gt;bad()&lt;/script&gt;"));
        assert!(html.contains("https://provider.example/admin?one=1&amp;two=2"));
        assert_eq!(html.matches("<script>").count(), 1);
    }

    #[tokio::test]
    async fn consent_explains_requirements_before_starting_provider_authorization() {
        let challenge = crate::connect::pkce_challenge(&"a".repeat(43)).unwrap();
        let uri = format!("/connect?platform=github-issues&redirect_uri=http%3A%2F%2F127.0.0.1%3A48889%2Fcallback&code_challenge={challenge}&code_challenge_method=S256");
        let response = get(state(), &uri).await;
        assert_eq!(response.status(), StatusCode::OK);
        let html = String::from_utf8(
            to_bytes(response.into_body(), 65536)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(html.contains("Work accounts may need approval &lt;before&gt; connecting."));
        assert!(html.contains(
            "href=\"/oauth/help/github-issues\" target=\"_blank\" rel=\"noopener noreferrer\""
        ));
        assert!(!html.contains("provider.example/authorize"));
        assert!(html.contains("action=\"/connect/authorize\""));
    }

    #[tokio::test]
    async fn unavailable_or_undeclared_help_is_not_found() {
        for (state, uri) in [
            (state(), "/oauth/help/missing"),
            (
                crate::test_support::state(None),
                "/oauth/help/github-issues",
            ),
        ] {
            assert_eq!(get(state, uri).await.status(), StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn help_metadata_is_validated_and_never_adds_permissions() {
        let doc = document();
        let provider = Provider::from_document(&doc, Some("selected")).unwrap();
        assert_eq!(provider.scopes, ["records.read", "records.write"]);
        assert!(!provider.scope_descriptions.contains_key("unused"));
        let pointer = "/components/securitySchemes/selected/x-oauth-authorization-help";
        for invalid in [
            json!(null),
            json!({"summary": " "}),
            json!({"summary": "Info", "unexpected": true}),
            json!({"summary": "Info", "adminApproval": {"description": "Review", "documentationUrl": "javascript:alert(1)"}}),
            json!({"summary": "Info", "adminApproval": {"description": "Review", "documentationUrl": "https://user:password@provider.example/admin"}}),
            json!({"summary": "Info", "adminApproval": {"description": "Review", "documentationUrl": "https://provider.example/admin#fragment"}}),
            json!({"summary": "Info", "adminApproval": {"description": "Review", "documentationUrl": "http://provider.example/admin"}}),
            json!({"summary": "Info", "adminApproval": {"description": "", "documentationUrl": "https://provider.example/admin"}}),
            json!({"summary": "Info", "adminApproval": {"description": "Review", "documentationUrl": "https://provider.example/admin", "scopes": ["extra"]}}),
        ] {
            let mut bad = doc.clone();
            *bad.pointer_mut(pointer).unwrap() = invalid.clone();
            assert!(
                Provider::from_document(&bad, Some("selected")).is_err(),
                "accepted {invalid}"
            );
        }
        let mut summary_only = doc;
        *summary_only.pointer_mut(pointer).unwrap() = json!({"summary": "Info"});
        let provider = Provider::from_document(&summary_only, Some("selected")).unwrap();
        let html = templates::render_authorization_help(
            &state().operator,
            "example",
            &provider,
            "public-client",
            "https://proxy.example",
        );
        assert!(!html.contains("admin-request"));
        assert!(html.contains("After approval"));
    }
}
