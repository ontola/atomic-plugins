# Investigating links across API collections

**Status: design investigation, not implemented.** This follows the
[Syncables stack explainer](how-it-works.md) and builds on its immutable
source records, collection history and contract-qualified coverage.

The aim is to relate records to real-world objects and events while keeping
their source identities, disagreements and uncertainty available. Content
deduplication and identity resolution answer different questions: two records
can share an entire JSON value without representing the same occurrence.

## Start with the bank-transfer example

Suppose a savings account can transfer only to or from one current account,
apart from explicitly classified exceptions such as interest. That is a useful
domain constraint supplied by the user or account contract. It is not a
guarantee that every API record has an immediately visible counterpart.

Model three things separately:

* The source record in each account's API collection, identified within its
  provider/account namespace.
* The account entry that record describes: one debit or credit leg.
* The proposed real-world transfer linking the two legs.

Two APIs might contain representations of the **same account entry**. A debit
in current and a credit in savings, however, are **different entries belonging
to one transfer**. A generic `sameAs` relation would lose this distinction.

Consider invented entries in the same currency:

| Record | Account | Booking date | Amount |
| --- | --- | --- | --- |
| C1 | Current | October 20 | −100 EUR |
| C2 | Current | October 20 | −100 EUR |
| S1 | Savings | October 21 | +100 EUR |
| S2 | Savings | October 21 | +100 EUR |

If those are all the relevant entries and all other evidence is identical,
there are two equally valid one-to-one assignments. We can know there are
two transfers totaling 200 EUR without knowing whether C1 pairs with S1 or S2.
Equal amounts and dates do not remove that symmetry. Even complete collection
coverage cannot recover information the provider never exposed.

If only S1 has arrived, retain “two possible debits, one observed credit” and
an open expectation for the other credit. A matcher must not arbitrarily pair
the first rows and then call the leftovers a duplicate or an anomaly.

## Keep candidate links and decisions as data

A proposed link should be an immutable, versioned assertion that refers to
the source subjects **and the exact object roots/revisions examined**. A
stable assertion identity can have successive versions as the evidence changes.
Conceptually it needs:

| Field | Purpose |
| --- | --- |
| Relation and roles | Same entry, two legs of a transfer, reversal, or another explicit relation |
| Participants | Source subjects plus pinned evidence versions, with debit/credit or other roles |
| Evidence | Shared reference, counterparty, amount/currency, date difference and conflicting facts |
| Candidate group | Competing possibilities and applicable cardinality constraints |
| Decision | Candidate, accepted, rejected or superseded; automated rule or human judgment |
| Method | Versioned mapping/rule/model, parameters and actor |
| Coverage inputs | Which account/query/time windows were observed and with what guarantees |
| Time | When the underlying event applies, when evidence was observed, and when the assertion was made |

Store these as a derived collection in the same content-addressed PostgreSQL
foundation, with its own history. That is a proposed use of the storage model;
the current daemon does not have a reconciliation engine. Evidence should
reference existing roots rather than copying private transaction bodies.

The derived state should pin a **vector of input revisions**, one per source
collection. They need not share a timestamp. This makes a result reproducible
and exposes which source was stale. A changed record can invalidate the
current decision without destroying the earlier decision or its evidence.

## Match compatible sets, not just independent pairs

A first prototype can use explicit constraints before statistical scoring:

1. Normalize provider-specific fields into derived comparison features. Keep
   raw data intact. Compare amounts with exact decimals or currency-aware
   minor units; distinguish currency, sign, booking date, value date and status.
2. Generate candidates using the known account relationship, opposite signs,
   matching currency/amount where appropriate, and a configurable delay window.
   A narrow search window is a policy, not proof that later matches cannot exist.
3. Prefer documented shared transfer references and counterpart accounts over
   coincidental amount/date agreement. Provider record IDs are not presumed to
   be shared across the two accounts.
4. Solve each connected candidate group subject to the declared constraints.
   For a confirmed simple-transfer model, one source leg can participate in at
   most one accepted pairing. Allow an unmatched option; maximizing the number
   of pairs must not force a false match.
5. Retain tied alternatives or a compact unresolved group. Only accept a pair
   when the evidence and decision policy justify it. A unique best assignment
   is not necessarily a trustworthy assignment.

The two-by-two example can retain a cardinality constraint instead of
enumerating every permutation. Larger cases can make complete enumeration
intractable. Confidence in “there are two transfers” can be stronger than
confidence in any individual pairing.

