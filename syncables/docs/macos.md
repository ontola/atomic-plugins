# macOS storage connector

The macOS connector exposes a private loopback OpenAPI service for iCloud
Drive files, storage transfer receipts and an optional Photos inventory.
SyncD consumes it through its ordinary collection reader, pagination,
request/response archive, PostgreSQL revisions, scheduler and data browser.
Storage operations use the existing PostgreSQL edit outbox. The adapter
supplies native operations and local authorization.

Build the current source with `npm ci` and `npm run build:release` in
`syncables/`. The npm package includes the Swift source. Building the helper
requires macOS 13 or newer and Apple's Command Line Tools (`xcode-select
--install`). Use the usual local PostgreSQL connection for SyncD.

## Start the connector

Run this in the signed-in user's Mac session, replacing `OWNER` with the
owner identifier in your SyncD configuration.

```sh
syncables macos \
  --directory "$HOME/Library/Mobile Documents/com~apple~CloudDocs" \
  --config-dir "$HOME/.local/share/syncables/macos" \
  --owner OWNER --photos --write
```

This builds an ad-hoc-signed helper app, starts the service on
`127.0.0.1:9890`, and generates a private token, OpenAPI document and SyncD
configuration under the selected configuration directory. Keep the process
running. Restart with the same arguments to reuse that configuration.
`--connector-port` selects another port. Existing generated configuration
and document files are rewritten from the supplied arguments.

`--photos` enables PhotoKit and its native authorization prompt. Grant full
library access for the supported inventory scope. PhotoKit exposes library
reading under its read/write authorization category. This helper uses
metadata-fetching methods and has no Photos mutation or media-fetching
methods. Development rebuilds may require renewed macOS consent. Distributed
builds should use a stable signing identity.

`--write` enables content staging and destination creation under the chosen
root. The default connector provides read access. The configuration folder
and token are private to the current user. The service rejects browser-origin
requests and requires its token for every operation. An IAP login is separate
from local macOS permissions.

## Inventory and browse

Use the generated configuration through normal SyncD commands.

```sh
export SYNCABLES_DATABASE_URL=postgresql://127.0.0.1/syncables_local
syncables sync --config "$HOME/.local/share/syncables/macos/config.json"
syncables ui --config "$HOME/.local/share/syncables/macos/config.json"
```

The UI prints a private browser link. Open that complete link, including its
fragment, to authorize the browser tab. Local collections appear with local
connection status. They require filesystem or Photos permission on the Mac.

The configured aliases are `macos/personal/files`,
`macos/personal/photos` when enabled, and `macos/personal/transfers` when
writes are enabled. They are ordinary OpenAPI collections. Existing
`browse`, `history`, `resource`, `tag`, `sync` and `daemon` commands apply.
The generated collections use manual sync (`pollSeconds: 0`). Set a positive
poll interval in the configuration when using `daemon`. A future connector
restart regenerates these settings, so keep custom configurations separately.

File inventory includes directories and symlinks, their paths and available
filesystem attributes, plus the upload/download state macOS exposes.
Symlinks are listed without traversal. Identity is scoped to the configured
root and relative path. A rename appears as removal of the old path and
addition of the new path. Package contents are traversed as directories.

The Photos scope is the System Photo Library's visible user-library assets.
It excludes hidden and recently deleted assets and Shared Albums. PhotoKit's
user-library view determines Shared Library visibility. Each record retains
its local identifier and any available iCloud identifier, original resource
filenames, dimensions, dates, media type, duration and Live Photo resource
relationships. Missing iCloud identifiers are retained as unknown. Photos
has a metadata-only capability in this connector.

Inventory performs no content reads, hashing, original downloads or thumbnail
requests. Enumeration is bounded to 250,000 items. Each full native traversal
is assembled into a fixed paginated observation with a scan identifier,
start/end times and scope in the archived response envelopes. Cursors expire
after ten minutes and are bounded to eight retained scans. An expired cursor
or failed scan requires a new full read. Normal SyncD read budgets apply. The generated configuration also sets a
128 MiB `snapshotLimits.maxBytes` and a 250,006-resource publication budget.
These are generic per-collection settings. Explicit budgets support up to
512 MiB and 500,000 resources, including bundled schemas.
Photos currently uses full rescans. Incremental PhotoKit history is future
work.

The observation reflects the Mac's current local view and can lag iCloud.
Directory traversal is an observation interval. It carries no atomic cloud
snapshot guarantee. Missing members describe that collection scope. They
provide no independent proof of provider-wide deletion.

## Copy into iCloud Drive

Stage a local file and queue its operation, then dispatch through the generic
outbox.

```sh
syncables copy --source ./example.txt --path "Syncables/example.txt" \
  --collection macos/personal/transfers --config ./config.json
syncables edits --collection macos/personal/transfers --config ./config.json
syncables send --collection macos/personal/transfers --config ./config.json
syncables sync --collections macos/personal/transfers --config ./config.json
```

For another configured local connector, explicitly select a binary GET
operation declared by that source's OpenAPI document.

```sh
syncables copy --source-collection macos/personal/files \
  --source-path /files/ENCODED_ITEM_ID/content \
  --path "Syncables/copied.txt" \
  --collection macos/personal/transfers --config ./config.json
```

The item ID comes from the file inventory. The macOS connector declares its
explicit binary read at `/files/{id}/content`. Reading that endpoint can
download a cloud-only source file. Metadata enumeration uses `/files`.
Connector-to-connector copying currently accepts configured local HTTP
sources. Remote IAP binary transfer support can extend the same staging
boundary when available.

Each root and connection has its own staged-content and receipt namespace.
Changing roots keeps the previous root's transfer history isolated.
Staging streams at most 1 GiB into an owner-private file named by SHA-256.
The JSON outbox stores its hash and destination intent. `--edit-id UUID`
allows resubmitting identical queued intent. Staged bytes remain after
cancellation and completion for recovery. Automatic garbage collection is
future work.

The native destination verifies the staged hash, traverses directories by
file descriptor while refusing symlinks, writes and flushes a temporary file,
and publishes it atomically with collision refusal. Parent directories are
created as needed. Existing targets require choosing a different path.
Directory creation can also be queued with normal `create` using JSON
`{"operationId":"UUID","path":"new-folder","kind":"directory"}`.

Transfer receipts persist before dispatch and after a successful local
write. The outbox's `confirmed` state records acceptance by the local
connector. A subsequent transfer inventory reports `localStatus` and the
current `uploadStatus` from macOS independently. An active or completed
upload takes precedence over a retained error from an earlier attempt, and
the error domain/code remain available as `uploadError`. `unknown` stays unknown
when macOS supplies no confirmation. The original modification time is
preserved for copies from local files. Extended attributes and ACLs are
outside this transfer contract.

A restart during a write can leave an uncertain receipt. Inspect the
operation and destination before creating another intent. A lost response
with a durable successful receipt can be resolved with the existing
`adopt-edit` command, using the operation UUID as `--created-id`. Reusing a
successful operation UUID with identical intent returns the saved receipt.
Receipts are retained permanently. The service refuses deletion of transfer
receipts and supports create-only destination operations.

## Validation

The shared adapter tests exercise the actual OpenAPI reader, archive,
scheduler, PostgreSQL revisions and durable outbox with native fixtures.
Native macOS tests compile the helper and verify metadata enumeration,
explicit content export, hash validation, collision refusal and symlink and
traversal rejection on temporary files. These tests request no Photos access.
Live PhotoKit verification needs a Mac with an authorized synced library.
