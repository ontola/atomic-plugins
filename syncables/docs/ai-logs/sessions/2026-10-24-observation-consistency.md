# API-view consistency and repeated observations

- Session: codex://threads/01a11a49-4322-7813-aa0d-2f70ada2be33
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-24

## Human request

The user wanted the range-coverage claim to be qualified as every matching
visible item known to the API server at that moment. They emphasized stale
views, different snapshots within one pagination loop, periodic rereads,
the limits of unchanged observations, and stronger guarantees for create-only
sets often ordered by auto-increment identifiers.

## Substantive response and changes

Qualified coverage as the API view used to answer the request, which may lag
authoritative state or lack a single coherent effective instant. Added the
distinction between observation time, freshness and cross-page snapshot
consistency. Identical responses do not establish absence of intervening
changes or imply that all changes were undone: a persistent update may still
be hidden by propagation lag. The no-net-change conclusion requires reliable
comparable endpoint observations of the selected/projected state.

Separated append-only membership, immutable state/stable selection, and
ordered visibility or closed-prefix guarantees. A documented closed prefix
can be retired; an auto-increment identifier alone cannot establish that
property. Checked PostgreSQL's primary transaction/sequence documentation
and used an explicitly illustrative allocation-before-commit counterexample.
No claim is made about the database used by a particular provider. Updated
the bank-transfer investigation and coverage issue #686 within the same scope.

## Validation

This change affects documentation only. Checked 39 local links and all
fragment targets in the explainer and linking investigation; changelog
validation and whitespace checks pass. Reviewed the claims against the
existing pagination contract and PostgreSQL's primary documentation.
Publication follows the repository's existing authorization and CI gates.
No private records, provider credentials or live data were accessed.
