// @wc-ignore-file
/**
 * Google Keep's note shape (`Note`, Keep API v1) translated onto a row of
 * the app's table, and back, and the decision of what one two-way pass does
 * to each note and each row. Pure: no store, no network. `sync.ts` carries
 * the decisions out.
 *
 * A row holds a note as two columns: Name (the note's `title`) and
 * Description (its body, as Markdown). A text note's body is its text. A
 * list note's body is a Markdown checklist, one line per item, a child
 * item (Keep allows one level) indented by two spaces:
 *
 *     - [ ] Oat milk
 *     - [x] Bread
 *       - [ ] Sourdough, if there is any
 *
 * Every row that came from Keep keeps a fingerprint of the title and body
 * both sides agreed on at the last sync (`google-keep-synced`, see
 * `fingerprint`), and that note's kind. A pass compares the row and what
 * Keep sends now with that fingerprint:
 *
 * - only Keep changed: the row takes Keep's version (`pull`);
 * - only the row changed: the row's version goes to Keep (`push`);
 * - both changed, to different things: neither side is touched and the row
 *   is marked `conflict` until the person picks one in the view;
 * - a row with no note behind it (made here) becomes a new note (`create`).
 *
 * The Keep API has no update call: a note is created, read, listed or
 * deleted. A push is therefore a replacement: a new note with the row's
 * title and body, then the old note deleted. That loses what the API
 * cannot write (colour, labels, reminders, pins and the note's place in
 * Keep's order), and would lose attachments and collaborators, so a note
 * that has an attachment or is shared with anyone is never replaced: its
 * row is marked `blocked` instead (`replaceBlock`). Nothing a person deletes
 * here is deleted in Keep by a pass; see `removedHere` in `plan`.
 *
 * What happens to a note that stops appearing in the list (which leaves
 * out trashed notes by default) is never guessed from its absence:
 *
 * - `present`: in the last complete read.
 * - `trashed`: Google returned it by id with `trashed: true`. Keep deletes a
 *   trashed note for good after a while; restoring it in Keep brings the
 *   row back to `present`.
 * - `deleted`: gone from a complete read, and the by-id check answered 404.
 * - `unconfirmed`: gone from a complete read, and the by-id check failed or
 *   was not made (more absent notes than one pass checks).
 *
 * A row whose note is not `present` is not sent to Keep, whatever is edited
 * in it.
 */
import {
  fingerprint as digest,
  replaceBlock as replaceBlockOf,
  type ReplaceDeclaration,
} from 'syncables/browser';
import type { JSONValue } from './store.js';

export type Row = Record<string, JSONValue>;

export const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const PRESENCE = [
  'present',
  'trashed',
  'deleted',
  'unconfirmed',
] as const;
export type Presence = (typeof PRESENCE)[number];

/** Presences no by-id check is repeated for; the note's return undoes them. */
const SETTLED: Presence[] = ['trashed', 'deleted'];

export type Kind = 'text' | 'list';

/** A note as a row shows it: the title and the body as Markdown. */
export interface NoteFields {
  title: string;
  body: string;
  kind: Kind;
}

/** Keep's limits, from the API reference (`Note`, `Section`, `ListItem`). */
export const MAX_TITLE = 999;
export const MAX_TEXT = 19_999;
export const MAX_ITEMS = 999;
export const MAX_ITEM_TEXT = 999;

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** The note's resource name (`notes/<id>`): the row's identity. */
export const noteId = (note: Row): string | undefined =>
  typeof note.name === 'string' && /^notes\/[^/]+$/.test(note.name)
    ? note.name
    : undefined;

export interface Item {
  text: string;
  checked: boolean;
  children: { text: string; checked: boolean }[];
}

const itemOf = (value: JSONValue): Item | undefined => {
  if (!isRow(value)) return undefined;
  const content = isRow(value.text) ? text(value.text.text) : '';

  return {
    text: content,
    checked: value.checked === true,
    children: (Array.isArray(value.childListItems) ? value.childListItems : [])
      .filter(isRow)
      .map(child => ({
        text: isRow(child.text) ? text(child.text.text) : '',
        checked: child.checked === true,
      })),
  };
};

/** One checklist line; an item's own line breaks become spaces. */
const line = (indent: string, item: { text: string; checked: boolean }) =>
  `${indent}- [${item.checked ? 'x' : ' '}] ${item.text.replace(/\s*\n\s*/g, ' ')}`;

export function renderList(items: Item[]): string {
  return items
    .flatMap(item => [line('', item), ...item.children.map(c => line('  ', c))])
    .join('\n');
}

