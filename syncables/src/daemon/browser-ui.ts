// @wc-ignore-file
/** Self-contained assets, served locally without a frontend build or CDN. */
export const BROWSER_HTML = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>SyncD · Connections and data</title>
    <link rel="stylesheet" href="/browser.css" />
    <script src="/browser.js" defer></script>
  </head>
  <body>
    <aside>
      <div class="brand">
        <span class="mark">S</span><strong>SyncD</strong
        ><span class="local">LOCAL</span>
      </div>
      <div class="nav-title">YOUR COLLECTIONS</div>
      <nav id="collections" aria-label="Synced collections"></nav>
      <div class="sidebar-note">
        <span class="dot"></span> Your data, on your device
      </div>
    </aside>
    <main>
      <header>
        <div>
          <div class="eyebrow">DATA BROWSER</div>
          <h1>Connections &amp; synced data</h1>
          <p>Your approved remote connections and saved local records.</p>
        </div>
        <span class="badge">Read only</span>
      </header>
      <div id="error" class="error" role="alert" hidden></div>
      <section class="connections-panel" aria-label="Remote connections">
        <div class="section-heading">
          <h2>Remote connections</h2>
          <button id="refresh-status" class="secondary">↻ Check status</button>
        </div>
        <p class="connections-caption">
          Connections approved for this SyncD access grant. Checking status does
          not fetch provider data.
        </p>
        <div id="discovery-message" role="status" aria-live="polite">
          Checking available connections…
        </div>
        <div id="remote-connections" class="connection-grid"></div>
        <p id="status-checked" class="checked"></p>
      </section>
      <section class="workspace">
        <div class="toolbar">
          <div>
            <h2 id="collection-title">Your collections</h2>
            <p id="collection-meta">
              Choose a collection to explore its saved records.
            </p>
          </div>
          <button id="refresh" class="secondary">↻ Refresh</button>
        </div>
        <div id="collection-status" class="collection-status" hidden></div>
        <div class="searchbar">
          <label for="search">Search records</label
          ><input
            id="search"
            type="search"
            placeholder="Search this collection…"
            maxlength="200"
            autocomplete="off"
            disabled
          /><span id="count"></span>
        </div>
        <div class="panes">
          <div class="records">
            <div id="empty" class="empty">
              <div class="empty-icon">▤</div>
              <h3>Everything you’ve synced, in one place</h3>
              <p>Select a collection in the sidebar to get started.</p>
            </div>
            <table id="table" hidden>
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Identifier</th>
                </tr>
              </thead>
              <tbody id="rows"></tbody>
            </table>
            <div class="pagination">
              <span id="page-label"></span>
              <div>
                <button id="previous" class="secondary" disabled>
                  ← Previous</button
                ><button id="next" class="secondary" disabled>Next →</button>
              </div>
            </div>
          </div>
          <section class="detail" aria-label="Record details">
            <div class="detail-heading">
              <span>RECORD DETAILS</span><span class="json-label">JSON</span>
            </div>
            <h3 id="record-title">Select a record</h3>
            <p id="record-id">Its saved data will appear here.</p>
            <pre id="json" tabindex="0" aria-label="Saved record JSON"></pre>
          </section>
        </div>
        <footer id="snapshot">
          Browsing local data never contacts your provider.
        </footer>
      </section>
    </main>
  </body>
