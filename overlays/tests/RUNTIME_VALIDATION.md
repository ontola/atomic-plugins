# Asana and Airtable runtime validation

These checks compose the dated catalog's exact OAD pins and overlay order,
then exercise Syncables and the integration proxy. Synthetic responses are
used; they make no provider API calls and use no credentials.

From the `atomic-plugins` checkout, install the locked Syncables dependencies,
build the browser entry point, and run its actual reader:

```sh
npm ci --prefix syncables --ignore-scripts
npm run build --prefix syncables
node overlays/tests/runtime_asana_airtable.mjs
```

The Node harness reads the local dated catalog and pinned OAD documents from
the sibling `openapi-directory` checkout. The Python helper composes overlays
in catalog order with `validate_oad_pins.py`. Syncables `describePlatform`
discovers collections and root inputs; `paginate` issues two synthetic pages
per provider and checks the opaque next request and terminal stop. Airtable is
also read through `readPlatform`, which imports both records from its declared
CRUD collection.

Exercise the proxy's real `Catalog` and OAuth profile parser against the same
local catalog and immutable OAD pins:

```sh
cargo test --manifest-path integration-proxy/Cargo.toml \
  asana_airtable_profiles_are_read_only_and_proxy_compatible \
  -- --ignored --nocapture
```

The default is `load_checked_in_file`, which uses the exact local overlay
bytes and downloads the immutable OAD pins. That keeps `cargo test
-- --include-ignored` independent of Pages deployment.

After the dated catalog is on Pages, set an explicit URL to run the same parser
against the published catalog and sources:

```sh
ASANA_AIRTABLE_CATALOG_URL=https://ontola.github.io/atomic-plugins/overlays/catalog/2026-10-08-asana-airtable.json \
  cargo test --manifest-path integration-proxy/Cargo.toml \
  asana_airtable_profiles_are_read_only_and_proxy_compatible \
  -- --ignored --nocapture
```

The proxy check asserts the selected OAuth scopes, S256 PKCE behavior,
read/write route coverage, and that Airtable's `client_secret_basic` and
`none` client methods both parse. Airtable currently exposes one managed
collection (`tableRecords`), so Syncables asks for `baseId` and
`tableIdOrName`; the base and table metadata GET operations are OAuth-covered
but are not managed collections in this read model. No end-to-end provider
login or live account data is covered here.
