# Explicit embedded API resources in Atomic tables

Session: codex://threads/01a16c93-853b-7362-94e6-c7287ee8a15e
Model/tool: GPT-6 via Codex, with Astra architecture review and bounded coding agents.

## Human prompts

- User and Labels columns contain JSON; can these link to resources from other API collections, using overlay declarations?
- Schema URLs should be generated consistently when an API joins the integration-proxy catalog.
- Be careful: OAD `$ref` is syntax, not evidence of linked collection items; inspect the existing extensions and overlays.
- Check whether the OpenAPI Directory fork has the latest GitHub OAD and whether users and labels are exposed.
- “can i see the data with the users and labels as links instead of as json?”

Private account details, source contents and resource identifiers are [redacted].

## Substantive outputs

Read CRUD Causality, Produced Classes, Filtering, the Clockify reference overlay,
Moneybird Links and earlier reference-vocabulary discussions. Confirmed that
types belong to declared CRUD resources across operations and collections;
schema references establish shape only. Existing identity references explicitly
leave embedded object representations unspecified. The fork contains user and
label endpoints; its description and the local test pin are older than official
upstream. That audit did not modify the accepted source snapshot or its pin.

Specified an experimental Embedded Resources declaration separately from CRUD
identity references. It explicitly names a target resource and scalar/list
cardinality; the target's own identity bindings use the supplied object and
original request context. It defines no presentation hints, implicit fetching,
recursive expansion or persistence/merge policy. Unresolved fields retain
their complete original values rather than partial relationship lists.

The specification's invented example and ten validator tests pass. Generic
SyncD projection, CLI support, regression coverage and a private local
reprojection are being implemented in the next commit; their validation is
not claimed complete here. No private data or credentials are included.
