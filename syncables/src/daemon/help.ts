export const DAEMON_HELP = `
Local Syncables (experimental; PostgreSQL + Git 2.29+, Node 22.11+):
  syncables login --config FILE
  syncables logout --config FILE
  syncables sync --config FILE [--collections platform/account/name,...] [--interactive]
    [--message "Why this sync is being run"]
  syncables daemon --config FILE [--collections platform/account/name,...] [--interactive]
    [--message "Intent attached to each successful snapshot in this process"]
  syncables checkout --config FILE [--collections platform/account/name,...]
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
as ordinary working folders without authentication, PostgreSQL or refetching.
Successful syncs update these folders automatically; local edits block updates. browse returns a commit to pin
subsequent pages; resource resolves schemas through the same command at --at.
history returns commit messages, timestamps and parents; use either ITEM_ID
or --subject IRI. --message is stored permanently in local Git; keep secrets out.
Webhook relay: loopback POST /webhooks/ENCODED_COLLECTION_ALIAS, Bearer
SYNCABLES_WEBHOOK_TOKEN, x-syncables-delivery-id. See docs/daemon.md.
`;