</html>
`;

export const BROWSER_STYLE = `
:root {
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  color: #24312f;
  background: #f5f7f6;
  font-synthesis: none;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  display: flex;
  min-height: 100vh;
}
aside {
  width: 254px;
  background: #172d29;
  color: #e6efeb;
  padding: 32px 22px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 22px;
  letter-spacing: -0.7px;
}
.mark {
  display: grid;
  place-items: center;
  background: #b5e4c8;
  color: #16362c;
  border-radius: 9px;
  width: 33px;
  height: 35px;
  font-size: 23px;
  font-weight: 750;
}
.local {
  font-size: 9px;
  letter-spacing: 1px;
  border: 1px solid #49645b;
  border-radius: 4px;
  padding: 3px 5px;
  margin-left: auto;
  color: #b5c8bd;
}
.nav-title {
  font-size: 10px;
  letter-spacing: 1.6px;
  color: #90aaa0;
  margin: 49px 9px 15px;
}
nav {
  display: grid;
  gap: 6px;
  overflow-wrap: anywhere;
}
nav button {
  display: flex;
  align-items: center;
  text-align: left;
  border: 0;
  background: none;
  color: #c1d2ca;
  padding: 12px 10px;
  border-radius: 7px;
  gap: 10px;
  width: 100%;
}
nav button:hover,
nav button.active {
  background: #304a40;
  color: white;
}
nav button.active {
  box-shadow: inset 3px 0 #a6ddba;
}
nav .name {
  display: block;
  text-transform: capitalize;
  font-size: 13px;
  font-weight: 600;
}
nav small {
  display: block;
  font-size: 10px;
  color: #a6bcb1;
  margin-top: 5px;
}
.dot {
  width: 6px;
  height: 6px;
  display: inline-block;
  border-radius: 50%;
  background: #9cd6ae;
  flex-shrink: 0;
}
.dot.off {
  background: #73867c;
}
.sidebar-note {
  font-size: 10px;
  color: #91aa9e;
  margin-top: auto;
  padding: 40px 7px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
main {
  padding: 42px 44px;
  flex: 1;
  min-width: 0;
  max-width: 1700px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
}
.eyebrow {
  color: #648376;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.8px;
}
h1 {
  font-size: 30px;
  letter-spacing: -1px;
  margin: 10px 0;
}
header p,
.toolbar p {
  font-size: 13px;
  color: #728079;
  margin: 0;
}
.badge {
  font-size: 11px;
  border: 1px solid #d6e3d9;
  border-radius: 20px;
  padding: 8px 13px;
  color: #557562;
  background: #edf4ee;
}
.workspace {
  background: white;
  border: 1px solid #dfe7e1;
  border-radius: 12px;
  box-shadow: 0 4px 14px #233e2804;
  overflow: hidden;
}
.toolbar {
  padding: 25px 26px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  font-size: 18px;
  margin: 0 0 6px;
  text-transform: capitalize;
  letter-spacing: -0.3px;
}
.toolbar p {
  font-size: 11px;
}
button,
input {
  font: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: default;
  opacity: 0.45;
}
.secondary {
  background: white;
  border: 1px solid #dfe5e0;
  border-radius: 6px;
  padding: 8px 11px;
  color: #536b5d;
  font-size: 11px;
}
.secondary:hover:enabled {
  background: #f3f7f3;
}
button:focus-visible,
input:focus-visible,
pre:focus-visible {
  outline: 2px solid #519873;
  outline-offset: 3px;
}
.searchbar {
  display: flex;
  align-items: center;
  gap: 12px;
  border-top: 1px solid #edf0ed;
  border-bottom: 1px solid #e8eee9;
  padding: 15px 26px;
  background: #fcfdfb;
}
.searchbar label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
input {
  border: 1px solid #dfe6df;
  background: white;
  border-radius: 6px;
  padding: 9px 12px;
  font-size: 12px;
  width: 300px;
  max-width: 80%;
}
#count {
  margin-left: auto;
  color: #7b8a80;
  font-size: 11px;
}
.panes {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(280px, 0.9fr);
  min-height: 475px;
}
.records {
  min-width: 0;
  display: flex;
  flex-direction: column;
  max-height: 650px;
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  font-size: 9px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #8c978e;
  font-weight: 600;
  text-align: left;
  padding: 17px 24px;
  background: #fff;
}
th:first-child {
  width: 58%;
}
td {
  border-top: 1px solid #edf1ec;
  padding: 0 24px;
  height: 58px;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
td:last-child {
  font:
    10px ui-monospace,
    SFMono-Regular,
    monospace;
  color: #8b968e;
}
tr.selected td {
  background: #f0f6ee;
}
td button {
  background: none;
  border: 0;
  text-align: left;
  padding: 16px 0;
  max-width: 100%;
  color: #2f4a39;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
td button:hover {
  text-decoration: underline;
}
.pagination {
  position: sticky;
  bottom: 0;
  background: white;
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  border-top: 1px solid #edf1ec;
  padding: 16px 22px;
  font-size: 10px;
  color: #8c978e;
}
.pagination button {
  padding: 6px 8px;
  font-size: 10px;
  margin-left: 5px;
}
.detail {
  border-left: 1px solid #e7ece6;
  padding: 23px 25px;
  background: #fcfdfb;
  min-width: 0;
}
.detail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 9px;
  letter-spacing: 1.3px;
  color: #839180;
}
.json-label {
  border: 1px solid #e1e8dc;
  border-radius: 4px;
  padding: 3px 5px;
  font-size: 8px;
  letter-spacing: 0.5px;
}
.detail h3 {
  font-size: 15px;
  margin: 23px 0 6px;
  overflow-wrap: anywhere;
}
.detail p {
  font:
    10px ui-monospace,
    monospace;
  color: #8c978e;
  overflow-wrap: anywhere;
  margin: 0 0 20px;
}
pre {
  font:
    11px/1.8 ui-monospace,
    SFMono-Regular,
    monospace;
  color: #44634f;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 550px;
  overflow: auto;
  margin: 0;
}
footer {
  padding: 13px 25px;
  font-size: 10px;
  color: #8b978c;
  border-top: 1px solid #e8eee6;
}
.empty {
  padding: 70px 25px;
  text-align: center;
  color: #7d8d81;
}
.empty-icon {
  font-size: 30px;
  color: #9bbba3;
  margin-bottom: 15px;
}
.empty h3 {
  font-size: 14px;
  font-weight: 500;
  color: #52705d;
}
.empty p {
  font-size: 12px;
  line-height: 1.7;
}
.error {
  border: 1px solid #ebd5c4;
  border-radius: 6px;
  background: #fff8ef;
  color: #88552e;
  padding: 12px 16px;
  margin-bottom: 16px;
  font-size: 13px;
}
[hidden] {
  display: none !important;
}
@media (max-width: 1000px) {
  aside {
    width: 210px;
    padding: 26px 15px;
  }
  main {
    padding: 30px 22px;
  }
  .panes {
    grid-template-columns: 1fr;
  }
  .detail {
    border-left: 0;
    border-top: 1px solid #e7ece6;
    min-height: 250px;
  }
}
@media (max-width: 600px) {
  body {
    display: block;
  }
  aside {
    width: 100%;
    padding: 18px;
  }
  .nav-title {
    margin: 22px 0 10px;
  }
  nav {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .sidebar-note {
    display: none;
  }
  main {
    padding: 25px 14px;
  }
  header {
    margin-bottom: 24px;
  }
  h1 {
    font-size: 26px;
  }
  .toolbar,
  .searchbar {
    padding: 18px;
  }
  td,
  th {
    padding-left: 18px;
    padding-right: 18px;
  }
}

.connections-panel {
  margin-bottom: 26px;
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.section-heading h2 {
  font-size: 17px;
  text-transform: none;
}
.connections-caption {
  font-size: 12px;
  color: #728079;
  line-height: 1.6;
}
#discovery-message {
  font-size: 12px;
  line-height: 1.7;
  color: #7b6343;
  background: #fbf5e9;
  border: 1px solid #e8ddc7;
  border-radius: 7px;
  padding: 12px 15px;
  margin: 12px 0;
}
#discovery-message:empty {
  display: none;
}
.connection-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
  gap: 14px;
}
.connection-card {
  background: white;
  border: 1px solid #dfe7e1;
  border-radius: 10px;
  padding: 18px;
  min-width: 0;
}
.connection-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.connection-id {
  font-family: ui-monospace, monospace;
  font-size: 10px !important;
}
.connection-card h3 {
  margin: 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.connection-card p {
  font-size: 11px;
  color: #738278;
  line-height: 1.7;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.status-chip {
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  border-radius: 12px;
  padding: 5px 8px;
  display: inline-block;
  background: #edf4ee;
  color: #52745b;
}
.status-chip.attention {
  color: #99542f;
  background: #fcf0e4;
}
.status-chip.neutral {
  color: #6e7c74;
  background: #f0f3f0;
}
.connection-items {
  display: grid;
  gap: 6px;
  border-top: 1px solid #edf1ec;
  margin-top: 12px;
  padding-top: 10px;
}
.connection-items button {
  text-align: left;
  border: 0;
  background: none;
  padding: 5px 0;
  color: #3b6250;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.connection-items button:hover {
  text-decoration: underline;
}
.connection-items small {
  display: block;
  color: #7e8b81;
  font-size: 10px;
  margin-top: 3px;
}
.checked {
  text-align: right;
  color: #8c978e;
  font-size: 10px;
}
.collection-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 0 26px 18px;
  font-size: 11px;
  color: #738278;
}
.collection-status .status-error {
  flex-basis: 100%;
  color: #99542f;
  margin: 0;
  line-height: 1.6;
}
`;

export const BROWSER_SCRIPT = String.raw`
'use strict';
const el = (id) => document.getElementById(id);
let token = new URLSearchParams(location.hash.slice(1)).get('token');
try {
  if (token) sessionStorage.setItem('syncd-browser-token', token);
  else token = sessionStorage.getItem('syncd-browser-token');
} catch {}
if (location.hash) history.replaceState(null, '', location.pathname);
const state = {
  collection: '',
  revision: null,
  page: 1,
  pages: 0,
  controller: null,
};
async function api(path, signal) {
  const response = await fetch(path, {
    headers: { Authorization: 'Bearer ' + (token || '') },
    signal,
    cache: 'no-store',
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not load local data');
  return body;
}
function message(text) {
  el('error').textContent = text;
  el('error').hidden = !text;
}
function pretty(raw) {
  let out = '',
    depth = 0,
    quoted = false,
    escaped = false;
  const newline = String.fromCharCode(10);
  for (const char of raw) {
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char.charCodeAt(0) === 92) escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
    } else if (char === '{' || char === '[') {
      depth++;
      out += char + newline + '  '.repeat(depth);
    } else if (char === '}' || char === ']') {
      depth--;
      out += newline + '  '.repeat(depth) + char;
    } else if (char === ',') out += ',' + newline + '  '.repeat(depth);
    else if (char === ':') out += ': ';
    else if (char.trim()) out += char;
  }
  return out;
}
function selectRecord(record, row) {
  document
    .querySelectorAll('tr.selected')
    .forEach((item) => item.classList.remove('selected'));
  row.classList.add('selected');
  el('record-title').textContent = record.label;
  el('record-id').textContent = record.id;
  el('json').textContent = pretty(record.raw);
}
function clearDetail() {
  el('record-title').textContent = 'Select a record';
  el('record-id').textContent = 'Its saved data will appear here.';
  el('json').textContent = '';
}
async function loadRecords(reset = false) {
  if (!state.collection) return;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  if (reset) {
    state.page = 1;
    state.revision = null;
  }
  el('refresh').disabled = true;
  el('previous').disabled = true;
  el('next').disabled = true;
  el('rows').replaceChildren();
  el('table').hidden = true;
  clearDetail();
  el('empty').hidden = false;
  el('empty').replaceChildren();
  const loading = document.createElement('p');
  loading.textContent = 'Loading saved records…';
  el('empty').append(loading);
  const params = new URLSearchParams({
    collection: state.collection,
    page: String(state.page),
    q: el('search').value,
  });
  if (state.revision) params.set('revision', state.revision);
  try {
    message('');
    const result = await api('/api/records?' + params, controller.signal);
    if (controller.signal.aborted) return;
    state.revision = result.revision;
    state.pages = result.pages;
    el('count').textContent = result.total.toLocaleString() + ' records';
    el('page-label').textContent = result.pages
      ? 'Page ' + result.page + ' of ' + result.pages
      : '';
    el('snapshot').textContent = result.revision
      ? 'Showing a saved snapshot. Refresh to see newly synced records.'
      : 'This collection has no saved snapshot yet. Run a sync to populate it.';
    el('empty').hidden = result.records.length > 0;
    el('table').hidden = !result.records.length;
    if (!result.records.length) {
      el('empty').replaceChildren();
      const heading = document.createElement('h3');
      heading.textContent = !result.revision
        ? 'No synced data yet'
        : el('search').value
          ? 'No matching records'
          : 'This collection is empty';
      const note = document.createElement('p');
      note.textContent = !result.revision
        ? 'Sync this collection, then refresh to see your data.'
        : 'Try another search or select a different collection.';
      el('empty').append(heading, note);
    }
    for (const record of result.records) {
      const row = document.createElement('tr'),
        name = document.createElement('td'),
        id = document.createElement('td'),
        button = document.createElement('button');
      button.textContent = record.label;
      button.addEventListener('click', () => selectRecord(record, row));
      name.append(button);
      id.textContent = record.id;
      row.append(name, id);
      el('rows').append(row);
    }
    el('previous').disabled = state.page <= 1;
    el('next').disabled = state.page >= result.pages;
  } catch (error) {
    if (error.name !== 'AbortError') {
      message(error.message);
      el('empty').hidden = true;
    }
  } finally {
    if (!controller.signal.aborted) el('refresh').disabled = false;
  }
}
async function loadCollections() {
  try {
    const result = await api('/api/collections');
    el('collections').replaceChildren();
    for (const entry of result.collections) {
      const parts = entry.alias.split('/'),
        button = document.createElement('button'),
        dot = document.createElement('span'),
        text = document.createElement('span'),
        name = document.createElement('span'),
        account = document.createElement('small');
      button.dataset.alias = entry.alias;
      button.classList.toggle('active', state.collection === entry.alias);
      button.setAttribute(
        'aria-pressed',
        String(state.collection === entry.alias),
      );
      dot.className = 'dot' + (entry.synced ? '' : ' off');
      name.className = 'name';
      name.textContent = parts.slice(2).join(' / ') || entry.alias;
      account.textContent = parts.slice(0, 2).join(' / ');
      text.append(name, account);
      button.append(dot, text);
      button.addEventListener('click', () => {
        state.collection = entry.alias;
        el('search').value = '';
        el('search').disabled = false;
        el('collection-title').textContent = name.textContent;
        el('collection-meta').textContent = account.textContent;
        el('collections')
          .querySelectorAll('button')
          .forEach((node) => {
            node.classList.toggle('active', node === button);
            node.setAttribute('aria-pressed', String(node === button));
          });
        renderCollectionStatus();
        loadRecords(true);
      });
      el('collections').append(button);
    }
    if (!result.collections.length) {
      const note = document.createElement('p');
      note.textContent = 'No collections configured.';
      el('collections').append(note);
    }
  } catch (error) {
    message(error.message);
  }
}
const statusLabels = {
  'not-synced': 'Not synced yet',
  synced: 'Saved data available',
  pending: 'Scheduled',
  syncing: 'Syncing',
  'auth-error': 'Auth needs attention',
  'sync-error': 'Sync error',
  'checkout-blocked': 'Working folder blocked',
};
let latestStatus = null,
  checkingStatus = false;
function when(value, fallback = 'Never') {
  return value ? new Date(value).toLocaleString() : fallback;
}
function chip(state, label) {
  const node = document.createElement('span');
  node.className =
    'status-chip' +
    (/error|blocked|not-approved/.test(state)
      ? ' attention'
      : /not-synced|unknown|unconfigured/.test(state)
        ? ' neutral'
        : '');
  node.textContent = label || statusLabels[state] || state;
  return node;
}
function renderCollectionStatus() {
  const root = el('collection-status');
  root.replaceChildren();
  const entry = latestStatus?.collections.find(
    (item) => item.alias === state.collection,
  );
  root.hidden = !entry;
  if (!entry) return;
  root.append(chip(entry.state));
  for (const text of [
    'Last successful sync: ' +
      when(
        entry.lastSyncedAt,
        entry.hasSnapshot ? 'Not recorded for older data' : 'Never',
      ),
    'Last attempt: ' + when(entry.lastAttemptAt),
  ]) {
    const node = document.createElement('span');
    node.textContent = text;
    root.append(node);
  }
  if (entry.nextAttemptAt) {
    const next = document.createElement('span');
    next.textContent = 'Next sync due: ' + when(entry.nextAttemptAt);
    root.append(next);
  }
  if (entry.error) {
    const error = document.createElement('p');
    error.className = 'status-error';
    error.textContent =
      entry.error +
      (entry.lastFailureAt
        ? ' Last failure: ' + when(entry.lastFailureAt)
        : '');
    root.append(error);
  }
}
async function loadStatus() {
  if (checkingStatus) return;
  checkingStatus = true;
  el('refresh-status').disabled = true;
  try {
    const result = await api('/api/status');
    latestStatus = result;
    el('discovery-message').textContent = result.discovery.message || '';
    el('status-checked').textContent =
      'Last checked: ' + when(result.checkedAt);
    const root = el('remote-connections');
    root.replaceChildren();
    for (const connection of result.connections) {
      const card = document.createElement('article');
      card.className = 'connection-card';
      const top = document.createElement('div');
      top.className = 'connection-top';
      const title = document.createElement('h3');
      title.textContent = connection.label;
      const local = connection.collections;
      const issue = local.find((item) => /error|blocked/.test(item.state));
      const badge =
        connection.availability === 'not-approved'
          ? chip('not-approved', 'Not available to grant')
          : issue
            ? chip(issue.state)
            : local.some((item) => item.state === 'syncing')
              ? chip('syncing')
              : !local.length
                ? chip('unconfigured', 'Not configured here')
                : chip(
                    local.some((item) => item.hasSnapshot)
                      ? 'synced'
                      : 'not-synced',
                  );
      top.append(title, badge);
      card.append(top);
      const platform = document.createElement('p');
      platform.textContent =
        connection.platform +
        ' · ' +
        (connection.availability === 'approved'
          ? 'Approved for SyncD'
          : connection.availability === 'unknown'
            ? 'Remote access not checked'
            : 'Removed or not approved for this access grant');
      card.append(platform);
      const identity = document.createElement('p');
      identity.className = 'connection-id';
      identity.textContent = 'Connection: ' + connection.id;
      card.append(identity);
      const time = document.createElement('p');
      time.textContent =
        'Last successful sync (any collection): ' +
        when(
          connection.lastSyncedAt,
          local.some((item) => item.hasSnapshot)
            ? 'Not recorded for older data'
            : 'Never',
        );
      card.append(time);
      const list = document.createElement('div');
      list.className = 'connection-items';
      for (const entry of local) {
        const button = document.createElement('button');
        button.textContent = entry.alias;
        const detail = document.createElement('small');
        detail.textContent =
          (statusLabels[entry.state] || entry.state) +
          ' · ' +
          when(
            entry.lastSyncedAt,
            entry.hasSnapshot ? 'Sync time not recorded' : 'Never synced',
          );
        button.append(detail);
        button.addEventListener('click', () => {
          const buttons = Array.from(
            el('collections').querySelectorAll('button'),
          );
          buttons.find((item) => item.dataset.alias === entry.alias)?.click();
          el('collection-title').scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
          });
        });
        list.append(button);
      }
      if (!local.length) {
        const note = document.createElement('p');
        note.textContent =
          'Available remotely. Add a collection to your SyncD config to sync it here.';
        list.append(note);
      }
      card.append(list);
      root.append(card);
    }
    if (!result.connections.length && result.discovery.state === 'available') {
      const note = document.createElement('p');
      note.textContent =
        'No remote connections are approved for this SyncD grant.';
      root.append(note);
    }
    renderCollectionStatus();
  } catch {
    el('discovery-message').textContent =
      'Could not refresh connection status. Showing the last known results; local data remains available.';
  } finally {
    checkingStatus = false;
    el('refresh-status').disabled = false;
  }
}
el('refresh-status').addEventListener('click', loadStatus);
let searchTimer;
el('search').addEventListener('input', () => {
  state.controller?.abort();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.page = 1;
    loadRecords();
  }, 200);
});
el('refresh').addEventListener('click', () => {
  loadCollections();
  loadStatus();
  loadRecords(true);
});
el('previous').addEventListener('click', () => {
  if (state.page > 1) {
    state.page--;
    loadRecords();
  }
});
el('next').addEventListener('click', () => {
  if (state.page < state.pages) {
    state.page++;
    loadRecords();
  }
});
loadCollections();
loadStatus();
setInterval(() => {
  if (!document.hidden) loadStatus();
}, 15000);
`;
