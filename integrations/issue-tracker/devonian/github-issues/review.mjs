/**
 * Review before provider writes.
 *
 * `reviewGate(port, approved)` wraps the GitHub port. `list` and `get` pass
 * through. `create` and `update` throw `ReviewRequired` before any request
 * unless their exact `(entity, id, value)` is in `approved`, so what reaches
 * GitHub is only what a person saw. Nothing is sent and nothing is journalled
 * for a held write. The Bridge collects held writes (`bridge.held`) and
 * carries on with the rest of the pass.
 *
 * The key covers the value, not the Bridge's operation id: a pass that
 * re-plans a held write gets a new operation id, and an approval must survive
 * that as long as the content is unchanged, and must not survive a change.
 */
export class ReviewRequired extends Error {
  constructor(proposal) {
    super(`Review required before writing to GitHub: ${proposal.key}`);
    this.name = 'ReviewRequired';
    this.proposal = proposal;
  }
}

/** Stable key for one proposed write. `id` is undefined for a create. */
export function proposalKey(entity, id, value) {
  return JSON.stringify([entity, id ?? null, value]);
}

/**
 * An approval for one row: its subject and its proposal key. A proposal key
 * names content, not a row (a create's is `["issue", null, {…}]`), so an
 * approval that outlives the pass it was given in must say which row it was
 * for, or a second row with the same content would be sent unreviewed.
 */
export function approvalKey(subject, key) {
  return JSON.stringify([subject, key]);
}

/**
 * With `subjectOf` (the Bridge's `publishing` record), `approved` holds
 * `approvalKey(subject, key)` entries and a write passes only for its own
 * row. Without it, `approved` holds plain proposal keys (content only).
 */
export function reviewGate(port, approved = new Set(), subjectOf) {
  const check = (entity, id, value) => {
    const key = proposalKey(entity, id, value);
    const ok = subjectOf
      ? approved.has(approvalKey(subjectOf(), key))
      : approved.has(key);
    if (!ok) throw new ReviewRequired({ key, entity, id, value });
  };

  return {
    get scope() {
      return port.scope;
    },
    list: (...args) => port.list(...args),
    get: (...args) => port.get(...args),
    create(entity, value, ...rest) {
      check(entity, undefined, value);

      return port.create(entity, value, ...rest);
    },
    update(entity, id, value, ...rest) {
      check(entity, id, value);

      return port.update(entity, id, value, ...rest);
    },
  };
}
