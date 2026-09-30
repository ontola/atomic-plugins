# Releasing the integration proxy (localthought.io)

`integration-proxy/` is the `atomic-integration-proxy` crate. localthought.io
runs it on Heroku through a small wrapper crate in a separate repository,
`localthought/integration-proxy` (template:
[`integration-proxy/examples/heroku-wrapper/`](../../integration-proxy/examples/heroku-wrapper/)).
On 2026-09-30 localthought.io ran 0.2.3 (Heroku release v81), from the
hand-over; not verified from here.

**Publishing a crate version and deploying to Heroku each need Michiel's OK,
per release** (#227 rule 10). The PRs leading up to them don't.

## Steps

1. **Release PR in this repo.** Set `version` in
   `integration-proxy/Cargo.toml` and give the release its heading in
   `integration-proxy/CHANGELOG.md`. (On 2026-09-30 the CHANGELOG still says
   "0.2.3 (unreleased)" although 0.2.3 was published; fix that in the next
   release PR.) Merge under rule 12.
2. **Publish** (Michiel's OK). Tag the merge commit on `main`:

   ```sh
   git tag integration-proxy-vX.Y.Z <sha> && git push origin integration-proxy-vX.Y.Z
   ```

   `.github/workflows/integration-proxy-publish.yml` fails unless the tag
   equals `Cargo.toml`'s version, then publishes to crates.io with Trusted
   Publishing (OIDC; no token is stored). A crates.io version is permanent.
3. **Wrapper PR** in `localthought/integration-proxy`: bump the crate in its
   `Cargo.toml` and `Cargo.lock`. Merge it.
4. **Deploy** (Michiel's OK). Heroku's GitHub auto-deploy doesn't fire, so
   push the wrapper's merged commit to the Heroku remote by hand, from a
   checkout with Heroku access to the app `integration-proxy`:

   ```sh
   git push https://git.heroku.com/integration-proxy.git <sha>:refs/heads/main
   heroku logs -a integration-proxy -n 200
   ```

Cloud sessions had no Heroku access on 2026-09-30; hand steps 2 and 4 to
Michiel on [#227](https://github.com/ontola/atomic-plugins/issues/227).

## The proxy's catalog

The proxy reads its platform catalog (`overlays/catalog.json` on `main`)
when it starts, so a catalog change reaches localthought.io at its next
restart or deploy, with no release. The hand-over names the URL it reads as
`raw.githubusercontent.com/ontola/atomic-plugins/refs/heads/main/overlays/catalog.json`;
the crate's default is the Pages URL. Which one the Heroku config sets is not
verified.
