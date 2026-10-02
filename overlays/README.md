# overlays
OpenAPI Overlay files that complete existing OpenAPI files with Pagination Schemes and other additions

## Where this lives and how it is published

This folder was migrated from the standalone `localthought/overlays`
repository (full history via `git subtree`, from its `main` plus its
`calendar-events-write-back-prod` branch, which the integration proxy's
production catalog pinned). Author new overlays here, not there.

GitHub Pages publishes this repository's `main` from its root (legacy
build; the root `.nojekyll` makes it serve every file byte-for-byte), so
any file `overlays/<path>` is served at:

```
https://ontola.github.io/atomic-plugins/overlays/<path>
```

`catalog/2026-10-02.json` lists each platform's overlays by those URLs, and the
integration proxy's default `CATALOG_PATH` is
`https://ontola.github.io/atomic-plugins/overlays/catalog/2026-10-02.json`. Before this
migration every overlay URL was pinned to a `localthought/overlays` commit
on `raw.githubusercontent.com`; the Pages URLs are not pinned, so a merge
to `main` changes what the proxy composes at its next start. The OAD
(`openapi`) URLs and every overlay's standard `extends` field pin the same
`ontola/openapi-directory` document at the full commit SHA that last changed
that file, rather than a later unrelated repository commit.

The unversioned `catalog.json` was removed after localthought.io switched to
this dated catalog on 2026-10-02 (Heroku release v85, wrapper commit
`1f89c7efb25f6fd0f7394997e69ed738fd1a4aad`, proxy 0.2.4). Its live Discord
document changed from two paths to 153, confirming the catalog switch.
Historical overlay revisions remain published, including Discord's two-read
subset and Clockify's older revision; existing revision URLs stay valid.

