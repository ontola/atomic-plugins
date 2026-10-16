/**
 * The field resolver a plugin view uses to read and write rows of the shared
 * classes (ontola/atomic-plugins#177, decision 1 and §3).
 *
 * Strict by design:
 *   - A view accepts a table only when its row class is *exactly* one of the
 *     shared classes it renders (the host's `appsForClass` matches the same
 *     way), or a class a registered lens maps onto one of them.
 *   - Fields are read and written by exact property subject, taken from the
 *     shared class's `requires` and `recommends`. There is no fallback to
 *     shortnames, names or datatypes, and no column guessing ("duck typing"
 *     is out of scope for now).
 *   - Another shape reaches a view only through a lens: a pair of functions
 *     written per source class, in code. This is where a Devonian lens plugs
 *     in; whether its shared side is materialized or computed is #177 Q14.
 *
 * Rows are plain objects keyed by property subject, the shape the drive app
 * frame's `store.getResource(...).props` has. Pure code with no imports, so
 * a plugin's esbuild bundles it (see README.md).
 */

/** Present means neither undefined, null nor the empty string. */
const present = value => value !== undefined && value !== null && value !== '';

/** "A", "A and B", "A, B and C". */
const listOf = names =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * The note a view puts on a row whose required fields are absent (README.md:
 * such a row is shown as incomplete, never skipped, and never synced until it
 * is complete): `"Incomplete: missing Name and Day"`. `missing` is
 * `Reading.missing`; `labels` maps property subjects to the names people see
 * as column headings, and a property without one is named by the last
 * segment of its subject (its shortname). Empty `missing` gives `undefined`,
 * so a caller can spread it in only when there is something to say.
 *
 * @param {readonly string[]} missing
 * @param {Readonly<Record<string, string>>} [labels]
 * @returns {string | undefined}
 */
export function incompleteNote(missing, labels = {}) {
  if (!Array.isArray(missing)) throw new TypeError('missing must be an array');
  if (!missing.length) return undefined;

  return `Incomplete: missing ${listOf(
    missing.map(p => labels[p] ?? p.split('/').filter(Boolean).pop() ?? p),
  )}`;
}

function assertClass(klass) {
  if (
    !klass ||
    typeof klass.subject !== 'string' ||
    !Array.isArray(klass.requires) ||
    !Array.isArray(klass.recommends)
  )
    throw new TypeError(
      'a shared class needs subject, requires and recommends (import it from terms.mjs)',
    );
}

/**
 * @param {{ classes: import('./resolver.d.mts').SharedClass[],
 *           lenses?: import('./resolver.d.mts').Lens[] }} options
 * @returns {import('./resolver.d.mts').Resolver}
 */
export function createResolver({ classes, lenses = [] }) {
  if (!Array.isArray(classes) || !classes.length)
    throw new TypeError('createResolver needs at least one shared class');
  const shared = new Map();

  for (const klass of classes) {
    assertClass(klass);
    shared.set(klass.subject, klass);
  }

  const bySource = new Map();

  for (const lens of lenses) {
    if (!lens || typeof lens.from !== 'string' || typeof lens.to !== 'string')
      throw new TypeError('a lens needs from and to class subjects');
    if (typeof lens.read !== 'function')
      throw new TypeError(`the lens from ${lens.from} needs a read function`);
    if (!shared.has(lens.to))
      throw new Error(
        `the lens from ${lens.from} maps to ${lens.to}, which this resolver does not render`,
      );
    if (shared.has(lens.from))
      throw new Error(
        `${lens.from} is a shared class this resolver renders; it needs no lens`,
      );
    if (bySource.has(lens.from))
      throw new Error(`two lenses map from ${lens.from}`);
    bySource.set(lens.from, lens);
  }

  const match = rowClass => {
    if (shared.has(rowClass))
      return { kind: 'shared', class: shared.get(rowClass) };
    const lens = bySource.get(rowClass);
    if (lens) return { kind: 'lens', class: shared.get(lens.to), lens };

    return null;
  };

  const matchOrThrow = rowClass => {
    const found = match(rowClass);
    if (!found)
      throw new Error(
        `${rowClass} is not a class this view renders, and no lens maps it`,
      );

    return found;
  };

  const fieldsOf = klass => [...klass.requires, ...klass.recommends];

  return {
    classes: [...shared.keys()],
    match,
    accepts: rowClass => match(rowClass) !== null,

    read(row, rowClass) {
      const found = matchOrThrow(rowClass);
      const view = found.kind === 'lens' ? found.lens.read(row) : row;
      if (!view || typeof view !== 'object')
        throw new TypeError(`the lens from ${rowClass} returned no row`);
      const values = {};

      for (const property of fieldsOf(found.class))
        if (present(view[property])) values[property] = view[property];

      const missing = found.class.requires.filter(p => !present(values[p]));

      return {
        class: found.class.subject,
        via: found.kind,
        values,
        missing,
        complete: missing.length === 0,
      };
    },

    write(patch, rowClass, row = {}) {
      const found = matchOrThrow(rowClass);
      const fields = new Set(fieldsOf(found.class));
      const outside = Object.keys(patch).filter(p => !fields.has(p));
      if (outside.length)
        throw new Error(
          `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not a field of ${found.class.subject}`,
        );
      if (found.kind === 'shared') return { ...patch };
      if (typeof found.lens.write !== 'function')
        throw new Error(`the lens from ${rowClass} is read-only`);

      return found.lens.write(patch, row);
    },
  };
}