An account contract may justify a one-to-one model only for a subset of
records. Interest, fees, FX conversion, batch settlement, failed transfers,
reversals and pending-to-booked replacements need explicit classifications or
different relations. A reversal is a new related event, not simply erasure of
the original transfer. Amount balance is a useful constraint for the declared
model, not sufficient evidence of identity by itself.

## Delayed arrival connects reconciliation to range coverage

Keep at least three clocks distinct:

* **Business time:** booking/value/transaction dates reported by the provider.
* **Observation time:** when a fetch made the record visible to Syncables.
* **Decision time:** when the linking layer accepted or revised an assertion.

A page can be exhaustive for “booking dates through October 21” as observed
today while a newly posted record tomorrow receives an October 20 booking
date. Coverage of what was visible today does not close the past against
backdated arrivals. Closure needs a documented finality/watermark guarantee,
or a stated heuristic that may be reopened.

“Visible” refers to the API view used for that response: it may be a stale
replica or index, and pages in the same loop may use different snapshots.
Two unchanged observations do not prove that any intervening change was
undone; a persistent change might not have propagated to either read yet.
See [repeated observations and append-only collections](how-it-works.md#repeated-observations-and-append-only-collections)
for the stronger contracts needed to retire a key range permanently.

Useful states for an unmatched leg are therefore:

| State | Meaning |
| --- | --- |
| Not checked | The counterpart account/window has not been sufficiently fetched. |
| Awaiting | The counterpart is expected but may still arrive within policy or provider delay bounds. |
| Ambiguous | Several observed compatible assignments remain. |
| Unexpected absence | Adequate coverage and an explicit closure policy justify investigation. |
| Matched | A decision with retained evidence links the legs. |

Do not treat “not fetched,” “not visible,” “still in flight” and “does not
exist” as the same state. Re-read an overlapping recent period, use a change
feed where available, and reopen affected candidate groups when late or
corrected records arrive. A fixed overlap is a practical policy; without a
maximum lateness guarantee it cannot prove there will never be another arrival.

## Prior art worth borrowing

These sources address parts of the problem; none, by itself, supplies the
whole proposed Syncables layer:

* [OpenRefine's Reconciliation API](https://openrefine.org/docs/technical-reference/reconciliation-api)
  separates ranked candidate entities from a final match and supports review.
  That is useful precedent for the interaction model. Its candidate search
  does not itself express coupled transfer-leg assignments or temporal coverage.
* [Splink's Fellegi–Sunter model](https://github.com/moj-analytical-services/splink/blob/master/docs/topic_guides/theory/fellegi_sunter.md)
  weighs agreement against the likelihood of coincidence. This is relevant
  when amounts or descriptions recur often. Its independence assumptions need
  care for correlated fields; pair scores would still need our assignment and
  relation constraints. An arbitrary score must not be labeled a probability.
* [W3C PROV-O](https://www.w3.org/TR/prov-o/) gives vocabulary for entities,
  activities, agents and qualified derivations. It is a useful way to publish
  which inputs and process produced a linking assertion. It does not choose
  the match or supply a confidence model.
* [TrueLayer documents changing transaction IDs](https://support.truelayer.com/hc/en-us/articles/360025889254-Why-are-transaction-ids-subject-to-change),
  including pending-to-settled changes. Its
  [normalized provider ID](https://support.truelayer.com/hc/en-us/articles/8338166637201-What-is-normalised-provider-transaction-id)
  has stronger stability when present. This illustrates why identifier
  lifetime and namespace need an explicit provider contract, even before
  linking records across accounts.

The proposed architecture combines those ideas: provider-specific feature
mapping, domain-specific relation constraints, versioned evidence and decisions,
and coverage-aware expectations. No new OpenAPI extension is required merely
to experiment with it. OpenAPI describes each source API; a separate linking
profile can describe the cross-source hypothesis, so user-specific account
relationships do not accidentally become claims about every provider user.

## A bounded first experiment

Use invented current/savings fixtures before any real bank connection. The
experiment should demonstrate unique shared-reference matches, the unresolved
two-by-two case, one-day arrival delays, backdated arrivals, duplicate source
observations, record corrections, interest and reversals. Pin the two input
histories, rerun the same rule version, and compare the derived results.

Success means every decision is explainable and reversible, multiplicity is
preserved, missing evidence remains explicit, and later evidence can revise
the current interpretation without rewriting source history. The same model
can later support contacts across CRMs, an invoice and its payment, or several
API representations of one document, using the appropriate relation each time.
