// Mount this in the trusted owner hub. The hub supplies its existing Atomic
// v2 signer; this module never asks for or receives the owner's private key.
export function mountDeviceApproval({ root, proxyUrl, signRequest, userCode = '', fetchImpl = fetch }) {
  const proxy = new URL(proxyUrl);
  if (proxy.search || proxy.hash || proxy.username || proxy.password ||
      !(proxy.protocol === 'https:' || proxy.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(proxy.hostname))) {
    throw new Error('Configure an HTTPS proxy URL (loopback HTTP for development).');
  }
  const base = proxy.href.replace(/\/$/, '');
  const make = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  root.replaceChildren();
  root.append(make('h1', 'Approve a CLI connection'));
  root.append(make('p', 'Compare this code with the CLI you started. Approve only a login you initiated.'));
  const label = make('label', 'User code: ');
  const input = make('input');
  input.value = userCode; input.maxLength = 11; input.autocomplete = 'off';
  label.append(input);
  const review = make('button', 'Review request');
  const message = make('p'); message.setAttribute('role', 'status');
  const details = make('section');
  root.append(label, review, message, details);
  const call = async (path, value) => {
    const body = JSON.stringify(value);
    const headers = await signRequest({ method: 'POST', url: `${base}${path}`, body });
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('The request expired or could not be authorized. Start again from the CLI.');
    return response.json();
  };
  review.onclick = async () => {
    review.disabled = true; details.replaceChildren(); message.textContent = '';
    try {
      const request = await call('/device/challenge', { user_code: input.value });
      details.append(make('h2', request.client_name), make('p', `Owner: ${request.owner}`));
      const descriptions = { 'notifications:consume': 'Subscribe to, receive and acknowledge change notifications for the selected connections. Provider data must be fetched separately.', 'connections:manage': 'Manage app access to the selected connections, including disconnecting them for every app. This does not grant access to provider data.', 'sessions:manage': 'List and revoke ALL of your IAP client sessions, including sessions belonging to other clients. This does not grant access to provider data.', 'connections:read': 'Discover only the selected connections.', 'proxy:read': 'Read through the selected connections using GET and HEAD.', 'proxy:write': 'Create, change and permanently delete data through the selected connections using POST, PUT, PATCH and DELETE, where the provider permits it.' };
      details.append(make('p', request.scope.split(' ').map(s => descriptions[s] || s).join(' ')));
      details.append(make('p', 'Select connections explicitly. New connections will require a new approval. Management is permitted only when explicitly listed above.'));
      const boxes = request.connections.map(connection => {
        const label = make('label'); const box = make('input'); box.type = 'checkbox';
        label.append(box, document.createTextNode(` ${connection.platform}${connection.label ? ` (${connection.label})` : ''} · ${connection.connection_id}`));
        details.append(label, make('br'));
        return { box, id: connection.connection_id };
      });
      const approve = make('button', request.scope.split(' ').some(s => s === 'connections:manage' || s === 'sessions:manage') ? 'Approve access management' : request.scope.split(' ').includes('proxy:write') ? 'Allow changes in selected connections' : 'Approve selected connections');
      const deny = make('button', 'Deny');
      details.append(approve, deny);
      const finish = async approved => {
        const connections = boxes.filter(item => item.box.checked).map(item => item.id);
        if (approved && !connections.length) { message.textContent = 'Select at least one connection.'; return; }
        approve.disabled = true; deny.disabled = true;
        try {
          await call('/device/approve', { challenge: request.challenge, approve: approved, connections: approved ? connections : [] });
          request.challenge = ''; details.replaceChildren();
          message.textContent = approved ? 'Approved. Return to your CLI.' : 'Denied. Return to your CLI.';
        } catch (error) { request.challenge = ''; details.replaceChildren(); message.textContent = error.message; }
      };
      approve.onclick = () => finish(true); deny.onclick = () => finish(false);
    } catch (error) { message.textContent = error.message; }
    finally { review.disabled = false; }
  };
}
