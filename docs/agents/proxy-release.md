# Releasing the integration proxy (localthought.io)

`integration-proxy/` is the `atomic-integration-proxy` crate. localthought.io
runs it on Heroku through a small wrapper crate in a separate repository,
`localthought/integration-proxy` (template:
[`integration-proxy/examples/heroku-wrapper/`](../../integration-proxy/examples/heroku-wrapper/)).
On 2026-10-02 localthought.io was verified running proxy 0.2.4 through
wrapper commit `1f89c7efb25f6fd0f7394997e69ed738fd1a4aad` (deployment v84),
with the dated catalog selected in Heroku release v85.

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
4. **Deploy** (Michiel's OK). Check whether GitHub auto-deploy has produced
   a release for the merged commit; if it has not, push that commit to the
   Heroku remote by hand, from a checkout with Heroku access to the app `integration-proxy`:

   ```sh
   git push https://git.heroku.com/integration-proxy.git <sha>:refs/heads/main
   heroku logs -a integration-proxy -n 200
   ```

Cloud sessions had no Heroku access on 2026-09-30; hand steps 2 and 4 to
Michiel on [#227](https://github.com/ontola/atomic-plugins/issues/227).

## The proxy's catalog

The proxy reads its platform catalog once at startup. Release 0.2.4 defaults
to `https://ontola.github.io/atomic-plugins/overlays/catalog/2026-10-02.json`.
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

#258 (unreleased) adds authentication profiles and the catalog
`overlays/catalog/2026-10-02-auth-profiles.json`, which selects Discord's
user profile and becomes the next release's default. Discord connects only
once both are live: a release with profile support, and Heroku's explicit
`CATALOG_PATH` switched to the new catalog (or unset). 0.2.4 can load the new
catalog and keeps refusing Discord on it. Both steps need Michiel's OK.
