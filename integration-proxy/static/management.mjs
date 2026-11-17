// Reusable view: the embedding client supplies an allowlisted transport, never
// an owner key or provider/device token. Text from the API is always textContent.
export function mountManagement({ root, request }) {
  const make = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const heading = make('h1', 'Connections & access');
  const intro = make('p', 'Credentials stay in IAP. Your synced data stays in your client. Disconnecting access does not delete saved local data.');
  const message = make('p'); message.setAttribute('role', 'status');
  const content = make('section');
  const refresh = make('button', 'Refresh access');
  root.replaceChildren(heading, intro, refresh, message, content);
  const act = async (action, question) => {
    if (!confirm(question)) return;
    refresh.disabled = true;
    try { await request(action); await load(); }
    catch { message.textContent = 'Could not change access. Your session may need a fresh management approval.'; }
    finally { refresh.disabled = false; }
  };
  const button = (parent, text, action, question) => {
    const b = make('button', text); b.onclick = () => act(action, question); parent.append(b);
  };
  async function load() {
    refresh.disabled = true; message.textContent = 'Checking access…';
    try {
      const state = await request({ action: 'overview' });
      content.replaceChildren(make('h2', 'Provider connections'));
      if (!state.connections.length) content.append(make('p', 'No connections were selected for this management grant.'));
      for (const connection of state.connections) {
        const row = make('article'); row.append(make('strong', connection.label || connection.platform));
        
        if (state.canManageConnections) {
          for (const grant of connection.delegations || []) {
            const app = make('div'); app.append(make('small', grant.label || grant.agent));
            button(app, 'Revoke app access', { action: 'revoke-delegation', connection: connection.connection_id, agent: grant.agent }, 'Revoke this app’s access to this provider connection?'); row.append(app);
          }
          const advanced = make('details'); advanced.append(make('summary', 'Advanced: grant app access'));
          const label = make('label', 'App agent identifier'); const input = make('input'); input.placeholder = 'atomic:agent:…'; input.autocomplete = 'off'; label.append(input); advanced.append(label);
          const grant = make('button', 'Grant app access'); grant.onclick = () => {
            const agent = input.value.trim();
            if (agent) void act({ action: 'delegate', connection: connection.connection_id, agent }, 'Allow this app agent to use this provider connection?');
          }; advanced.append(grant); row.append(advanced);
          button(row, 'Disconnect provider', { action: 'disconnect', connection: connection.connection_id }, 'Disconnect this provider connection for every app? Saved local data will remain.');
        } else row.append(make('p', 'Read-only access. Approve connection management to change app grants.'));
        content.append(row);
      }
      content.append(make('h2', 'IAP client sessions'));
      if (!state.canManageSessions) content.append(make('p', 'Approve session management to see and revoke your IAP client sessions.'));
      for (const session of state.sessions) {
        const row = make('article'); row.append(make('strong', session.client_id + (session.session_id === state.sessionId ? ' · this session' : '')));
        const permissions = { 'connections:read':'See approved connections', 'connections:manage':'Manage selected connections', 'sessions:manage':'Manage client sessions', 'proxy:read':'Read provider data', 'proxy:write':'Change provider data', 'notifications:consume':'Receive change notifications' };
        row.append(make('small', session.scope.split(' ').map(scope => permissions[scope] || scope).join(' · ')));
        row.append(make('small', session.revoked ? 'Revoked' : 'Active'));
        if (!session.revoked) button(row, 'Revoke session', { action: 'revoke-session', session: session.session_id }, 'Revoke this client session? If it is this panel’s session, the panel will need a new login.');
        content.append(row);
      }
      message.textContent = 'Access checked. New provider connections require fresh approval in your owner hub.';
    } catch { message.textContent = 'Management access unavailable. Start SyncD with --manage and approve the requested permissions, then refresh.'; }
    finally { refresh.disabled = false; }
  }
  refresh.onclick = load;
  void load();
  return { refresh: load };
}

// Exact-origin, exact-window request/reply bridge. A parent cannot change the
// iframe's authority by choosing a URL: its own backend authorizes each action.
const root = document.getElementById('management');
if (root && window.parent !== window) {
  const parentOrigin = new URL(location.href).searchParams.get('parent_origin');
  let origin;
  try {
    const url = new URL(parentOrigin);
    if (url.origin !== parentOrigin || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error();
    origin = url.origin;
  } catch { root.textContent = 'Open access management through your client.'; }
  if (origin) {
    const resized = () => window.parent.postMessage({ channel: 'iap-management-v1', event: 'resize', height: document.documentElement.scrollHeight }, origin);
    new ResizeObserver(resized).observe(root);
    let sequence = 0;
    const pending = new Map();
    window.addEventListener('message', event => {
      if (event.origin !== origin || event.source !== window.parent || event.data?.channel !== 'iap-management-v1') return;
      const item = pending.get(event.data.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(event.data.id);
      if (event.data.ok) item.resolve(event.data.result); else item.reject(new Error('Request refused'));
    });
    mountManagement({ root, request: action => new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Client unavailable')); }, 20000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ channel: 'iap-management-v1', id, request: action }, origin);
    }) });
  }
}
