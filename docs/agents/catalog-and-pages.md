# Catalog and Pages

## Pages is production

GitHub Pages publishes this repository's `main` from its root. A merge to
`main` changes, with no deploy step:

- `integrations/catalog.json`, the plugin catalog atomic-server hosts read
  (`https://ontola.github.io/atomic-plugins/integrations/catalog.json`);
- `apps/<id>/<version>/ui.js`, the drive app modules that catalog installs;
- `overlays/catalog/2026-10-02.json` and the overlays, which the integration proxy
  composes when it starts (localthought.io reads it on restart; see
  [proxy-release.md](proxy-release.md));
- `ontology/`, the shared class terms.

So treat every merge as a release.

## New catalog entries stay disabled

Every new entry in `integrations/catalog.json` gets `enabled: false`. On
2026-09-30 only `pets` is enabled. Entries that use the shared ontology must
stay disabled while its base is on github.io, which
`node ontology-kit/ontology.mjs check` enforces. Enabling an entry is a
product decision for Michiel (via the coordinator's inbox).

## Changing a drive app

The published and the user-testing catalogs version apps separately. For any
change to an app's source:

1. **Published catalog.** Bump the version in
   `integrations/<id>/package.json` and its `catalog.json` entry, then
   `node integrations/tooling/apps.mjs write <id>` and
   `node integrations/tooling/apps.mjs check --published origin/main`
   ([Publishing a drive app](../../integrations/README.md#publishing-a-drive-app)).
   A file under `apps/` that is on `main` is never changed or deleted.
2. **User-testing catalog.** Bump the app's entry in `VERSIONS` in
   `usertest/catalog.mjs`. Otherwise the droplet serves new bytes under an
   old version, and installed apps fail the host's integrity check.

## The byte-for-byte checks

- `apps.mjs check` rebuilds each app and compares it with the committed
  `apps/<id>/<version>/ui.js`, and its sha384 with `app-module-integrity`. A
  pin bump that changes esbuild's output makes this fail; the fix is a new
  version.
- `usertest/check-live.mjs` compares the catalog `usertest/catalog.mjs` just
  built with the droplet's live one:

  ```sh
  USERTEST_LOG_URL=https://logs.178-62-223-35.sslip.io/log node usertest/catalog.mjs
  node usertest/check-live.mjs https://catalog.178-62-223-35.sslip.io/catalog.json
  ```

  It exits 1, naming the apps, when an app was rebuilt into a version the
  droplet already serves with other bytes: bump its `VERSIONS` entry. An
  unreachable live catalog passes. `usertest-deploy.yml` runs it before it
  touches the droplet.
