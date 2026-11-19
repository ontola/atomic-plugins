# Atomic Education (learning)

The source of this drive app and of the three physics mini apps it bundles
(Lenzen, Magneten, Trillingen) lives in
[ontola/atomic-education](https://github.com/ontola/atomic-education) (`app/`,
`physics/`, `core/`). Only the integration stays here:

- the catalog entry `learning` in `integrations/catalog.json`;
- the built, immutable modules, `apps/learning/<version>/ui.js`, which GitHub
  Pages serves (atomic-education is private, so it cannot serve them);
- the host e2e specs in `e2e/` (`learning.spec.ts`, `mini-apps.spec.ts`), which
  test the published module through the catalog;
- the `learning` lane, which runs those specs.

A new version is released from atomic-education:
`npm run release -- <path-to-this-checkout>` builds the app, writes
`apps/learning/<version>/ui.js` and sets the entry's `version`, `app-module` and
`app-module-integrity`. `integrations/tooling/apps.mjs check` does not rebuild
this app (`EXTERNAL_APPS`): it checks that the committed module matches the
pinned integrity and that the URL is right.
