/**
 * SYNTHETIC Google Keep data. NOT RECORDED.
 *
 * Hand-written from the Keep API v1 reference
 * (https://developers.google.com/workspace/keep/api/reference/rest/v1/notes)
 * and the pinned OpenAPI document APIs/googleapis.com/keep/v1 at
 * 091431739208d017c11b0b0589ab33293f8b3690: the field names, their types and
 * the paged envelope `{ notes, nextPageToken }`. Every name, title, text,
 * address and timestamp is invented; the ids say so (`synthetic-…`) and the
 * addresses are at example.com. None belongs to a real account.
 *
 * What this cannot tell you: whether real responses carry fields this file
 * does not; whether Keep lists a note shared with the account; what a
 * note's `permissions` hold for a personal account (the Keep API is offered
 * to Google Workspace accounts only); and what `GET notes/{id}` answers for
 * a trashed note (the reference documents `trashed: true` on the resource,
 * which `trashNote` in scenario.mjs models). Those are modelling choices,
 * declared, not verified against Google.
 *
 * The five notes cover what notes.ts reads: a text note, a list note with a
 * checked item and a child item, a note with no title, a shared note and a
 * note with an attachment (the last two are never replaced).
 */

export const SYNTHETIC = true;

export const OWNER = 'synthetic-owner@example.com';
export const FRIEND = 'synthetic-friend@example.com';

export const owner = (id, email = OWNER) => ({
  name: `notes/${id}/permissions/synthetic-perm-owner`,
  role: 'OWNER',
  email,
  user: { email },
});

export const writer = (id, email = FRIEND) => ({
  name: `notes/${id}/permissions/synthetic-perm-writer`,
  role: 'WRITER',
  email,
  user: { email },
});

function note(n, over = {}) {
  const id = `synthetic-note-${n}`;

  return {
    name: `notes/${id}`,
    createTime: `2026-02-0${n}T08:00:00.000Z`,
    updateTime: `2026-02-0${n}T08:30:00.000Z`,
    trashed: false,
    permissions: [owner(id)],
    ...over,
  };
}

const text = value => ({ text: { text: value } });
const item = (value, checked = false, children) => ({
  text: { text: value },
  checked,
  ...(children ? { childListItems: children } : {}),
});

export const notes = [
  note(1, {
    title: 'Synthetic shopping ideas',
    body: text('Invented cheese\nPretend bread'),
  }),
  note(2, {
    title: 'Synthetic packing list',
    body: {
      list: {
        listItems: [
          item('Imaginary passport', true),
          item('Made-up charger', false, [item('Fictional adapter')]),
        ],
      },
    },
  }),
  note(3, { body: text('A synthetic note Keep sent without a title.') }),
  note(4, {
    title: 'Synthetic team plan',
    body: text('Shared with an invented friend.'),
    permissions: [owner('synthetic-note-4'), writer('synthetic-note-4')],
  }),
  note(5, {
    title: 'Synthetic whiteboard photo',
    body: text('See the pretend picture.'),
    attachments: [
      {
        name: 'notes/synthetic-note-5/attachments/synthetic-attachment-1',
        mimeType: ['image/png'],
      },
    ],
  }),
];