/** A list note's items (none for a text note). */
export function itemsOf(note: Row): Item[] {
  const body = isRow(note.body) ? note.body : {};
  if (!isRow(body.list)) return [];

  return (Array.isArray(body.list.listItems) ? body.list.listItems : [])
    .map(itemOf)
    .filter((i): i is Item => !!i);
}

/** The note as the row's Name and Description. */
export function noteFields(note: Row): NoteFields {
  const body = isRow(note.body) ? note.body : {};

  if (isRow(body.list)) {
    const items = (
      Array.isArray(body.list.listItems) ? body.list.listItems : []
    )
      .map(itemOf)
      .filter((i): i is Item => !!i);

    return { title: text(note.title), body: renderList(items), kind: 'list' };
  }

  return {
    title: text(note.title),
    body: isRow(body.text) ? text(body.text.text) : '',
    kind: 'text',
  };
}

/** Markdown escapes an editor may add: `\[ \]` for a checkbox, say. */
const unescape = (value: string) => value.replace(/\\([[\]\-*+_\\])/g, '$1');

const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\](?:\s(.*))?$/;
const BULLET = /^(\s*)(?:[-*+]\s+)?(.*)$/;

/** A Markdown checklist (or any lines) as Keep list items, one level of nesting. */
export function parseList(body: string): Item[] {
  const items: Item[] = [];

  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const source = unescape(raw);
    if (!source.trim()) continue;
    const box = CHECKBOX.exec(source);
    const indent = box ? box[1] : BULLET.exec(source)![1];
    const entry = {
      text: (box ? (box[3] ?? '') : BULLET.exec(source)![2]).trim(),
      checked: box ? box[2] !== ' ' : false,
    };
    const parent = items.at(-1);
    if (indent.length > 0 && parent) parent.children.push(entry);
    else items.push({ ...entry, children: [] });
  }

  return items;
}

/** Whether a new row's body reads as a checklist: every non-empty line a checkbox. */
export function looksLikeList(body: string): boolean {
  const lines = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(unescape)
    .filter(l => l.trim());

  return lines.length > 0 && lines.every(l => CHECKBOX.test(l));
}

/** A text body as compared: line endings normalised, trailing blanks ignored. */
const canonicalText = (body: string) =>
  body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

/** A body as compared for a note of `kind`. */
export const canonicalBody = (body: string, kind: Kind): string =>
  kind === 'list' ? renderList(parseList(body)) : canonicalText(body);

/** Whether two versions of a note say the same, read as a note of `kind`. */
export function sameNote(
  a: { title: string; body: string },
  b: { title: string; body: string },
  kind: Kind,
): boolean {
  return (
    a.title.trim() === b.title.trim() &&
    canonicalBody(a.body, kind) === canonicalBody(b.body, kind)
  );
}

/**
 * A short, stable digest of a note as the row shows it: its kind, its
 * trimmed title and its body as compared (`canonicalBody`). Two versions
 * with the same fingerprint say the same (`sameNote`). Not a security
 * measure: it only tells a pass which side changed since the last sync.
 * syncables' `fingerprint` (cyrb53 over the canonical JSON).
 */
export const fingerprint = (
  fields: { title: string; body: string },
  kind: Kind,
): string =>
  digest({
    kind,
    title: fields.title.trim(),
    body: canonicalBody(fields.body, kind),
  });

/** The request body of `POST /v1/notes` for a row's title and body. */
export function keepNote(fields: {
  title: string;
  body: string;
  kind: Kind;
}): Row {
  const title = fields.title.trim();
  const body =
    fields.kind === 'list'
      ? {
          list: {
            listItems: parseList(fields.body).map(item => ({
              text: { text: item.text },
              checked: item.checked,
              ...(item.children.length
                ? {
                    childListItems: item.children.map(child => ({
                      text: { text: child.text },
                      checked: child.checked,
                    })),
                  }
                : {}),
            })),
          },
        }
      : { text: { text: canonicalText(fields.body) } };

  return { ...(title ? { title } : {}), body } as Row;
}

/** Why Keep would refuse the row as a note, or undefined. */
export function invalid(fields: NoteFields): string | undefined {
  if (fields.title.trim().length > MAX_TITLE)
    return `The title is longer than Keep's ${MAX_TITLE} characters.`;

  if (fields.kind === 'text') {
    if (canonicalText(fields.body).length > MAX_TEXT)
      return `The text is longer than Keep's ${MAX_TEXT} characters.`;

    return undefined;
  }

  const items = parseList(fields.body);
  const count = items.reduce((n, i) => n + 1 + i.children.length, 0);
  if (count > MAX_ITEMS)
    return `The list has ${count} items; Keep takes at most ${MAX_ITEMS}.`;
  if (
    items.some(i => [i, ...i.children].some(c => c.text.length > MAX_ITEM_TEXT))
  )
    return `A list item is longer than Keep's ${MAX_ITEM_TEXT} characters.`;

  return undefined;
}

