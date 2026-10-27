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

The specification's invented example and ten validator tests pass. Added a generic
parser and identity-path resolver, whole-field JSON fallback, deterministic
summary merging and contributor provenance. Atomic tables now use Classes per
declared CRUD resource, native scalar/list relation Properties and referenced
subset tables. Unannotated comments stay JSON. Bare null summary fields use
explicit field-path metadata because top-level native null means deletion.

Added source-hash-bound, CRUD-only projection overlays and the
`--projection-contract` flag. Existing accepted snapshot hashes and request
semantics are unchanged; invalid contracts fail before native drive allocation.
A separate GitHub example declares issue user/labels, target identity bindings
and target collection endpoints without provider-specific runtime branches.
The experimental declaration was committed before its implementation.

Validation: 106 parser/reference/startup tests passed; a dedicated disposable
PostgreSQL run passed 30 projector/peer tests with no skips, including three
actual native-process update/restart cases. TypeScript checking, release emit,
targeted ESLint and whitespace/format checks passed. Astra's final architecture
review found no blocking issues. The native regression proves accepted graph
and persisted checkpoint recovery, not direct allocated-value readback.

A separate authorized localhost reprojection preserved the original 132 row
identities and both collection table URLs. Auditing reconstructed all embedded
user/label values (including null markers), verified all 111 notes unchanged,
and retained accepted snapshot provenance. Fresh signed HTTP reads checked all
239 projected resources and 2,803 fields without mismatches; collection queries
returned 21 issues, 111 notes, one referenced user and three referenced labels.
Browser inspection confirmed named relation links and opened user and label
targets. This local browser drive is a one-shot publication of accepted data;
no new continuously running SyncD peer or provider refresh is claimed.

Private backups, projection data and verification artifacts remain outside Git.
No private source content, local resource IDs, credentials or screenshots are
included in the repository. Exact-head CI remains a separate required check.

CI caught an undeclared `URL` global in the new preparation example, outside
the initial targeted lint scope. Added its explicit Node import and ran the
full package lint before pushing the correction. The local data projection
and runtime sources are unchanged by this correction.