Dated catalogs and their selected revision files are immutable once on
`main`; publish a new dated catalog and update the proxy's default or its
`CATALOG_PATH` to opt in. New overlays do not change an existing catalog.
The 2026-10-02 catalog selects the full Discord OAD and its existing two-read
CRUD metadata. The proxy currently refuses the OAD's mixed OAuth/bot-token
security schemes, so Discord connection support awaits a separate auth
[follow-up #258](https://github.com/ontola/atomic-plugins/issues/258); successful composition does not certify that connection flow.

## Directory layout and OAD revisions

Provider overlays mirror `openapi-directory` including its `APIs/` prefix:

```
openapi-directory/APIs/<provider>/<service-if-any>/<version>/openapi.yaml
overlays/APIs/<provider>/<service-if-any>/<version>/<kind>-<oad-commit>-overlay.yaml
```

Use `swagger.yaml` in `extends` where that is the OAD's actual filename.
`<oad-commit>` is the full 40-character SHA of the OAD's last change.
For example, Calendar's auth and pagination overlays for one OAD are:

```
APIs/googleapis.com/calendar/v3/auth-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml
APIs/googleapis.com/calendar/v3/app-pagination-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml
```

Several overlay kinds can target one OAD revision, and several OAD revisions
can coexist in that same folder. A new OAD revision gets new filenames;
retain the files for old revisions. Published revision files are immutable;
CI compares them with `origin/main`. To revise an overlay for an unchanged
OAD, give its kind a new version, e.g. `auth-v2-<oad-commit>-overlay.yaml`.
Adding a file never changes the catalog's existing selections: publish a new dated catalog explicitly when opting a platform into a new revision. `extends` identifies the original OAD
even when the overlay depends on earlier overlays in the catalog's ordered
composition. Calendar's `app-pagination` and `app-crud-causality` variants
preserve the drive app's scope alongside the broader `pagination` and
`crud-causality` overlays for that same document.

The 390 initial current-revision pins use the directory's `main` snapshot
`b285200684e2b0460faf8464c8822b4d2516e3c7` (2026-10-02).
The old provider paths were moved, so direct consumers must use the new
URLs; this repository's catalog and file references are updated together.
The Pets demo, docs, scripts and tests are outside `APIs/`: the demo is a
complete local OAD with no overlays, and the others are authoring resources.

Validate paths, filenames and catalog selections from the repository root:

```sh
python3 overlays/scripts/validate_oad_pins.py --published origin/main
python3 overlays/tests/test_oad_pins.py
```

Validate the commits against a full-history OAD checkout as well:

```sh
git -C /path/to/openapi-directory fetch --unshallow origin main # only if shallow
python3 overlays/scripts/validate_oad_pins.py --directory /path/to/openapi-directory
```

Add `--fetch-missing` to fetch historical pins absent from current upstream
`main` (historical Discord and Clockify revisions remain published).

The history check accepts old revisions but rejects a pin at a commit that
did not change the OAD. For an audit requiring every overlay to target the
latest OAD at a particular ref, add `--latest-ref origin/main`. That audit
will intentionally fail once historical and current revisions coexist.
These checks establish target provenance, not live-provider compatibility.

Overlays are applied in the order `catalog/2026-10-02.json` lists them, and an action
whose target does not exist yet fails the whole catalog load. Clockify's
`crud-causality-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml` is listed first because it defines the
projects/users paths its auth and pagination overlays target, and the
two setup reads the timesheets app makes (`GET /v1/user`, `GET
/v1/workspaces`); those stay in the read overlays. Its
`time-entry-write-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml` is listed last and carries its own
`security`, so removing that one line returns Clockify to read-only; it adds
create (`POST`), full-replacement update (`PUT`) and delete on time entries
for the timesheets app's two-way sync (ontola/atomic-plugins#123). Its
request shapes follow Clockify's published reference and are not verified
against a live account.

GitHub Issues' `repositories-read-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml` comes right after its
pagination overlay, whose `nextLink` scheme it names, and carries its own
`security`: it adds `GET /user/repos`, the issue-tracker drive app's
repository picker (ontola/atomic-plugins#147), as a plain read, not a
`crudResources` collection. The same app's two label writes, adding one
label to an issue (`POST .../issues/{issue_number}/labels`) and removing one
(`DELETE .../labels/{name}`), are in `crud-causality-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml` as partial
updates of `issue`; there is no endpoint that replaces or lists an issue's
labels. All three use the `repo` scope the GitHub OAuth app already asks
for, which covers issue labels and private repositories, so the requested
scope is unchanged. Their shapes follow GitHub's REST reference and are not
verified against a live account.

The `pets` platform (ontola/atomic-plugins#174) is different: there is no
third-party API behind it. `pets-demo/1.0.0/openapi.json` is its whole
document, authored here rather than pinned from `openapi-directory`, so it
has no overlays. Its server is
`https://ontola.github.io/atomic-plugins/overlays/pets-demo/1.0.0/api`, and
the one operation it declares, `GET /pets`, is the static file
`pets-demo/1.0.0/api/pets` (five synthetic pets, one page, no `Link`
header; Pages serves it as `application/octet-stream`). It declares
top-level `security: []` and no security scheme, which
`atomic-integration-proxy` 0.2.3 and later connect without a credential;
0.2.2 and earlier list the platform but refuse to connect it. The Pets drive app
bundles the same document (`integrations/pets/app/openapi.json`). A change
to either the document or the data is a change to what live users of the
demo read, so give it a new version folder rather than editing `1.0.0` in
place.

Checks:

- `.github/workflows/overlays-ci.yml` (PRs): all overlay paths, revision
  filenames and `extends` commits pass the full-history check; every catalog overlay URL, and
  every OAD URL under the Pages base, maps to a file in this folder, and the
  tests below pass (`tests/test_identity_overlays.py` also checks the pets
  demo's document and data). It reads the
  Pages-published sources from the checkout, so it validates a change before
  Pages serves it.
- `integration-proxy`'s `default_catalog_*` tests (PRs touching this folder):
  compose the selected dated catalog with the proxy's runtime loader, reading
  overlays from this folder.
- `.github/workflows/overlays-published.yml` (after each Pages build): the
  served dated catalogs, every overlay and Pages-published OAD they list, and
  the pets demo's data match the built commit.

## Authenticated principal overlays

The Google Calendar and GitHub Issues identity overlays add a current-principal
operation without making it a collection or assigning CRUD metadata. The
catalog is the trusted identity selection and associates it with its ordinary
OAuth scheme. Google uses either `googleOnline` or `googleOffline`; GitHub
uses `githubOAuth`. Before rollout, an operator upgrading an existing
Google-login deployment explicitly sets
`APP_AUTH_IDENTITY_NAMESPACE=https://accounts.google.com` to retain the prior
tenant mapping. This is operator-only configuration; there is no default and
callers cannot choose an identity namespace.

For example, the Google Calendar catalog entry selects:

```json
{
  "oauthSecurityScheme": "googleOffline",
  "tenantIdentity": {
    "operationId": "getGoogleAuthenticatedPrincipal",
    "namespace": "https://accounts.google.com"
  }
}
```

GitHub uses `githubOAuth`, `getGitHubAuthenticatedPrincipal`, and
`https://github.com`. Merely adding the extension to an OpenAPI document does
not enable tenant login; the trusted catalog must select the operation.

Google's overlay is applied after its auth overlay because it adds `openid`,
`email`, and `profile` to both `googleOnline` and `googleOffline`. GitHub's
overlay is also applied after `auth-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml`, which declares `githubOAuth`.
The overlays only describe the provider endpoints and response metadata; the
runtime supplies its normal User-Agent header and bearer token.

The Google declaration follows its [OpenID Connect discovery and UserInfo
reference](https://developers.google.com/identity/openid-connect/reference).
The GitHub declaration follows the [authenticated-user endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
and GitHub's [durable numeric-ID guidance](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app).

Validate the full catalog compositions, from this folder, with
`python tests/test_identity_overlays.py` after installing
`requirements-identity-tests.txt`. Generate proxy regression fixtures with
`python tests/generate_identity_catalog_fixtures.py --output <fixture-directory>`;
the generated `sources.json` records the source URLs and content hashes.
Both read overlays under the Pages URL from this checkout and download only
the pinned OADs.
