The experimental Atomic peer now generates one owner-scoped drive with account
folders and a native table for each selected API collection. All configured
collections are selected by default; use --collections or --collection for a
subset. Typed fields and linked nested resources replace JSON wrappers;
original responses and history stay in PostgreSQL. Preserve unsafe numbers as
exact text and use a new projection directory when upgrading from the original
single-collection wrapper prototype.
