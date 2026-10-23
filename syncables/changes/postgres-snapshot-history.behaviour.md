Local daemon snapshots, schemas, messages and revision heads now live in
PostgreSQL, sharing content-addressed JSON nodes with the response archive.
Existing Git installations must run `syncables migrate git --config FILE`
before continuing. Original archives and worktrees remain untouched; ordinary
snapshot folders use `workspaceDirectory` (default `./workspace`). Use
`syncables export git --subtree platform/account/collection --output NEW_DIR`
for checked-out Git history, including branches, tags and commit metadata.
