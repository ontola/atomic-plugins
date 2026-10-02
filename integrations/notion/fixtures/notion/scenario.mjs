/**
 * Synthetic Notion fixture for the mock integration proxy: one shared data
 * source with three pages. Authored from Notion's documented
 * response shapes (API version 2026-03-11), not recorded from a live
 * workspace; see PARALLEL_LANES.md for the recorder that does not exist yet.
 *
 * What it checks, so a reader that gets these wrong fails here rather than
 * against Notion:
 * - both list operations are POST with a JSON body (`jsonBody`);
 * - the data source query pages two at a time whatever `page_size` asks for,
 *   so the third page is only reachable by sending `next_cursor` back as the
 *   body's `start_cursor`. An unknown cursor is a 400, as in Notion;
 * - search honours `filter.value` (`data_source` or `page`);
 * - `GET /v1/pages/{id}` reads one page;
 * - `PATCH /v1/pages/{id}` updates page properties the way Notion documents
 *   it: properties keyed by id or name, each `{ [type]: value }` with the
 *   property's own type, options by id (an unknown option id is a 400), a
 *   page that is archived or in trash is a 400, and `last_edited_time`
 *   becomes the current time. It answers the whole updated page;
 * - every other write (page creation, DELETE, data-source PATCH) is a 403.
 *
 * `requests` records `{ method, path, body }` for tests.
 *
 * Scenarios (the drive app's states, #89), switched per instance with
 * `setScenario(name)`, over HTTP from an e2e spec as
 * `POST /fixture/notion/setScenario` with `["<name>"]`:
 * - `default`: the one data source above;
 * - `two-sources`: also a "Reading list" data source whose "Status" has
 *   another property id, a "Format" select, plus a people and a date property
 *   (not projected);
 * - `empty`: the search shares no data source;
 * - `unauthorized`: every request answers 401 (the connection was revoked);
 * - `rate-limited`: the search works, every query answers 429 with
 *   `retry-after: 120`;
 * - `bad-gateway`: every request answers 502.
 * `renameOption(id, name)` renames a select/status/multi-select option in
 * every schema, as a rename in Notion does; pages keep the option's id.
 * `editPage(id, properties)` changes a page as someone editing it in Notion
 * would (the same `properties` a PATCH body carries), `getPage(id)` reads
 * one whatever the scenario, and `archivePage(id)` moves it to the trash.
 *
 * For the live-check kit's offline tests (notion/live/fakeNotion.ts), not
 * the mock proxy: `notionFixture({ blank: true })` starts with no pages, and
 * `createPage(properties)` adds one to the first data source the way a
 * `POST /v1/pages` would (the HTTP route stays a 403 here). Neither is in
 * `drivers`, so neither is reachable over the mock proxy.
 */
import { readFileSync } from 'node:fs';

export const DATA_SOURCE = '248104cd-477e-80af-bc30-000bd28de8f9';
const DATABASE = '248104cd-477e-8045-a9b1-e1b1b54c0b9f';
const USER = { object: 'user', id: '6794760a-1f15-45cd-9c65-0dfe42f5135a' };
const STAMP = '2026-09-01T10:00:00.000Z';

const text = (content, annotations = {}) => ({
  type: 'text',
  text: { content, link: null },
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default',
    ...annotations,
  },
  plain_text: content,
  href: null,
});

const option = (id, name, color) => ({ id, name, color });
const TODO = option(
  'b1f5a3c2-0001-4000-8000-000000000001',
  'Not started',
  'default',
);
const DOING = option(
  'b1f5a3c2-0001-4000-8000-000000000002',
  'In progress',
  'blue',
);
const DONE = option('b1f5a3c2-0001-4000-8000-000000000003', 'Done', 'green');
const DOCS = option('c2e6b4d3-0002-4000-8000-000000000001', 'docs', 'purple');
const RELEASE = option(
  'c2e6b4d3-0002-4000-8000-000000000002',
  'release',
  'red',
);

