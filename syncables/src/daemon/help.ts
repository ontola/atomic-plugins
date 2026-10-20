export const DAEMON_HELP = `
Local Syncables (experimental; PostgreSQL + Git 2.29+, Node 22.11+):
  syncables login --config FILE
  syncables logout --config FILE
  syncables sync --config FILE [--collections platform/account/name,...] [--interactive]
  syncables daemon --config FILE [--collections platform/account/name,...] [--interactive]
  syncables status --config FILE
  syncables browse [platform[/account[/collection[/item-id]]]] --config FILE
    [--at COMMIT|tag:NAME] [--filter /json/pointer=JSON_SCALAR]
    [--order-by /json/pointer[:asc|:desc]] [--page 1 --page-size 50]
  syncables history [ITEM_ID] --collection platform/account/name --config FILE
  syncables resource IRI --collection platform/account/name --config FILE [--at COMMIT|tag:NAME]
  syncables tag NAME --collection platform/account/name --config FILE [--at COMMIT|tag:NAME]

login stores device tokens in macOS Keychain. --interactive performs a new
browser-approved login and keeps tokens only in this foreground process.
Owner signing stays in the existing local approval bridge. status, browse,
history, resource and tag use only local data. browse returns a commit to pin
subsequent pages; resource resolves schemas through the same command at --at.
Webhook relay: loopback POST /webhooks/ENCODED_COLLECTION_ALIAS, Bearer
SYNCABLES_WEBHOOK_TOKEN, x-syncables-delivery-id. See docs/daemon.md.
`;