/** The note's live permissions (a removed collaborator says `deleted`). */
const permissions = (note: Row): Row[] =>
  (Array.isArray(note.permissions) ? note.permissions : [])
    .filter(isRow)
    .filter(p => p.deleted !== true);

/**
 * What may not be replaced, as CRUD Causality 0.7.0 `replace` declares it
 * for a Keep note (§7.8 of the spec).
 */
export const KEEP_REPLACE: ReplaceDeclaration = {
  blockedBy: [
    {
      field: 'attachments',
      when: 'nonEmpty',
      description:
        'It has an attachment, which the Keep API cannot copy to a new note.',
    },
    {
      field: 'permissions',
      moreThan: 1,
      except: { deleted: true },
      description: 'It is shared, and a new note would lose its collaborators.',
    },
  ],
};

/**
 * Why a push may not replace this note, or undefined when it may: a note
 * with an attachment (the API cannot copy one) or shared with anyone (the
 * new note would not be), as syncables' `replaceBlock` reads
 * `KEEP_REPLACE`; or that the connected account does not own (it could not
 * delete the old one).
 */
export function replaceBlock(note: Row, account?: string): string | undefined {
  const blocked = replaceBlockOf(KEEP_REPLACE, note);
  if (blocked) return blocked.description;
  const live = permissions(note);
  const owner = live.find(p => p.role === 'OWNER');
  if (live.length === 1 && !owner)
    return 'The connected Google account does not own it.';
  if (
    owner &&
    account &&
    typeof owner.email === 'string' &&
    owner.email.toLowerCase() !== account
  )
    return 'The connected Google account does not own it.';

  return undefined;
}

/**
 * The connected account's email, as far as the notes say: the one address
 * that is on every note it can see (its own notes name it as owner, notes
 * shared with it as a writer). Undefined when there are no notes, or when
 * the notes name no single such address.
 */
export function accountOf(notes: Row[]): string | undefined {
  let common: Set<string> | undefined;

  for (const note of notes) {
    const emails = new Set(
      permissions(note)
        .map(p => (typeof p.email === 'string' ? p.email.toLowerCase() : ''))
        .filter(Boolean),
    );
    if (!emails.size) continue;
    common = common ? new Set([...common].filter(e => emails.has(e))) : emails;
  }

  return common?.size === 1 ? [...common][0] : undefined;
}

/** A row of the table that came from Keep. */
export interface KnownRow {
  subject: string;
  /** The note's resource name. */
  id: string;
  /** The note's kind at the last sync. */
  kind: Kind;
  /** The fingerprint both sides had at the last sync: the baseline. */
  synced: string;
  presence: Presence;
  /** The row's Name and Description now. */
  local: { title: string; body: string };
}

/** A row made here: no note behind it yet. */
export interface LocalRow {
  subject: string;
  local: { title: string; body: string };
}

/** Google's answer to `GET /v1/notes/{id}` for one absent note, or why there is none. */
export type Lookup =
  | { id: string; status: number; body?: JSONValue }
  | { id: string; error: string };

export type Action =
  /** A note with no row and never imported: a new row. */
  | { kind: 'import'; note: Row }
  /** Keep changed, the row did not: the row takes Keep's version. */
  | { kind: 'pull'; subject: string; note: Row }
  /** A list note on both sides: merged item by item (`lists.ts`) by the pass. */
  | { kind: 'list'; subject: string; note: Row }
  /** Both sides changed to the same: only the baseline moves on. */
  | { kind: 'rebase'; subject: string; note: Row }
  /** The row changed, Keep did not: the note is replaced by the row's version. */
  | { kind: 'push'; subject: string; note: Row; fields: NoteFields }
  /** A row made here: a new note. */
  | { kind: 'create'; subject: string; fields: NoteFields }
  /** Both changed, differently: nothing is written but the mark. */
  | { kind: 'conflict'; subject: string; note: Row }
  /** The row changed, and the change cannot be sent; the reason says why. */
  | { kind: 'blocked'; subject: string; reason: string; note?: Row }
  /** The note left the read; what the by-id check found. */
  | { kind: 'settle'; subject: string; presence: Presence; note?: Row }
  /**
   * Nothing to do. `clean`: the row and Keep agree with the baseline, so a
   * conflict or block marked earlier no longer holds.
   */
  | { kind: 'unchanged'; subject: string; clean?: boolean }
  /** A note whose row was deleted here: left alone in Keep, not imported again. */
  | { kind: 'removed-here'; note: Row };

const fieldsOf = (row: { title: string; body: string }, kind: Kind) => ({
  title: row.title,
  body: row.body,
  kind,
});

