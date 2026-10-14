// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import * as synthetic from '../fixtures/google-keep/synthetic.mjs';
import {
  accountOf,
  canonicalBody,
  fingerprint,
  invalid,
  keepNote,
  looksLikeList,
  noteFields,
  parseList,
  plan,
  replaceBlock,
  sameNote,
  type KnownRow,
  type Row,
} from './notes.js';

const notes = synthetic.notes as Row[];
const [textNote, listNote, untitled, shared, attached] = notes;

describe('noteFields', () => {
  it('reads a text note as its title and text', () => {
    expect(noteFields(textNote)).toEqual({
      title: 'Synthetic shopping ideas',
      body: 'Invented cheese\nPretend bread',
      kind: 'text',
    });
  });

  it('reads a list note as a Markdown checklist, a child item indented', () => {
    expect(noteFields(listNote)).toEqual({
      title: 'Synthetic packing list',
      body: '- [x] Imaginary passport\n- [ ] Made-up charger\n  - [ ] Fictional adapter',
      kind: 'list',
    });
  });

  it('gives a note without a title an empty one', () => {
    expect(noteFields(untitled).title).toBe('');
  });
});

describe('parseList and keepNote', () => {
  it('round-trips a list note through Markdown', () => {
    const { body } = noteFields(listNote);
    const back = keepNote({
      title: 'Synthetic packing list',
      body,
      kind: 'list',
    });
    expect(back).toEqual({ title: listNote.title, body: listNote.body });
  });

  it('reads other bullets, escapes and capital X, and plain lines as unchecked items', () => {
    expect(parseList('* \\[X\\] One\n  + [ ] Two\n\nThree')).toEqual([
      {
        text: 'One',
        checked: true,
        children: [{ text: 'Two', checked: false }],
      },
      { text: 'Three', checked: false, children: [] },
    ]);
  });

  it('sends a text note as text, without trailing blank lines', () => {
    expect(
      keepNote({ title: ' T ', body: 'a\r\nb\n\n', kind: 'text' }),
    ).toEqual({
      title: 'T',
      body: { text: { text: 'a\nb' } },
    });
  });

  it('leaves out an empty title', () => {
    expect(keepNote({ title: '', body: 'x', kind: 'text' })).not.toHaveProperty(
      'title',
    );
  });
});

describe('looksLikeList', () => {
  it('is true only when every line is a checkbox', () => {
    expect(looksLikeList('- [ ] a\n- [x] b')).toBe(true);
    expect(looksLikeList('- [ ] a\nplain')).toBe(false);
    expect(looksLikeList('')).toBe(false);
  });
});

describe('sameNote', () => {
  it('ignores checklist formatting and trailing whitespace', () => {
    expect(
      sameNote(
        { title: 'a', body: '* [X] one ' },
        { title: 'a ', body: '- [x] one' },
        'list',
      ),
    ).toBe(true);
    expect(
      sameNote(
        { title: 'a', body: 'one\n' },
        { title: 'a', body: 'one' },
        'text',
      ),
    ).toBe(true);
    expect(
      sameNote(
        { title: 'a', body: 'one' },
        { title: 'a', body: 'two' },
        'text',
      ),
    ).toBe(false);
    expect(canonicalBody('- [ ] x', 'text')).toBe('- [ ] x');
  });
});

describe('invalid', () => {
  it('names Keep limits', () => {
    expect(
      invalid({ title: 'x'.repeat(1000), body: '', kind: 'text' }),
    ).toMatch(/title/);
    expect(
      invalid({ title: '', body: 'x'.repeat(20_000), kind: 'text' }),
    ).toMatch(/text/);
    expect(invalid({ title: 't', body: 'fine', kind: 'text' })).toBeUndefined();
  });
});

describe('replaceBlock and accountOf', () => {
  it('blocks a shared note, a note with an attachment, and a note the account does not own', () => {
    expect(replaceBlock(textNote, synthetic.OWNER)).toBeUndefined();
    expect(replaceBlock(shared, synthetic.OWNER)).toMatch(/shared/);
    expect(replaceBlock(attached, synthetic.OWNER)).toMatch(/attachment/);
    expect(replaceBlock(textNote, 'someone-else@example.com')).toMatch(
      /does not own/,
    );
  });

  it('finds the one address every note names', () => {
    expect(accountOf(notes)).toBe(synthetic.OWNER);
    expect(accountOf([])).toBeUndefined();
  });
});

const known = (
  note: Row,
  local = noteFields(note),
  over: Partial<KnownRow> = {},
): KnownRow => ({
  subject: `row:${note.name}`,
  id: note.name as string,
  kind: noteFields(note).kind,
  synced: fingerprint(noteFields(note), noteFields(note).kind),
  presence: 'present',
  local: { title: local.title, body: local.body },
  ...over,
});

describe('fingerprint', () => {
  it('is short, and the same exactly when the note reads the same', () => {
    const fields = noteFields(listNote);
    const print = fingerprint(fields, 'list');
    expect(print).toMatch(/^[0-9a-f]{14}$/);
    expect(
      fingerprint(
        { title: ` ${fields.title} `, body: `${fields.body}\n\n` },
        'list',
      ),
    ).toBe(print);
    expect(
      fingerprint(
        { ...fields, body: fields.body.replace('[ ]', '[x]') },
        'list',
      ),
    ).not.toBe(print);
    expect(fingerprint(fields, 'text')).not.toBe(print);
  });
});

