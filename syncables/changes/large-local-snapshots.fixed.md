SyncD can browse large saved PostgreSQL snapshots without loading all decoded
records into memory. A local index is prepared once per revision, with a
loading message while it is built, then pages reconstruct only 25 records.
Search and record ordering remain unchanged. Working-folder checkout now
streams batched records into the existing atomic publication path, preserving
exact JSON bytes and protection for local edits without refetching provider
data.
