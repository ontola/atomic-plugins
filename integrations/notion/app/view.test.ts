// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewState } from './controller.js';
import type { SyncRecord } from './record.js';
import type { Row } from './rows.js';
import type { DataSourceReport, SchemaProperty } from './sync.js';
import { createApp, type App } from './view/app.js';
import { notes, pill, sources } from './view/model.js';

const NOW = Date.parse('2026-09-24T10:16:00Z');
const o = (id: string, name: string, color: string) => ({ id, name, color });
const STATUS = [
  o('s1', 'Not started', 'default'),
  o('s2', 'In progress', 'blue'),
  o('s3', 'Done', 'green'),
];
const READ = [o('r1', 'To read', 'gray'), o('r2', 'Finished', 'green')];
const P = (
  id: string,
  name: string,
  type: string,
  options?: typeof STATUS,
): SchemaProperty => ({
  id,
  name,
  type,
  ...(type === 'people' ? {} : { shortname: `notion-${id}` }),
  ...(options ? { options } : {}),
});

const report = (
  id: string,
  title: string,
  properties: SchemaProperty[],
  extra: Partial<DataSourceReport> = {},
): DataSourceReport => ({
  id,
  title,
  pages: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  properties,
  formatted: [],
  archived: [],
  errors: [],
  ...extra,
});

const roadmap = report(
  'd1',
  'Roadmap',
  [
    P('title', 'Name', 'title'),
    P('st', 'Status', 'status', STATUS),
    P('pt', 'Points', 'number'),
    P('dn', 'Done', 'checkbox'),
    P('ow', 'Owner', 'people'),
  ],
  { formatted: [{ page: 'p1', title: 'Launch plan', property: 'Notes' }] },
);
const reading = report('d2', 'Reading list', [
  P('title', 'Title', 'title'),
  P('st2', 'Status', 'status', READ),
  P('ln', 'Link', 'url'),
]);

const last: SyncRecord = {
  version: 1,
  at: NOW - 4 * 60_000,
  durationMs: 3000,
  created: 5,
  updated: 0,
  unchanged: 0,
  dataSources: [roadmap, reading],
  general: [],
};

const row = (
  subject: string,
  name: string,
  dataSource: string,
  lastEdited: number,
  values: Row['values'],
): Row => ({
  subject,
  name,
  pageId: subject.replace('row', 'p'),
  dataSource,
  url: `https://www.notion.so/${subject}`,
  lastEdited,
  values,
});

const rows: Row[] = [
  row('row1', 'Launch plan', 'Roadmap', NOW - 1000, {
    'notion-st': 's2',
    'notion-pt': 3,
    'notion-dn': false,
  }),
  row('row2', 'Write changelog', 'Roadmap', NOW - 5000, {
    'notion-st': 's3',
    'notion-pt': 0,
    'notion-dn': true,
  }),
  row('row3', 'Retrospective', 'Roadmap', NOW - 9000, {
    'notion-st': 'gone-option',
  }),
  row('row4', 'Thinking in Systems', 'Reading list', NOW - 3000, {
    'notion-st2': 'r1',
    'notion-ln': 'https://example.org/book',
  }),
  row('row5', 'Untitled draft', 'Roadmap', NOW - 20000, {}),
];

const ready: ViewState = { kind: 'ready', connectionId: 'c', rows, last };

