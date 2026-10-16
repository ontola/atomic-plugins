//! Composed-catalog fixtures (provenance in `tests/identity-catalog/sources.json`).
//!
//! These fixtures were pinned for the tenant-identity login that issue #54
//! removed. The identity operations they declare are no longer read; the
//! tests below keep asserting what the proxy still takes from them: the OAuth
//! provider and its scopes, composed from the real pinned sources.
use serde_json::json;

use crate::catalog::Catalog;

type MethodPath<'a> = (&'a str, &'a str);
type RouteSet<'a> = &'a [MethodPath<'a>];

fn catalog(platform: &str, source: &str, selection: serde_json::Value) -> Catalog {
    Catalog::from_test_document(platform, serde_yaml::from_str(source).unwrap(), selection)
}

#[test]
fn composed_google_calendar_keeps_its_data_scopes() {
    let catalog = catalog(
        "google-calendar",
        include_str!("../tests/identity-catalog/google-calendar-composed.yaml"),
        // A leftover `tenantIdentity` selection is ignored, not an error.
        json!({
            "oauthSecurityScheme": "googleOffline",
            "tenantIdentity": {"operationId": "getGoogleAuthenticatedPrincipal", "namespace": "https://accounts.google.com"}
        }),
    );
    let provider = catalog.oauth_provider("google-calendar").unwrap();
    assert_eq!(
        provider.scopes,
        vec![
            "email",
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/calendar.events",
            "openid",
            "profile"
        ]
    );
}

/// The calls atomic-plugins' Calendar drive app (integrations/calendar/app/)
/// makes through the host relay, exactly as it makes them, against the same
/// checked-in composed document. `If-Match` itself is not a catalog question:
/// `upstream_request` forwards it for every allowed operation.
#[test]
fn composed_google_calendar_permits_the_calendar_app_operations() {
    let catalog = catalog(
        "google-calendar",
        include_str!("../tests/identity-catalog/google-calendar-composed.yaml"),
        json!({"oauthSecurityScheme": "googleOffline"}),
    );
    let events = "/calendar/v3/calendars/synthetic%40example.com/events";
    let allowed = [
        (
            "GET",
            "/calendar/v3/users/me/calendarList".to_string(),
            "maxResults=250&pageToken=next",
            false,
        ),
        (
            "GET",
            events.to_string(),
            "singleEvents=false&showDeleted=true&maxResults=250&pageToken=next",
            false,
        ),
        ("GET", format!("{events}/timed"), "", false),
        ("PATCH", format!("{events}/timed"), "sendUpdates=all", true),
    ];
    for (method, path, query, body) in &allowed {
        let target = catalog
            .allows("google-calendar", method, path)
            .unwrap_or_else(|| panic!("{method} {path} must be allowed"));
        assert_eq!(target.as_str(), "https://www.googleapis.com/calendar/v3");
        assert_eq!(
            catalog.required_headers("google-calendar", method, path),
            Some(vec![]),
            "{method} {path}"
        );
        catalog
            .validate_request(
                "google-calendar",
                method,
                path,
                Some(query),
                body.then_some("application/json"),
                *body,
            )
            .unwrap_or_else(|err| panic!("{method} {path}?{query}: {err}"));
    }

    // The declared enum is enforced; the relay path keeps the server's base.
    assert_eq!(
        catalog.validate_request(
            "google-calendar",
            "PATCH",
            &format!("{events}/timed"),
            Some("sendUpdates=everyone"),
            Some("application/json"),
            true,
        ),
        Err("query parameter value is not permitted")
    );
    assert!(catalog
        .allows("google-calendar", "GET", "/calendars/primary/events")
        .is_none());
}

#[test]
fn composed_github_issues_requests_the_repo_scope() {
    let catalog = catalog(
        "github-issues",
        include_str!("../tests/identity-catalog/github-issues-composed.yaml"),
        json!({"oauthSecurityScheme": "githubOAuth"}),
    );
    let provider = catalog.oauth_provider("github-issues").unwrap();
    assert_eq!(provider.scopes, vec!["repo"]);
}

#[tokio::test]
#[ignore = "downloads the pinned OAD sources the published catalog composes"]
async fn published_catalog_still_loads_with_tenant_identity_selections_present() {
    let catalog = Catalog::load_checked_in(&crate::build_http_client())
        .await
        .expect("published catalog must load through the runtime loader");
    for platform in ["google-calendar", "github-issues"] {
        assert!(
            catalog.oauth_provider(platform).is_ok(),
            "{platform} must still compose an OAuth provider"
        );
    }
}

/// Load the real composed Asana/Airtable catalog through the proxy's catalog
/// loader and OAuth profile parser. By default this uses the checked-in dated
/// catalog with exact local overlay bytes and immutable remote OAD pins. Set
/// `ASANA_AIRTABLE_CATALOG_URL` to repeat the same check against published Pages.
#[tokio::test]
#[ignore = "downloads pinned OAD sources; set ASANA_AIRTABLE_CATALOG_URL for the Pages run"]
async fn asana_airtable_profiles_are_read_only_and_proxy_compatible() {
    let client = crate::build_http_client();
    let catalog = if let Ok(url) = std::env::var("ASANA_AIRTABLE_CATALOG_URL") {
        Catalog::load(&url, &client).await
    } else {
        Catalog::load_checked_in_file(&client, "catalog/2026-10-08-asana-airtable.json").await
    }
    .expect("catalog and its immutable OAD/overlay pins must load");

    for (platform, expected_scopes) in [
        (
            "asana",
            vec![
                "projects:read",
                "tasks:read",
                "users:read",
                "workspaces:read",
            ],
        ),
        ("airtable", vec!["data.records:read", "schema.bases:read"]),
    ] {
        let provider = catalog
            .oauth_provider(platform)
            .unwrap_or_else(|error| panic!("{platform} profile must parse: {error}"));
        assert_eq!(
            provider.scopes, expected_scopes,
            "{platform} minimum scopes"
        );
        assert!(provider.use_pkce, "{platform} must use S256 PKCE");

        let (reads, writes): (RouteSet<'_>, RouteSet<'_>) = match platform {
            "asana" => (
                &[
                    ("GET", "/api/1.0/workspaces"),
                    ("GET", "/api/1.0/workspaces/ws-1/projects"),
                    ("GET", "/api/1.0/projects/p-1/tasks"),
                    ("GET", "/api/1.0/users"),
                ],
                &[
                    ("POST", "/api/1.0/workspaces"),
                    ("POST", "/api/1.0/projects/p-1/tasks"),
                    ("PUT", "/api/1.0/tasks/t-1"),
                    ("DELETE", "/api/1.0/tasks/t-1"),
                ],
            ),
            "airtable" => (
                &[
                    ("GET", "/v0/meta/bases"),
                    ("GET", "/v0/meta/bases/base-1/tables"),
                    ("GET", "/v0/base-1/Tasks"),
                    ("GET", "/v0/base-1/Tasks/rec-1"),
                ],
                &[
                    ("POST", "/v0/base-1/Tasks"),
                    ("PATCH", "/v0/base-1/Tasks/rec-1"),
                    ("DELETE", "/v0/base-1/Tasks/rec-1"),
                ],
            ),
            _ => unreachable!(),
        };
        for (method, path) in reads {
            assert!(
                catalog.allows(platform, method, path).is_some(),
                "{platform} profile must permit {method} {path}"
            );
        }
        for (method, path) in writes {
            assert!(
                catalog.allows(platform, method, path).is_none(),
                "{platform} profile must refuse {method} {path}"
            );
        }
    }

    // Exercise the proxy's configured-provider parser against both client
    // authentication methods Airtable advertises, using disposable test values.
    let names = [
        "OAUTH_AIRTABLE_CLIENT_ID",
        "OAUTH_AIRTABLE_CLIENT_SECRET",
        "OAUTH_AIRTABLE_CLIENT_AUTH_METHOD",
    ];
    let previous: Vec<_> = names.iter().map(std::env::var_os).collect();
    std::env::set_var(names[0], "runtime-test-client");
    std::env::set_var(names[1], "runtime-test-secret");
    for method in ["client_secret_basic", "none"] {
        std::env::set_var(names[2], method);
        let configured = crate::providers::Provider::configured(&catalog, "airtable")
            .unwrap_or_else(|error| panic!("Airtable {method} must parse: {error}"));
        match method {
            "client_secret_basic" => assert_eq!(
                configured.client_auth,
                crate::providers::ClientAuth::SecretBasic
            ),
            "none" => assert_eq!(configured.client_auth, crate::providers::ClientAuth::None),
            _ => unreachable!(),
        }
    }
    for (key, value) in names.iter().zip(previous) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}

/// Load the candidate GitLab catalog through the proxy's real composition and
/// OAuth profile parser. This downloads its immutable OAD pin; set
/// GITLAB_CATALOG_URL after Pages publication to check the public copy.
#[tokio::test]
#[ignore = "downloads the pinned GitLab OAD sources; set GITLAB_CATALOG_URL for the Pages run"]
async fn gitlab_readonly_profile_is_scoped_and_proxy_compatible() {
    let client = crate::build_http_client();
    let catalog = if let Ok(url) = std::env::var("GITLAB_CATALOG_URL") {
        Catalog::load(&url, &client).await
    } else {
        Catalog::load_checked_in_file(&client, "catalog/2026-10-08-gitlab.json").await
    }
    .expect("GitLab catalog and its immutable OAD/overlay pins must load");

    let provider = catalog
        .oauth_provider("gitlab")
        .unwrap_or_else(|error| panic!("GitLab read-only profile must parse: {error}"));
    assert_eq!(provider.scopes, vec!["read_api"]);
    assert!(
        provider.use_pkce,
        "GitLab profile should use supported S256 PKCE"
    );

    for path in [
        "/api/v4/projects",
        "/api/v4/projects/41",
        "/api/v4/projects/41/issues",
        "/api/v4/projects/41/issues/2",
    ] {
        assert!(
            catalog.allows("gitlab", "GET", path).is_some(),
            "read_api profile must allow GET {path}"
        );
    }
    assert!(catalog
        .allows("gitlab", "POST", "/api/v4/projects")
        .is_none());
    assert!(catalog.allows("gitlab", "GET", "/api/v4/users").is_none());
    catalog
        .validate_request(
            "gitlab",
            "GET",
            "/api/v4/projects",
            Some("membership=true&per_page=100&page=2"),
            None,
            false,
        )
        .expect("the selected collection filters and pagination inputs must parse");
}

/// Parse the Google Tasks read-only profile from the unpublished combined
/// candidate catalog. Set GITLAB_TASKS_CATALOG_URL after Pages publication to
/// exercise the public copy.
#[tokio::test]
#[ignore = "downloads the pinned candidate OAD sources; set GITLAB_TASKS_CATALOG_URL for the Pages run"]
async fn google_tasks_readonly_profile_is_scoped_and_proxy_compatible() {
    let client = crate::build_http_client();
    let catalog = if let Ok(url) = std::env::var("GITLAB_TASKS_CATALOG_URL") {
        Catalog::load(&url, &client).await
    } else {
        Catalog::load_checked_in_file(&client, "catalog/2026-10-08-gitlab-tasks.json").await
    }
    .expect("combined candidate catalog and its immutable OAD/overlay pins must load");

    let provider = catalog
        .oauth_provider("google-tasks")
        .unwrap_or_else(|error| panic!("Google Tasks read-only profile must parse: {error}"));
    assert_eq!(
        provider.scopes,
        vec!["https://www.googleapis.com/auth/tasks.readonly"]
    );
    assert!(
        provider.use_pkce,
        "Google Tasks profile should use S256 PKCE"
    );

    for path in [
        "/tasks/v1/users/@me/lists",
        "/tasks/v1/lists/list-1/tasks",
        "/tasks/v1/lists/list-1/tasks/task-1",
    ] {
        assert!(
            catalog.allows("google-tasks", "GET", path).is_some(),
            "read-only profile must allow GET {path}"
        );
    }
    assert!(catalog
        .allows("google-tasks", "POST", "/tasks/v1/lists/list-1/tasks")
        .is_none());
    assert!(catalog
        .allows(
            "google-tasks",
            "PATCH",
            "/tasks/v1/lists/list-1/tasks/task-1"
        )
        .is_none());
    assert!(catalog
        .allows(
            "google-tasks",
            "DELETE",
            "/tasks/v1/lists/list-1/tasks/task-1"
        )
        .is_none());
}
