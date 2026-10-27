export const DAEMON_HELP = `
Local Syncables (experimental; PostgreSQL, Node 22.11+; Git for import/export only):
  syncables login --config FILE
  syncables logout --config FILE
  syncables sync --config FILE [--collections platform/account/name,...] [--interactive]
    [--message "Why this sync is being run"]
  syncables daemon --config FILE [--collections platform/account/name,...] [--interactive]
    [--message "Intent attached to each successful snapshot in this process"]
  syncables atomic-peer --config FILE [--collections platform/account/name,...]
    --peer-binary /absolute/path/syncables-atomic-peer --peer-directory PRIVATE_DIRECTORY
    --signer-file PRIVATE_EXPORTED_ATOMIC_SECRET_FILE --reader atomic:agent:ID[,ID]
    [--peer-port 9901] [--at REVISION|tag:NAME]
  syncables checkout --config FILE [--collections platform/account/name,...]
  syncables braid --config FILE --collections platform/account/name,...
    [--braid-port 9888] [--braid-origin https://reader.example]
  syncables migrate git --config FILE [--source LEGACY_ARCHIVE]
  syncables export git --config FILE --subtree platform/account/collection[/ENCODED_ITEM_ID]
    --output NEW_DIRECTORY [--branches all|current] [--at REVISION|tag:NAME]
  syncables status --config FILE
  syncables browse [platform[/account[/collection[/item-id]]]] --config FILE
    [--at COMMIT|tag:NAME] [--filter /json/pointer=JSON_SCALAR]
    [--order-by /json/pointer[:asc|:desc]] [--page 1 --page-size 50]
  syncables history [ITEM_ID] --collection platform/account/name --config FILE
    [--subject RESOURCE_OR_SCHEMA_IRI] [--at COMMIT|tag:NAME]
  syncables resource IRI --collection platform/account/name --config FILE [--at COMMIT|tag:NAME]
  syncables tag NAME --collection platform/account/name --config FILE [--at COMMIT|tag:NAME]

login stores device tokens in macOS Keychain. --interactive performs a new
browser-approved login and keeps tokens only in this foreground process.
Owner signing stays in the existing local approval bridge. status, browse,
history, resource and tag use only local data. checkout exposes existing snapshots
as ordinary working folders from PostgreSQL without authentication or refetching.
Existing Git users must run migrate git first; original repos remain untouched.
Folders use workspaceDirectory (default ./workspace), separate from old Git worktrees.
Exports are normal Git repos, preserve ancestry/messages/branches/tags, and require a new destination.
Subtrees currently select one collection or item; cross-collection composed histories are future work.
Successful syncs update these folders automatically; local edits block updates. browse returns a commit to pin
subsequent pages; resource resolves schemas through the same command at --at.
history returns commit messages, timestamps and parents; use either ITEM_ID
or --subject IRI. --message is stored permanently in PostgreSQL history and Git exports; keep secrets out.
atomic-peer serves all configured collections by default as one native drive,
with account folders and collection tables, via the separately built companion.
It follows accepted PostgreSQL revisions, uses the explicitly selected
owner signer, and rejects incoming writes. --collection selects one collection;
--collections selects several. --at requires one selected collection.
Original JSON stays in PostgreSQL; nested data becomes native resource links.
Use a new projection directory when upgrading from the JSON-wrapper prototype.
See docs/atomic-peer.md for representation and native build instructions.
Webhook relay: loopback POST /webhooks/ENCODED_COLLECTION_ALIAS, Bearer
SYNCABLES_WEBHOOK_TOKEN, x-syncables-delivery-id. See docs/daemon.md.
Braid: separate read-only loopback listener over accepted PostgreSQL snapshots,
GET /collections/ENCODED_COLLECTION_ALIAS with Bearer SYNCABLES_BRAID_TOKEN.
Set a dedicated 32–256 character token. Add Subscribe: true for live snapshots;
reconnect with the last Version as Parents. HTTP 409 / Braid-Reset: true means
request a fresh snapshot without Parents. No provider login or writes occur.
`;