/** Property ids are Notion's short, case-sensitive, percent-encoded ids. */
const schema = {
  Name: { id: 'title', name: 'Name', type: 'title', title: {} },
  Status: {
    id: '%3AUPp',
    name: 'Status',
    type: 'status',
    status: { options: [TODO, DOING, DONE], groups: [] },
  },
  Done: { id: 'BJXS', name: 'Done', type: 'checkbox', checkbox: {} },
  Points: {
    id: 'n%3D1',
    name: 'Points',
    type: 'number',
    number: { format: 'number' },
  },
  Tags: {
    id: 'Tg%5Cq',
    name: 'Tags',
    type: 'multi_select',
    multi_select: { options: [DOCS, RELEASE] },
  },
  Notes: { id: 'Nt0s', name: 'Notes', type: 'rich_text', rich_text: {} },
};

export const dataSource = {
  object: 'data_source',
  id: DATA_SOURCE,
  created_time: STAMP,
  last_edited_time: STAMP,
  created_by: USER,
  last_edited_by: USER,
  title: [text('Roadmap')],
  description: [],
  properties: schema,
  parent: { type: 'database_id', database_id: DATABASE },
  database_parent: { type: 'workspace', workspace: true },
  url: `https://www.notion.so/${DATABASE.replaceAll('-', '')}`,
  archived: false,
  in_trash: false,
};

function page(id, { name, status, done, points, tags, notes }) {
  const value = (key, content) => ({
    id: schema[key].id,
    type: schema[key].type,
    [schema[key].type]: content,
  });

  return {
    object: 'page',
    id,
    created_time: STAMP,
    last_edited_time: STAMP,
    created_by: USER,
    last_edited_by: USER,
    cover: null,
    icon: null,
    parent: {
      type: 'data_source_id',
      data_source_id: DATA_SOURCE,
      database_id: DATABASE,
    },
    archived: false,
    in_trash: false,
    properties: {
      Name: value('Name', [text(name)]),
      Status: value('Status', status),
      Done: value('Done', done),
      Points: value('Points', points),
      Tags: value('Tags', tags),
      Notes: value('Notes', notes),
    },
    url: `https://www.notion.so/${name.replaceAll(' ', '-')}-${id.replaceAll('-', '')}`,
    public_url: null,
  };
}

export const pages = [
  page('1a2b3c4d-0000-4000-8000-000000000001', {
    name: 'Launch plan',
    status: DOING,
    done: false,
    points: 3,
    tags: [RELEASE, DOCS],
    notes: [text('Plain notes')],
  }),
  page('1a2b3c4d-0000-4000-8000-000000000002', {
    name: 'Write changelog',
    status: DONE,
    done: true,
    points: 0,
    tags: [],
    notes: [],
  }),
  page('1a2b3c4d-0000-4000-8000-000000000003', {
    name: 'Retrospective',
    status: TODO,
    done: false,
    points: null,
    tags: [DOCS],
    // Formatted text: the read-only lens leaves this unprojected and says so.
    notes: [text('Keep this '), text('bold', { bold: true })],
  }),
];

export const DATA_SOURCE_2 = '3a91e0c2-5d10-4c3e-9f00-00000000d502';
const DATABASE_2 = '3a91e0c2-5d10-4c3e-9f00-00000000db02';
const TO_READ = option(
  'd3f7c5e4-0003-4000-8000-000000000001',
  'To read',
  'gray',
);
const READING = option(
  'd3f7c5e4-0003-4000-8000-000000000002',
  'Reading',
  'yellow',
);
const FINISHED = option(
  'd3f7c5e4-0003-4000-8000-000000000003',
  'Finished',
  'green',
);

const BOOK = option('e4a8d6f5-0004-4000-8000-000000000001', 'Book', 'orange');
const ARTICLE = option(
  'e4a8d6f5-0004-4000-8000-000000000002',
  'Article',
  'blue',
);