describe('view model', () => {
  it('counts rows per database, the record’s databases first', () => {
    expect(sources(rows, last).map(s => [s.title, s.count])).toEqual([
      ['Roadmap', 4],
      ['Reading list', 1],
    ]);
    // A database the record does not list (deleted from Notion, rows kept)
    // still counts, after the record's.
    expect(
      sources(rows, { ...last, dataSources: [reading] }).map(s => [
        s.title,
        s.count,
      ]),
    ).toEqual([
      ['Reading list', 1],
      ['Roadmap', 4],
    ]);
    // Without a record, in the rows' order.
    expect(sources(rows).map(s => [s.title, s.count])).toEqual([
      ['Roadmap', 4],
      ['Reading list', 1],
    ]);
  });

  it('says what the pill says per state', () => {
    expect(pill(ready, NOW)).toEqual({ tone: 'warn', text: 'Synced · 1 note' });
    expect(
      pill({ ...ready, last: { ...last, dataSources: [reading] } }, NOW),
    ).toEqual({ tone: 'ok', text: 'Synced 4 min ago' });
    expect(
      pill(
        {
          kind: 'syncing',
          connectionId: 'c',
          rows,
          last,
          progress: [
            { dataSource: 'd1', title: 'Roadmap', phase: 'done', pages: 4 },
            {
              dataSource: 'd2',
              title: 'Reading list',
              phase: 'reading',
              pages: 1,
            },
          ],
        },
        NOW,
      ),
    ).toEqual({ tone: 'sync', text: 'Syncing… Reading list' });
    expect(
      pill(
        {
          kind: 'importing',
          connectionId: 'c',
          rows: [],
          progress: [
            { dataSource: 'd1', title: 'Roadmap', phase: 'done', pages: 4 },
            {
              dataSource: 'd2',
              title: 'Reading list',
              phase: 'reading',
              pages: 1,
            },
            { dataSource: 'd3', title: 'Hiring', phase: 'listing', pages: 0 },
          ],
        },
        NOW,
      )?.text,
    ).toBe('Importing 2 of 3 databases');
    expect(pill({ kind: 'reauth', at: NOW, rows }, NOW)).toEqual({
      tone: 'neg',
      text: 'Reconnect needed',
    });
    expect(
      pill({ kind: 'no-databases', connectionId: 'c', rows: [] }, NOW)?.text,
    ).toBe('No databases shared');
    expect(
      pill(
        {
          kind: 'failed',
          at: NOW,
          connectionId: 'c',
          rows,
          title: '',
          message: '',
          technical: '',
        },
        NOW,
      )?.text,
    ).toBe('Sync failed');
    expect(pill({ ...ready, last: undefined }, NOW)?.text).toBe(
      'Not synced yet',
    );
    expect(pill({ kind: 'not-connected' }, NOW)).toBeUndefined();
  });

  it('counts grouped notes, one per property with formatting', () => {
    expect(
      notes({
        ...last,
        general: ['Column "X" exists with another datatype; not imported'],
        dataSources: [
          {
            ...roadmap,
            formatted: [
              { page: 'a', title: 'a', property: 'Notes' },
              { page: 'b', title: 'b', property: 'Notes' },
            ],
            archived: ['c'],
          },
        ],
      }),
    ).toBe(3);
  });
});

