Browser-safe catalog APIs discover and resolve authenticated principals while
preserving the subject's JSON type and client scope, describe collections,
inputs and field presentation, bind individual reads, and materialize child
navigation through declared CRUD identity/reference bindings and standard
OpenAPI Response Links. Source detail reads evaluate actual responses before
binding a child; direct identity bindings need no parent enumeration. Pure
request validators cover principal, navigation and bound list scopes.
`projectReadRecord` shares the reader's typed projection with consumers of
raw collection snapshots. Public source entrypoints bind explicit path inputs
through actual-response Links into canonical collection contexts before storage. Both library entrypoints export the APIs and types.