/** Another database's "Status": same name and type, another property id. */
const schema2 = {
  Title: { id: 'title', name: 'Title', type: 'title', title: {} },
  Status: {
    id: 'st%3D2',
    name: 'Status',
    type: 'status',
    status: { options: [TO_READ, READING, FINISHED], groups: [] },
  },
  // A plain select next to the status, so both option kinds are served.
  Format: {
    id: 'fm%3Ak',
    name: 'Format',
    type: 'select',
    select: { options: [BOOK, ARTICLE] },
  },
  Author: { id: 'au%3Bx', name: 'Author', type: 'rich_text', rich_text: {} },
  Link: { id: 'lk%7Dq', name: 'Link', type: 'url', url: {} },
  'Recommended by': {
    id: 'pp%3Fz',
    name: 'Recommended by',
    type: 'people',
    people: {},
  },
  'Date read': { id: 'dt%40r', name: 'Date read', type: 'date', date: {} },
};

export const dataSource2 = {
  ...dataSource,
  id: DATA_SOURCE_2,
  title: [text('Reading list')],
  properties: schema2,
  parent: { type: 'database_id', database_id: DATABASE_2 },
  url: `https://www.notion.so/${DATABASE_2.replaceAll('-', '')}`,
};

function page2(id, { title, status, format, author, link, edited }) {
  const value = (key, content) => ({
    id: schema2[key].id,
    type: schema2[key].type,
    [schema2[key].type]: content,
  });

  return {
    object: 'page',
    id,
    created_time: STAMP,
    last_edited_time: edited,
    created_by: USER,
    last_edited_by: USER,
    cover: null,
    icon: null,
    parent: {
      type: 'data_source_id',
      data_source_id: DATA_SOURCE_2,
      database_id: DATABASE_2,
    },
    archived: false,
    in_trash: false,
    properties: {
      Title: value('Title', [text(title)]),
      Status: value('Status', status),
      Format: value('Format', format),
      Author: value('Author', [text(author)]),
      Link: value('Link', link),
      'Recommended by': value('Recommended by', []),
      'Date read': value('Date read', null),
    },
    url: `https://www.notion.so/${title.replaceAll(/\W+/g, '-')}-${id.replaceAll('-', '')}`,
    public_url: null,
  };
}

export const pages2 = [
  page2('2b3c4d5e-0000-4000-8000-000000000001', {
    title: 'Thinking in Systems',
    status: READING,
    format: BOOK,
    author: 'Donella Meadows',
    link: 'https://example.org/thinking-in-systems',
    edited: '2026-09-02T09:30:00.000Z',
  }),
  page2('2b3c4d5e-0000-4000-8000-000000000002', {
    title: 'Local-first software',
    status: FINISHED,
    format: ARTICLE,
    author: 'Kleppmann et al.',
    link: null,
    edited: '2026-08-28T15:00:00.000Z',
  }),
];

export const SCENARIOS = [
  'default',
  'two-sources',
  'empty',
  'unauthorized',
  'rate-limited',
  'bad-gateway',
];

/** Page size the fixture serves, whatever the request asks for. */
export const FIXTURE_PAGE_SIZE = 2;

const normalize = id => String(id).replaceAll('-', '').toLowerCase();
const error = (status, code, message) => ({
  status,
  body: { object: 'error', status, code, message },
});
const list = (results, next, type) => ({
  status: 200,
  body: {
    object: 'list',
    results,
    next_cursor: next,
    has_more: next !== null,
    type,
    [type]: {},
  },
});

function paginate(items, body, type) {
  const size = Math.min(Number(body.page_size ?? 100), FIXTURE_PAGE_SIZE);
  if (!Number.isInteger(size) || size < 1)
    return error(400, 'validation_error', 'page_size should be 1 to 100');
  let offset = 0;

  if (body.start_cursor !== undefined) {
    const match = /^cursor-(\d+)$/.exec(String(body.start_cursor));
    if (!match || Number(match[1]) >= items.length)
      return error(400, 'validation_error', 'start_cursor is invalid');
    offset = Number(match[1]);
  }

  const end = offset + size;

  return list(
    items.slice(offset, end),
    end < items.length ? `cursor-${end}` : null,
    type,
  );
}

