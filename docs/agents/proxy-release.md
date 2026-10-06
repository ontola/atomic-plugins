# Releasing the integration proxy (localthought.io)

`integration-proxy/` is the `atomic-integration-proxy` crate. localthought.io
runs it on Heroku through a small wrapper crate in a separate repository,
`localthought/integration-proxy` (template:
[`integration-proxy/examples/heroku-wrapper/`](../../integration-proxy/examples/heroku-wrapper/)).
On 2026-10-06 localthought.io was verified running proxy 0.2.5, deployed
through wrapper PR
[localthought/integration-proxy#82](https://github.com/localthought/integration-proxy/pull/82)
(merge commit `625948c`) as Heroku release v86. `CATALOG_PATH` was then
switched to the auth-profiles catalog in release v87, the current one. Before
that, 0.2.4 ran as v84, with the dated catalog selected in v85.

**Publishing a crate version and deploying to Heroku each need Michiel's OK,
per release** (#227 rule 10). The PRs leading up to them don't.

## Steps

1. **Release PR in this repo.** Set `version` in
   `integration-proxy/Cargo.toml` and give the release its heading in
   `integration-proxy/CHANGELOG.md`. Merge under rule 12.
2. **Publish** (Michiel's OK). Tag the merge commit on `main`:

   ```sh
   git tag integration-proxy-vX.Y.Z <sha> && git push origin integration-proxy-vX.Y.Z
   ```

   `.github/workflows/integration-proxy-publish.yml` fails unless the tag
   equals `Cargo.toml`'s version, then publishes to crates.io with Trusted
   Publishing (OIDC; no token is stored). A crates.io version is permanent.
3. **Wrapper PR** in `localthought/integration-proxy`: bump the crate in its
   `Cargo.toml` and `Cargo.lock`. Merge it.
   **The first release with the key-check limit (#340, Q-097)** also needs
   `TRUST_FORWARDED_FOR=heroku` on the app before or with that deploy
   (`heroku config:set TRUST_FORWARDED_FOR=heroku -a integration-proxy`,
   Michiel's OK). Without it every client shares the router's limit of 20
   key checks per platform per hour; the proxy logs a warning at startup
   when Heroku's `DYNO` is set without it. Check for that line in
   `heroku logs` after the deploy.
4. **Deploy** (Michiel's OK). Merging the wrapper PR auto-deploys it: for
   0.2.5 the merge of #82 produced release v86 with no manual push. Check
   that a release exists for the merged commit (`heroku releases -a
   integration-proxy`). Only if none appears, push that commit to the Heroku
   remote by hand, from a checkout with Heroku access to the app `integration-proxy`:

   ```sh
   git push https://git.heroku.com/integration-proxy.git <sha>:refs/heads/main
   heroku logs -a integration-proxy -n 200
   ```

Cloud sessions had no Heroku access on 2026-09-30; hand steps 2 and 4 to
Michiel on [#227](https://github.com/ontola/atomic-plugins/issues/227). On
claude-build the Heroku CLI is installed at `~/.local/bin/heroku`; a session
uses it only with Michiel's per-release OK, and never reads config values.

## The proxy's catalog

The proxy reads its platform catalog once at startup. Release 0.2.5 defaults
to `https://ontola.github.io/atomic-plugins/overlays/catalog/2026-10-02-auth-profiles.json`
(0.2.4 defaulted to `.../catalog/2026-10-02.json`).
Dated catalogs and OAD-revision overlay filenames are immutable; publish new
files and explicitly switch the default or `CATALOG_PATH` to opt in.

On 2026-10-02, before this rollout, Heroku's `CATALOG_PATH` was verified as
`https://raw.githubusercontent.com/ontola/atomic-plugins/refs/heads/main/overlays/catalog.json`
and its current release was v82, deploying wrapper commit `e31b4f2d`.
After proxy 0.2.4 was published to crates.io and wrapper PR
[localthought/integration-proxy#81](https://github.com/localthought/integration-proxy/pull/81)
merged, Heroku deployed that wrapper as v84. The authorized catalog switch
created release v85:

```sh
heroku config:set CATALOG_PATH=https://ontola.github.io/atomic-plugins/overlays/catalog/2026-10-02.json -a integration-proxy
```

The running web dyno was up, `/catalog` listed nine platforms, and
`/catalog/discord.yaml` changed from two paths to 153. With that switch
verified, the deprecated `overlays/catalog.json` was removed. Published
overlay revision files remain immutable. The full Discord document composes,
but its mixed bot-token/OAuth connection support awaits
[atomic-plugins#258](https://github.com/ontola/atomic-plugins/issues/258).

#258 (released in 0.2.5) adds authentication profiles and the catalog
`overlays/catalog/2026-10-02-auth-profiles.json`, which selects Discord's
user profile and is 0.2.5's default. On 2026-10-06, after 0.2.5 was deployed
(v86), the authorized catalog switch created release v87:

```sh
heroku config:set CATALOG_PATH=https://ontola.github.io/atomic-plugins/overlays/catalog/2026-10-02-auth-profiles.json -a integration-proxy
```

Afterwards `/healthz` answered 200, `/catalog` listed nine platforms
(including `discord` and `notion`), and `/catalog/discord.yaml` carried the
user and guild resources of the `discordUser` profile. Discord has not been
checked with a live account.
