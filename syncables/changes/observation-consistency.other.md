Clarify pagination coverage as an observation of a possibly stale API view,
with mixed snapshots across pages. Explain the limits of repeated identical
reads and the separate append-only, stable-selection and closed-prefix
guarantees needed for stronger cursor-based synchronization.