/** The rows to check by id: present or unconfirmed, and missing from a complete read. */
export function absentNotes(
  rows: KnownRow[],
  notes: Row[],
  complete: boolean,
): string[] {
  if (!complete) return [];
  const read = new Set(notes.map(noteId).filter(Boolean));

  return rows
    .filter(r => !read.has(r.id) && !SETTLED.includes(r.presence))
    .map(r => r.id)
    .sort();
}

/**
 * What one pass does. `rows` are the table's rows that came from Keep (one
 * per note; a second row for the same note is not passed in), `locals` the
 * rows made here, `notes` the list read, `complete` whether that read was
 * complete, `lookups` the by-id checks of `absentNotes`, `known` every note
 * id this table ever held (so a note whose row was deleted here is not
 * imported again), `retiring` the old notes of replacements whose delete is
 * still to be retried (never imported), and `account` the connected
 * account's email when known.
 */
export function plan({
  rows,
  locals,
  notes,
  complete,
  lookups = [],
  known,
  retiring = [],
  account,
}: {
  rows: KnownRow[];
  locals: LocalRow[];
  notes: Row[];
  complete: boolean;
  lookups?: Lookup[];
  known: string[];
  retiring?: string[];
  account?: string;
}): Action[] {
  const actions: Action[] = [];
  const byId = new Map<string, Row>();

  for (const note of notes) {
    const id = noteId(note);
    if (id && !byId.has(id)) byId.set(id, note);
  }

  const answers = new Map(lookups.map(l => [l.id, l]));
  const checked = new Set(absentNotes(rows, notes, complete));
  const held = new Set(rows.map(r => r.id));

  for (const row of rows) {
    const note = byId.get(row.id);

    if (!note) {
      if (!checked.has(row.id)) {
        actions.push({ kind: 'unchanged', subject: row.subject });
        continue;
      }

      const answer = answers.get(row.id);
      const body =
        answer && 'status' in answer && isRow(answer.body)
          ? answer.body
          : undefined;
      let presence: Presence = 'unconfirmed';
      if (answer && 'status' in answer && answer.status === 404)
        presence = 'deleted';
      else if (
        answer &&
        'status' in answer &&
        answer.status === 200 &&
        body &&
        noteId(body) === row.id
      )
        presence = body.trashed === true ? 'trashed' : 'present';

      if (presence === 'present' && body) {
        // Listed by id though not in the list: read it as a listed note.
        byId.set(row.id, body);
      } else {
        actions.push({
          kind: 'settle',
          subject: row.subject,
          presence,
          ...(body && presence === 'trashed' ? { note: body } : {}),
        });
        continue;
      }
    }

    const current = byId.get(row.id)!;
    const now = noteFields(current);

    // A list note is merged item by item; one that became a text note in
    // Keep takes Keep's version (its items here are dropped).
    if (row.kind === 'list') {
      actions.push(
        now.kind === 'list'
          ? { kind: 'list', subject: row.subject, note: current }
          : { kind: 'pull', subject: row.subject, note: current },
      );
      continue;
    }

    const remote = fingerprint(now, now.kind) !== row.synced;
    const local = fingerprint(row.local, row.kind) !== row.synced;

    if (!local) {
      if (remote || row.presence !== 'present')
        actions.push({ kind: 'pull', subject: row.subject, note: current });
      else
        actions.push({ kind: 'unchanged', subject: row.subject, clean: true });
      continue;
    }

    if (remote) {
      if (now.kind === row.kind && sameNote(row.local, now, now.kind))
        actions.push({ kind: 'rebase', subject: row.subject, note: current });
      else
        actions.push({ kind: 'conflict', subject: row.subject, note: current });
      continue;
    }

    const fields = fieldsOf(row.local, row.kind);
    const reason = replaceBlock(current, account) ?? invalid(fields);
    actions.push(
      reason
        ? { kind: 'blocked', subject: row.subject, reason, note: current }
        : { kind: 'push', subject: row.subject, note: current, fields },
    );
  }

  for (const row of locals) {
    if (!row.local.title.trim() && !row.local.body.trim()) {
      actions.push({ kind: 'unchanged', subject: row.subject });
      continue;
    }

    const fields = fieldsOf(
      row.local,
      looksLikeList(row.local.body) ? 'list' : 'text',
    );
    const reason = invalid(fields);
    actions.push(
      reason
        ? { kind: 'blocked', subject: row.subject, reason }
        : { kind: 'create', subject: row.subject, fields },
    );
  }

  const gone = new Set(known);
  const old = new Set(retiring);

  for (const [id, note] of byId) {
    if (held.has(id) || old.has(id)) continue;
    actions.push(
      gone.has(id) ? { kind: 'removed-here', note } : { kind: 'import', note },
    );
  }

  return actions;
}