describe('view (DOM)', () => {
  let app: App;
  let root: HTMLElement;
  const actions = {
    sync: vi.fn(),
    connect: vi.fn(),
    send: vi.fn(),
    discard: vi.fn(),
    resolve: vi.fn(),
  };

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root')!;
    for (const f of Object.values(actions)) f.mockReset();
    app = createApp(root, actions, { now: () => NOW, locale: 'en-GB' });
  });

  afterEach(() => {
    app.destroy();
    vi.useRealTimers();
  });

  const q = <T extends Element = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector);
  const all = (selector: string) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ];
  const buttons = () => all('button').map(b => b.textContent?.trim());

  it('S1: a host without the relay explains and offers no action', () => {
    app.render({ kind: 'no-proxy' });
    expect(q('h2')?.textContent).toMatch(
      /can’t connect apps to other services/,
    );
    expect(q('[role=status]')?.hidden).toBe(true);
    expect(buttons()).toEqual([]);
  });

  it('S2: first run offers exactly one action, Connect Notion', () => {
    app.render({ kind: 'not-connected' });
    expect(q('h2')?.textContent).toBe(
      'Bring your Notion databases into Atomic',
    );
    expect(buttons()).toEqual(['Connect Notion']);
    q<HTMLButtonElement>('button')!.click();
    expect(actions.connect).toHaveBeenCalledOnce();
  });

  it('S3: connecting shows a busy, disabled button', () => {
    app.render({ kind: 'connecting' });
    const button = q<HTMLButtonElement>('.pl-empty button')!;
    expect(button.textContent).toMatch(/Waiting for confirmation/);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('S4: first import lists each database’s progress', () => {
    app.render({
      kind: 'importing',
      connectionId: 'c',
      rows: [],
      progress: [
        { dataSource: 'd1', title: 'Roadmap', phase: 'done', pages: 24 },
        { dataSource: 'd2', title: 'Reading list', phase: 'reading', pages: 8 },
      ],
    });
    expect(all('.nt-progress li').map(li => li.textContent)).toEqual([
      'Roadmap24 pages',
      'Reading listReading… 8 pages',
    ]);
    expect(q('[role=status]')?.textContent).toBe('Importing 2 of 2 databases');
    expect(q<HTMLButtonElement>('[data-key=sync-now]')!.disabled).toBe(true);
    expect(q('.nt-summary')).toBeNull();
  });

  it('S5: nothing shared offers "Choose pages in Notion"', () => {
    app.render({
      kind: 'no-databases',
      connectionId: 'c',
      rows: [],
      last: { ...last, dataSources: [] },
    });
    expect(q('h2')?.textContent).toMatch(/didn’t share any databases/);
    q<HTMLButtonElement>('[data-key=choose]')!.click();
    expect(actions.connect).toHaveBeenCalledOnce();
  });

  it('status card (#177 Q9): databases with row counts, last sync, row total; no rows rendered', () => {
    app.render(ready);
    const card = q('[aria-label="Sync status"]')!;
    expect(all('.nt-s-dbs li').map(li => li.textContent)).toEqual([
      'Roadmap4 rows',
      'Reading list1 row',
    ]);
    // The databases block keeps when and how long; the shared card (Q-084,
    // first in the view) has the outcome, the counts and the row total.
    expect(q('[data-key=last-sync]')?.textContent).toMatch(
      /^Today, \d\d:\d\d · took 3 s$/,
    );
    expect(card.classList.contains('ss')).toBe(true);
    expect(card.nextElementSibling).toBe(q('.nt-summary'));
    expect(card.querySelector('[data-key=headline]')?.textContent).toBe(
      'Synced 4 min ago',
    );
    expect(card.querySelector('[data-key=counts]')?.textContent).toBe(
      'Last sync: 5 added, 0 updated, 0 unchanged',
    );
    expect(card.textContent).toContain('5 rows in this table');
    expect(card.querySelector('[data-key=mode]')?.textContent).toBe(
      'Edits here are sent to Notion after you review them.',
    );
    // Roadmap's one formatted page is a note: the card points at Sync details.
    expect(card.getAttribute('data-tone')).toBe('warn');
    expect(card.textContent).toContain('1 note from the last sync.');
    expect(q('.nt-summary')?.textContent).toContain(
      'Browse and edit the rows in the table',
    );
    // The host's table shows the rows; the app no longer does.
    expect(q('table')).toBeNull();
    expect(root.textContent).not.toContain('Launch plan');
    expect(q('.pl-connbar')?.textContent).toContain('2 databases');
    expect(q('.pl-connbar')?.textContent).toContain('Edits sent after review');
    // Without `openResource` on the host there is no "Open table".
    expect(q('[data-key=open-table]')).toBeNull();
    q<HTMLButtonElement>('[data-key=sync-now]')!.click();
    expect(actions.sync).toHaveBeenCalledOnce();
    // The card's "Sync details" opens the panel and does not close it again
    // through the document click handler.
    expect(q('.nt-details')).toBeNull();
    q<HTMLButtonElement>('[data-k=ss-details]')!.click();
    expect(q('.nt-details')).toBeTruthy();
  });

  it('says when the shared databases have no pages, and before the first sync', () => {
    app.render({ ...ready, rows: [] });
    expect(q('.ss')?.textContent).toContain('0 rows in this table');
    expect(q('.ss')?.textContent).toContain(
      'The shared databases have no pages. Add one in Notion, then sync again.',
    );
    // Connected, nothing stored yet: the import placeholder, not the card.
    app.render({ kind: 'ready', connectionId: 'c', rows: [] });
    expect(q('.nt-summary')).toBeNull();
    expect(q('.nt-import')?.textContent).toContain(
      'Asking Notion which databases it shares',
    );
  });

  it('keeps the one role=status element across renders', () => {
    app.render(ready);
    const status = q('[role=status]');
    app.render({ ...ready, kind: 'syncing', progress: [] });
    expect(q('[role=status]')).toBe(status);
    expect(status?.textContent).toBe('Syncing…');
    expect(all('[role=status]')).toHaveLength(1);
    // The card stays while a sync runs over existing rows.
    expect(q('.nt-summary')).toBeTruthy();
  });

  it('S10: sync details group warnings per database; Esc closes', () => {
    app.render(ready);
    q<HTMLButtonElement>('[data-key=details-toggle]')!.click();
    const details = q('[role=dialog][aria-label="Sync details"]')!;
    expect(details.textContent).toContain('Not copied: Owner people');
    expect(details.textContent).toContain(
      '1 page has formatting in Notes, so Notes was not copied for it.',
    );
    expect(details.querySelector('details summary')?.textContent).toBe(
      'Technical details',
    );
    details.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(q('[role=dialog]')).toBeNull();
    expect(document.activeElement?.getAttribute('data-key')).toBe(
      'details-toggle',
    );
  });

  it('S11–S13: one banner with one recovery action; role=alert only after a sync', () => {
    app.render({ kind: 'reauth', at: NOW, connectionId: 'c', rows, last });
    expect(q('.pl-banner')?.textContent).toContain('Your 5 rows are kept');
    expect(q('.pl-banner')?.getAttribute('role')).toBeNull();
    expect(all('.pl-banner button').map(b => b.textContent)).toEqual([
      'Reconnect Notion',
    ]);
    expect(q('[data-key=sync-now]')).toBeNull();
    expect(q('.pl-connbar')?.textContent).toContain('Access revoked');

    app.render({ ...ready, kind: 'syncing', progress: [] });
    app.render({
      kind: 'failed',
      at: NOW,
      connectionId: 'c',
      rows,
      last,
      title: 'Notion didn’t answer properly',
      message: 'Error (502).',
      technical: 'POST /v1/search → 502',
    });
    expect(q('.pl-banner')?.getAttribute('role')).toBe('alert');
    expect(q('.pl-banner pre')?.textContent).toBe('POST /v1/search → 502');
    // The card names the failure and the gap since the last good sync, and
    // stays write-back: the edits wait for a sync that succeeds.
    expect(q('.ss')?.getAttribute('data-tone')).toBe('neg');
    expect(q('.ss [data-key=headline]')?.textContent).toBe(
      'Sync failed just now',
    );
    expect(q('.ss [data-key=last-good]')?.textContent).toBe(
      'Last good sync 4 min ago.',
    );
    // The databases block agrees: the record is the last good sync, and it
    // keeps that sync's counts, which the card no longer shows.
    expect(q('.nt-s-facts dt')?.textContent).toBe('Last good sync');
    expect(q('[data-key=last-sync]')?.textContent).toMatch(
      /^Today, \d\d:\d\d · took 3 s · 5 new$/,
    );
    expect(q('.ss [data-key=mode]')?.textContent).toBe(
      'Edits here are sent to Notion after you review them. Sending waits until a sync succeeds.',
    );
    q<HTMLButtonElement>('[data-key=try-again]')!.click();
    expect(actions.sync).toHaveBeenCalledOnce();
  });

  it('S12: rate-limited retries by itself at retry-after', () => {
    vi.useFakeTimers();
    app.render({
      kind: 'rate-limited',
      at: NOW,
      connectionId: 'c',
      rows,
      last,
      retryAt: NOW + 30_000,
      pagesRead: 31,
      technical: '',
    });
    expect(q('.pl-banner')?.textContent).toContain('paused after 31 pages');
    expect(q<HTMLButtonElement>('[data-key=sync-now]')!.disabled).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(actions.sync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(actions.sync).toHaveBeenCalledOnce();
  });

  describe('S15/S16: changes to send and conflicts (#8)', () => {
    const changes = [
      {
        subject: 'row1',
        pageId: 'p1',
        name: 'Launch plan',
        dataSource: 'd1',
        dataSourceTitle: 'Roadmap',
        fields: [
          {
            id: 'st',
            shortname: 'notion-st',
            name: 'Status',
            type: 'status' as const,
            before: 's2',
            after: 's3',
          },
        ],
      },
      {
        subject: 'row2',
        pageId: 'p2',
        name: 'Write changelog',
        dataSource: 'd1',
        dataSourceTitle: 'Roadmap',
        fields: [
          {
            id: 'pt',
            shortname: 'notion-pt',
            name: 'Points',
            type: 'number' as const,
            before: 0,
            after: 2,
            notion: 5,
            conflict: true as const,
          },
        ],
      },
    ];

    it('counts unsent changes in a strip above the status card', () => {
      app.render({ ...ready, changes: [] });
      expect(q('.nt-changes')).toBeNull();
      app.render({ ...ready, changes });
      // Counted in rows, as the card right below counts (`writeQueue`).
      expect(q('.nt-changes')?.textContent).toContain(
        '2 changes not sent to Notion yet · 1 row also changed in Notion',
      );
      expect(q('.ss')?.textContent).toContain(
        '2 changes waiting to send to Notion; 1 held back until it is fixed.',
      );
      expect(q('.nt-summary')).toBeTruthy();
      // A row whose PATCH got no answer is still a change, but neither the
      // strip nor the card counts it as waiting: the strip agrees with the
      // card's "1 change waiting" and "1 change sent without an answer".
      app.render({
        ...ready,
        changes,
        outcomes: [
          {
            subject: changes[0]!.subject,
            name: changes[0]!.name,
            status: 'unknown',
            message: 'No answer from Notion.',
          },
        ],
      });
      expect(q('.nt-changes')?.textContent).toContain(
        '1 change not sent to Notion yet',
      );
      expect(q('.nt-changes')?.textContent).not.toContain('2 changes');
      expect(q('.ss')?.textContent).toContain(
        '1 change waiting to send to Notion',
      );
      expect(q('.ss')?.textContent).toContain(
        '1 change sent without an answer from Notion',
      );
    });

    it('reviews before → after with option names, sends only what can be sent', () => {
      app.render({ ...ready, changes });
      q<HTMLButtonElement>('[data-key="review-open"]')!.click();
      const review = q('.nt-review')!;
      // The review stands in for the status card.
      expect(q('.nt-summary')).toBeNull();
      expect(document.activeElement).toBe(review);
      const [first, second] = all('.nt-r-list > li');
      expect(first!.querySelector('.nt-r-before')?.textContent).toBe(
        'In progress',
      );
      expect(first!.querySelector('.nt-r-after')?.textContent).toBe('Done');
      expect(first!.querySelector('.nt-r-after .nt-tag')?.className).toContain(
        'c-green',
      );
      expect(second!.textContent).toContain('Also changed in Notion, to 5');
      const send = q<HTMLButtonElement>('[data-key="review-send"]')!;
      expect(send.textContent).toBe('Send 1 change');
      expect(review.textContent).toContain('1 row held back until resolved');
      send.click();
      expect(actions.send).toHaveBeenCalledTimes(1);
      q<HTMLButtonElement>('[data-key="use-notion:row2:notion-pt"]')!.click();
      expect(actions.resolve).toHaveBeenCalledWith(
        'row2',
        'notion-pt',
        'notion',
      );
      q<HTMLButtonElement>('[data-key="keep-mine:row2:notion-pt"]')!.click();
      expect(actions.resolve).toHaveBeenCalledWith('row2', 'notion-pt', 'mine');
      q<HTMLButtonElement>('[data-key="discard:row1"]')!.click();
      expect(actions.discard).toHaveBeenCalledWith('row1');
    });

    it('shows each row’s outcome, and disables Send while sending', () => {
      app.render({ ...ready, changes });
      q<HTMLButtonElement>('[data-key="review-open"]')!.click();
      app.render({
        ...ready,
        changes: changes.slice(1),
        sending: true,
        outcomes: [
          { subject: 'row1', name: 'Launch plan', status: 'sent', fields: 1 },
        ],
      });
      expect(q<HTMLButtonElement>('[data-key="review-send"]')!.disabled).toBe(
        true,
      );
      expect(q('[data-outcome="sent"]')?.textContent).toBe('Sent to Notion');
      app.render({
        ...ready,
        changes: [],
        outcomes: [
          {
            subject: 'row1',
            name: 'Launch plan',
            status: 'unknown',
            message: 'No answer',
          },
        ],
      });
      expect(q('[data-outcome="unknown"]')?.textContent).toContain(
        'Unknown whether Notion applied it',
      );
      q<HTMLButtonElement>('[data-key="review-close"]')!.click();
      expect(q('.nt-review')).toBeNull();
      expect(q('.nt-summary')).toBeTruthy();
      expect(q('.nt-changes')?.textContent).toContain('Show results');
    });
  });

  describe('host operations since atomic-server 007869464', () => {
    const host = {
      ...actions,
      openTable: vi.fn(),
      disconnect: vi.fn(),
    };

    beforeEach(() => {
      app.destroy();
      for (const f of Object.values(host)) f.mockClear();
      app = createApp(root, host, { now: () => NOW, locale: 'en-GB' });
    });

    it('offers "Open table" on the card and in the menu', () => {
      app.render(ready);
      q<HTMLButtonElement>('[data-key=open-table]')!.click();
      expect(host.openTable).toHaveBeenCalledOnce();
      q<HTMLButtonElement>('[data-key="menu:More"]')!.click();
      const item = all('[role=menuitem]').find(
        b => b.textContent === 'Open data table',
      )!;
      item.click();
      expect(host.openTable).toHaveBeenCalledTimes(2);
      expect(q('[role=menu]')).toBeNull();
    });

    it('asks before disconnecting, in place of the state banner; Cancel does nothing', () => {
      app.render({ kind: 'no-databases', connectionId: 'c', rows, last });
      q<HTMLButtonElement>('[data-key="menu:More"]')!.click();
      all('[role=menuitem]')
        .find(b => b.textContent === 'Disconnect Notion…')!
        .click();
      expect(all('.pl-banner').map(b => b.textContent)).toEqual([
        expect.stringContaining('Disconnect Notion from this app?'),
      ]);
      expect(document.activeElement?.getAttribute('data-key')).toBe(
        'disconnect-cancel',
      );
      q<HTMLButtonElement>('[data-key=disconnect-cancel]')!.click();
      expect(q('.pl-banner')?.textContent).toContain(
        'no longer shares any databases',
      );
      expect(host.disconnect).not.toHaveBeenCalled();
      q<HTMLButtonElement>('[data-key="menu:More"]')!.click();
      all('[role=menuitem]')
        .find(b => b.textContent === 'Disconnect Notion…')!
        .click();
      q<HTMLButtonElement>('[data-key=disconnect-confirm]')!.click();
      expect(host.disconnect).toHaveBeenCalledOnce();
    });

    it('shows a disconnected app with its row count and one Connect action', () => {
      app.render({ kind: 'disconnected', rows, last });
      expect(q('[role=status]')?.textContent).toBe('Not connected');
      expect(q('.pl-banner')?.textContent).toContain(
        'Your 5 rows are kept but won’t update',
      );
      expect(all('.pl-banner button').map(b => b.textContent)).toEqual([
        'Connect Notion',
      ]);
      expect(q('[data-key=sync-now]')).toBeNull();
      // No connection: the card is read-only and says how to resume.
      expect(q('.ss')?.textContent).toContain('5 rows in this table');
      expect(q('.ss [data-key=mode]')?.textContent).toBe(
        'Read-only: edits here stay in Atomic. Notion is not connected to this app; connect it again to sync and send.',
      );
      // No connection: no "Choose pages in Notion", no Disconnect.
      q<HTMLButtonElement>('[data-key="menu:More"]')!.click();
      expect(all('[role=menuitem]').map(b => b.textContent)).toEqual([
        'Sync details',
        'Open data table',
      ]);
      q<HTMLButtonElement>('[data-key=reconnect]')!.click();
      expect(host.connect).toHaveBeenCalledOnce();
    });

    it('follows the host’s colour scheme, not a guess from the background', () => {
      app.setColorScheme('dark');
      expect(q('.pl-app')?.getAttribute('data-scheme')).toBe('dark');
      app.setColorScheme('light');
      expect(q('.pl-app')?.getAttribute('data-scheme')).toBe('light');
    });
  });
});

describe('theme tokens', () => {
  it('takes the success colour from the host', async () => {
    const { PL_CSS } = await import('./ui/styles.js');
    expect(PL_CSS).toContain('--pl-pos:var(--t-color-success,#2f8f5b)');
    expect(PL_CSS).toMatch(
      /\.pl-app\[data-scheme='dark'\]\{color-scheme:dark\}/,
    );
  });
});