describe('plan', () => {
  it('imports every note the table never held', () => {
    const actions = plan({
      rows: [],
      locals: [],
      notes,
      complete: true,
      known: [],
    });
    expect(actions.map(a => a.kind)).toEqual(Array(5).fill('import'));
  });

  it('does nothing when Keep only re-saved the note', () => {
    expect(
      plan({
        rows: [known(textNote)],
        locals: [],
        notes: [{ ...textNote, updateTime: '2026-03-05T00:00:00Z' }],
        complete: true,
        known: [],
      })[0],
    ).toMatchObject({ kind: 'unchanged', clean: true });
  });

  it('does nothing when neither side changed', () => {
    const actions = plan({
      rows: [known(textNote)],
      locals: [],
      notes: [textNote],
      complete: true,
      known: [],
    });
    expect(actions).toEqual([
      { kind: 'unchanged', subject: 'row:notes/synthetic-note-1', clean: true },
    ]);
  });

  it('pulls a change made in Keep', () => {
    const edited = {
      ...textNote,
      title: 'New',
      updateTime: '2026-03-01T00:00:00Z',
    };
    expect(
      plan({
        rows: [known(textNote)],
        locals: [],
        notes: [edited],
        complete: true,
        known: [],
      })[0],
    ).toMatchObject({ kind: 'pull' });
  });

  it('pushes a change made here', () => {
    const row = known(textNote, { title: 'Mine', body: 'x', kind: 'text' });
    expect(
      plan({
        rows: [row],
        locals: [],
        notes: [textNote],
        complete: true,
        known: [],
        account: synthetic.OWNER,
      })[0],
    ).toMatchObject({
      kind: 'push',
      fields: { title: 'Mine', body: 'x', kind: 'text' },
    });
  });

  it('marks a conflict when both sides changed differently, and rebases when they agree', () => {
    const theirs = {
      ...textNote,
      title: 'Theirs',
      updateTime: '2026-03-01T00:00:00Z',
    };
    const mine = known(textNote, {
      title: 'Mine',
      body: noteFields(textNote).body,
      kind: 'text',
    });
    expect(
      plan({
        rows: [mine],
        locals: [],
        notes: [theirs],
        complete: true,
        known: [],
      })[0].kind,
    ).toBe('conflict');
    const same = known(textNote, {
      title: 'Theirs',
      body: noteFields(textNote).body,
      kind: 'text',
    });
    expect(
      plan({
        rows: [same],
        locals: [],
        notes: [theirs],
        complete: true,
        known: [],
      })[0].kind,
    ).toBe('rebase');
  });

  it('blocks a change to a shared note', () => {
    const row = known(shared, { title: 'Mine', body: 'x', kind: 'text' });
    expect(
      plan({
        rows: [row],
        locals: [],
        notes: [shared],
        complete: true,
        known: [],
        account: synthetic.OWNER,
      })[0],
    ).toMatchObject({ kind: 'blocked' });
  });

  it('creates a note for a row made here, as a list when it is a checklist, and skips an empty row', () => {
    const actions = plan({
      rows: [],
      locals: [
        { subject: 'a', local: { title: 'T', body: '- [ ] x' } },
        { subject: 'b', local: { title: '', body: ' ' } },
      ],
      notes: [],
      complete: true,
      known: [],
    });
    expect(actions[0]).toMatchObject({
      kind: 'create',
      fields: { kind: 'list' },
    });
    expect(actions[1]).toMatchObject({ kind: 'unchanged' });
  });

  it('settles a note that left the list by what its lookup says', () => {
    const rows = [known(textNote), known(listNote), known(untitled)];
    const actions = plan({
      rows,
      locals: [],
      notes: [],
      complete: true,
      known: [],
      lookups: [
        {
          id: textNote.name as string,
          status: 200,
          body: { ...textNote, trashed: true },
        },
        { id: listNote.name as string, status: 404 },
        { id: untitled.name as string, error: 'offline' },
      ],
    });
    expect(actions.map(a => a.kind === 'settle' && a.presence)).toEqual([
      'trashed',
      'deleted',
      'unconfirmed',
    ]);
  });

  it('settles nothing after a partial read', () => {
    expect(
      plan({
        rows: [known(textNote)],
        locals: [],
        notes: [],
        complete: false,
        known: [],
      })[0].kind,
    ).toBe('unchanged');
  });

  it('does not import again a note whose row was deleted here, nor an old note being retired', () => {
    const actions = plan({
      rows: [],
      locals: [],
      notes: [textNote, listNote],
      complete: true,
      known: [textNote.name as string],
      retiring: [listNote.name as string],
    });
    expect(actions).toEqual([{ kind: 'removed-here', note: textNote }]);
  });

  it('does not send an edit to a trashed note', () => {
    const row = known(
      textNote,
      { title: 'Mine', body: 'x', kind: 'text' },
      { presence: 'trashed' },
    );
    expect(
      plan({ rows: [row], locals: [], notes: [], complete: true, known: [] })[0]
        .kind,
    ).toBe('unchanged');
  });
});