/** Rich text objects for plain `content` parts, as Notion stores them. */
const richText = parts =>
  parts.map(part => text(String(part?.text?.content ?? '')));

/**
 * Applies a PATCH body's `properties` to `page` as Notion would, or returns
 * the error Notion would answer. Nothing changes unless every property is
 * valid.
 */
function patchPage(target, schemaOf, properties) {
  if (target.archived || target.in_trash)
    return error(
      400,
      'validation_error',
      "Can't edit block that is archived. You must unarchive the block before editing.",
    );
  const next = structuredClone(target.properties);

  for (const [key, change] of Object.entries(properties ?? {})) {
    const name = Object.keys(next).find(n => n === key || next[n].id === key);
    if (!name)
      return error(
        400,
        'validation_error',
        `${key} is not a property that exists.`,
      );
    const { type } = next[name];
    if (!change || typeof change !== 'object' || !(type in change))
      return error(
        400,
        'validation_error',
        `${name} is expected to be ${type}.`,
      );
    const value = change[type];
    const options = schemaOf[name]?.[type]?.options ?? [];
    const known = v => options.find(o => o.id === v?.id);

    if (type === 'title' || type === 'rich_text') {
      if (!Array.isArray(value))
        return error(400, 'validation_error', `${name} is not an array.`);
      next[name][type] = richText(value);
    } else if (type === 'select' || type === 'status') {
      if (value !== null && !known(value))
        return error(400, 'validation_error', `Invalid ${type} option.`);
      next[name][type] = value === null ? null : known(value);
    } else if (type === 'multi_select') {
      if (!Array.isArray(value) || !value.every(known))
        return error(400, 'validation_error', 'Invalid multi_select option.');
      next[name][type] = value.map(known);
    } else if (
      ['number', 'checkbox', 'url', 'email', 'phone_number'].includes(type)
    ) {
      next[name][type] = value;
    } else
      return error(
        400,
        'validation_error',
        `${name} cannot be edited in this fixture.`,
      );
  }

  target.properties = next;
  target.last_edited_time = new Date().toISOString();

  return { status: 200, body: target };
}

