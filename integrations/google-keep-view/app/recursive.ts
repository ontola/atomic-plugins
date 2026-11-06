// @wc-ignore-file
/** Reads SyncD's OpenAPI-derived Atomic objects and ordered array occurrences.
 * This is presentation only: the source graph remains the provider's model.
 */
import type { Store, Resource, Value } from './store.js';
import type { Note, Snapshot, Source } from './data.js';

const P = 'https://atomicdata.dev/properties/';
const M = 'urn:syncables:atomic:v1:';
const list = (value: Value): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
const text = (value: Value): string => (typeof value === 'string' ? value : '');

// Exact pinned contracts, independent of table names, source aliases and rows.
export const keepDocuments = [
  'a86aba83e63e24592e54491417815ea04c55d865350c338e5326cabb749b6499',
];
export function acceptsRecursiveKeep(klass: Resource): boolean {
  return (
    klass.subject ===
      'urn:syncables:atomic:v1:schema:e1f849d5291b13d688734d92fea93fbd2e96bbe4d94e010cf11d72a74e885762' &&
    keepDocuments.includes(text(klass.get(M + 'document-hash'))) &&
    klass.get(M + 'schema-path') === '#/components/schemas/Note' &&
    klass.get(M + 'resource') === 'note'
  );
}

export async function readRecursiveKeep(
  store: Store,
  source: Source,
): Promise<Snapshot> {
  const cache = new Map<string, Promise<Resource>>();

  const get = (subject: string): Promise<Resource> => {
    let result = cache.get(subject);

    if (!result) {
      result = store.getResource(subject);
      cache.set(subject, result);
    }

    return result;
  };

  const watches = new Set<string>([source.table]);
  const properties = new Map<string, Promise<Map<string, string>>>();

  const field = async (row: Resource, name: string): Promise<Value> => {
    const klass = list(row.get(P + 'isA'))[0];
    if (!klass) throw Error('Source resource has no Atomic Class');
    let fields = properties.get(klass);

    if (!fields) {
      fields = (async () => {
        const definition = await get(klass);
        const ids = new Set([
          ...list(definition.get(P + 'requires')),
          ...list(definition.get(P + 'recommends')),
        ]);
        const resources = await Promise.all([...ids].map(get));

        return new Map(
          resources.map(p => [text(p.get(P + 'name')), p.subject]),
        );
      })();
      properties.set(klass, fields);
    }

    const property = (await fields).get(name);

    return property ? row.get(property) : undefined;
  };

  const linked = async (
    row: Resource,
    name: string,
  ): Promise<Resource | undefined> => {
    const subject = await field(row, name);
    if (subject === undefined) return undefined;
    if (typeof subject !== 'string')
      throw Error('Expected typed source reference');
    const result = await get(subject);
    const parent = text(result.get(P + 'parent'));
    if (parent) watches.add(parent);

    return result;
  };

  const array = async (row: Resource, name: string): Promise<Resource[]> => {
    const container = await linked(row, name);
    if (!container) return [];
    const entries = await Promise.all(
      list(container.get(M + 'entries')).map(get),
    );
    entries.sort(
      (a, b) => Number(a.get(M + 'index')) - Number(b.get(M + 'index')),
    );

    return await Promise.all(
      entries.map(async entry => {
        const parent = text(entry.get(P + 'parent'));
        if (parent) watches.add(parent);
        const subject = await field(entry, 'value');
        if (typeof subject !== 'string' || entry.get(M + 'null') === true)
          throw Error('Expected a Keep checklist item reference');
        const item = await get(subject);
        const table = text(item.get(P + 'parent'));
        if (table) watches.add(table);

        return item;
      }),
    );
  };

  const notes: Note[] = [];
  const rows = await Promise.all(
    (await store.query({ property: P + 'parent', value: source.table })).map(
      get,
    ),
  );

  for (const row of rows) {
    if (!list(row.get(P + 'isA')).includes(source.rowClass)) continue;
    const body = await linked(row, 'body');
    const content = body ? await linked(body, 'list') : undefined;
    const note: Note = {
      subject: row.subject,
      title: text(await field(row, 'title')),
      body: '',
      kind: content ? 'list' : 'text',
      presence: (await field(row, 'trashed')) === true ? 'trashed' : '',
      hold: '',
      items: [],
    };

    if (content) {
      let position = 0;

      const append = async (
        items: Resource[],
        under = '',
        depth = 0,
      ): Promise<void> => {
        if (depth > 32 || note.items.length > 10000)
          throw Error('Keep checklist exceeds view limits');

        for (const item of items) {
          const itemText = await linked(item, 'text');
          note.items.push({
            subject: item.subject,
            text: itemText ? text(await field(itemText, 'text')) : '',
            done: (await field(item, 'checked')) === true,
            under,
            position: position++,
          });
          await append(
            await array(item, 'childListItems'),
            item.subject,
            depth + 1,
          );
        }
      };

      await append(await array(content, 'listItems'));
    } else if (body) {
      const section = await linked(body, 'text');
      if (section) note.body = text(await field(section, 'text'));
    }

    notes.push(note);
  }

  return {
    notes,
    watches: [...watches],
    readOnlyReason: 'This imported collection is read-only.',
  };
}
