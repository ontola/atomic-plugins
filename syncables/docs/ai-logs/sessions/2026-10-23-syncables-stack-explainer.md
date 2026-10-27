# Illustrated stack explainer and cross-collection linking

- Session: codex://threads/01a11a49-4322-7813-aa0d-2f70ada2be33
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-23

## Human requests

The user requested examples and images for the daemon storage documentation,
then clarified: "I actually want an explainer of the whole syncables stack
including our OpenAPI extentions". They asked whether documented pagination
semantics guarantee coverage of the identifier range between returned items,
and asked to continue the documentation work and answer that question.

The user then proposed investigating links between real-world objects across
API-hosted collections. Their example was a current account and a savings
account linked strictly to it, with mirrored transfers, potentially identical
date/amount pairs and delayed arrival. Personal account details and private
records are not needed for this documentation and were not accessed.

They subsequently proposed extending Pagination Schemes to describe coverage
guarantees and explicitly requested a GitHub issue. Created atomic-plugins#686
with scope, current-spec foundations, acceptance criteria and examples;
no specification syntax or runtime guarantee was changed in this docs task.

## Substantive response and work

Corrected an earlier overbroad statement about range coverage: an exhaustive,
ascending unique-ID page after 9 returning 10, 12 and 15 does establish
coverage of (9,15] for its query and authorization context under the provider
contract. Gaps are not a reason to reject that inference. Observation time
is distinct from a guaranteed provider snapshot time, and current standalone
profiles/storage do not automatically publish these coverage assertions.

Added a whole-stack explainer linked from the README and daemon guide, with
four repository-native SVG diagrams. It distinguishes descriptions/overlays,
engine, transport/authentication, library and standalone storage, shared JSON,
snapshot history, schema limitations and proposed Atomic replication. Worked
examples use the committed public GET-only GitHub/Keep profiles and invented
records. Range/property evidence and filtering/sorting support are qualified
against the actual extension specifications and runtime support.

Added a separate, explicitly unimplemented linking investigation. It keeps
source identity separate from real-world identity and models the two bank
entries as legs of one transfer. It preserves tied assignments, cardinality,
delayed/backdated arrivals, coverage and versioned evidence rather than forcing
pairwise matches. Prior art checked against primary documentation: OpenRefine
reconciliation, Splink's Fellegi-Sunter model, W3C PROV-O and TrueLayer's
transaction identifier caveats. No provider requests, credential changes or
live data migrations are part of this work.

## Validation and publication

Validated 47 local links and five fragment targets in the new/inserted guide
content, parsed JSON examples and checked both public profiles. All four SVGs
parse as XML, have accessible titles/descriptions, and contain no scripts or
external references. Rendered each SVG to PNG and visually inspected it;
corrected the engine input and history-parent arrows and clarified shared
item-node references. Changelog validation and whitespace checks pass. This
is documentation-only; runtime source, credentials and private snapshots are
unchanged. Existing repository authorization permits committing, pushing,
opening a PR and merging after applicable checks pass.