export function notionFixture({ scenario = 'default', blank = false } = {}) {
  const requests = [];
  // Per instance, so a rename in one test or lane never leaks into another.
  const data = structuredClone({
    sources: [
      { source: dataSource, pages },
      { source: dataSource2, pages: pages2 },
    ],
  });
  let current = scenario;
  let created = 0;
  if (blank) for (const entry of data.sources) entry.pages = [];

  // Any page, whatever the scenario shares, with the data source it is in.
  const locate = id => {
    for (const { source, pages: sourcePages } of data.sources) {
      const found = sourcePages.find(p => normalize(p.id) === normalize(id));
      if (found) return { page: found, source };
    }

    return undefined;
  };

  const shared = () =>
    current === 'empty'
      ? []
      : current === 'two-sources'
        ? data.sources
        : data.sources.slice(0, 1);

  return {
    requests,
    setScenario(name) {
      if (!SCENARIOS.includes(name))
        throw new Error(`Unknown notion scenario ${name}`);
      current = name;

      return { scenario: current };
    },
    renameOption(id, name) {
      let renamed = 0;

      const rename = options => {
        for (const o of options ?? [])
          if (o.id === id) {
            o.name = name;
            renamed++;
          }
      };

      for (const { source, pages: sourcePages } of data.sources) {
        for (const property of Object.values(source.properties))
          rename(property[property.type]?.options);

        for (const p of sourcePages)
          for (const value of Object.values(p.properties)) {
            const v = value[value.type];
            if (Array.isArray(v)) rename(v);
            else if (v && typeof v === 'object' && 'id' in v) rename([v]);
          }
      }

      if (!renamed) throw new Error(`No option ${id}`);

      return { renamed };
    },
    editPage(id, properties) {
      const found = locate(id);
      if (!found) throw new Error(`No page ${id}`);
      const result = patchPage(found.page, found.source.properties, properties);
      if (result.status !== 200) throw new Error(result.body.message);

      return { last_edited_time: found.page.last_edited_time };
    },
    createPage(properties) {
      const id = `9f000000-0000-4000-8000-${String(++created).padStart(12, '0')}`;
      const entry = data.sources[0];
      const made = page(id, {
        name: 'Untitled',
        status: null,
        done: false,
        points: null,
        tags: [],
        notes: [],
      });
      const result = patchPage(made, entry.source.properties, properties);
      if (result.status !== 200) return result;
      made.created_time = made.last_edited_time = new Date().toISOString();
      entry.pages.push(made);

      return { status: 200, body: structuredClone(made) };
    },
    getPage(id) {
      const found = locate(id);
      if (!found) throw new Error(`No page ${id}`);

      return structuredClone(found.page);
    },
    archivePage(id) {
      const found = locate(id);
      if (!found) throw new Error(`No page ${id}`);
      found.page.archived = true;
      found.page.in_trash = true;
      found.page.last_edited_time = new Date().toISOString();

      return { archived: id };
    },
    request(method, url, body) {
      const path = url.pathname.replace(/^\/proxy\/notion/, '');
      requests.push({ method, path, body });

      if (current === 'unauthorized')
        return error(401, 'unauthorized', 'API token is invalid.');
      if (current === 'bad-gateway')
        return error(502, 'bad_gateway', 'Upstream did not answer');

      if (method === 'POST' && path === '/v1/search') {
        const kind = body?.filter?.value;
        const sources = shared();
        const results =
          kind === 'data_source'
            ? sources.map(s => s.source)
            : kind === 'page'
              ? sources.flatMap(s => s.pages)
              : sources.flatMap(s => [s.source, ...s.pages]);

        return paginate(results, body ?? {}, 'page_or_data_source');
      }

      const query = path.match(/^\/v1\/data_sources\/([^/]+)\/query$/);
      const find = id =>
        shared().find(s => normalize(s.source.id) === normalize(id));

      if (method === 'POST' && query) {
        const found = find(query[1]);
        if (!found)
          return error(404, 'object_not_found', 'Data source not found');
        if (current === 'rate-limited')
          return {
            ...error(429, 'rate_limited', 'Rate limited'),
            headers: { 'retry-after': '120' },
          };

        return paginate(found.pages, body ?? {}, 'page_or_data_source');
      }

      const source = path.match(/^\/v1\/data_sources\/([^/]+)$/);

      if (method === 'GET' && source) {
        const found = find(source[1]);

        return found
          ? { status: 200, body: found.source }
          : error(404, 'object_not_found', 'Data source not found');
      }

      const one = path.match(/^\/v1\/pages\/([^/]+)$/);

      if (method === 'GET' && one) {
        const found = shared()
          .flatMap(s => s.pages)
          .find(p => normalize(p.id) === normalize(one[1]));

        return found
          ? { status: 200, body: found }
          : error(404, 'object_not_found', 'Page not found');
      }

      if (method === 'PATCH' && one) {
        const found = locate(one[1]);
        if (!found || !shared().some(s => s.source.id === found.source.id))
          return error(404, 'object_not_found', 'Page not found');

        return patchPage(found.page, found.source.properties, body?.properties);
      }

      // Any other write: page creation (POST /v1/pages), a data-source
      // PATCH, DELETE.
      if (method !== 'GET')
        return error(403, 'restricted_resource', 'This fixture is read-only');

      return error(404, 'invalid_request_url', 'Not in the Notion fixture');
    },
  };
}

export default {
  title: 'Notion',
  // overlays/catalog/2026-10-02.json's notion entry as the proxy composes it; see
  // catalog/generate.py.
  // Read on first use, so importing this module (fakeStore.ts, in a jsdom
  // test too) does not touch the file system.
  get document() {
    return JSON.parse(
      readFileSync(
        new URL('../../catalog/notion.json', import.meta.url),
        'utf8',
      ),
    );
  },
  jsonBody: true,
  create: () => notionFixture(),
  drivers: [
    'setScenario',
    'renameOption',
    'editPage',
    'getPage',
    'archivePage',
  ],
};
