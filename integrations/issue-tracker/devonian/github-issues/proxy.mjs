import { endpoint, request } from './adapter.js';
import { trackerAction } from './tracker-actions.js';

/**
 * Write answers that mean GitHub applied nothing: the request itself was
 * wrong (400), its target is gone (404, 410), it clashes with the current
 * state (409) or fails validation (422, for example a title over 256
 * characters or a label the repository refuses). GitHub documents each as a
 * refusal of the whole request, with no partial effect. Left out on
 * purpose: 401 and 403, which mean the connection or its permissions are
 * the problem (a 403 may also be a rate limit, handled before the receipt
 * reaches this module), 429, and every 5xx, where the write may have been
 * applied before the answer was lost.
 */
export const NOT_APPLIED = new Set([400, 404, 409, 410, 422]);

/** How much of GitHub's explanation is kept, in characters. */
const DETAIL_MAX = 300;

/**
 * GitHub's own words for a refusal: the body's `message`, then each entry
 * of its `errors` (`message`, or `field` and `code`), joined; empty when
 * the body has neither.
 */
export function refusalDetail(body) {
  let parsed = body;

  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return body.trim().slice(0, DETAIL_MAX);
    }
  }

  const parts = [];
  if (typeof parsed?.message === 'string') parts.push(parsed.message.trim());

  for (const error of Array.isArray(parsed?.errors) ? parsed.errors : []) {
    if (typeof error === 'string') parts.push(error.trim());
    else if (typeof error?.message === 'string')
      parts.push(error.message.trim());
    else if (
      typeof error?.field === 'string' &&
      typeof error?.code === 'string'
    )
      parts.push(`${error.field} ${error.code}`);
  }

  return parts.filter(Boolean).join('; ').slice(0, DETAIL_MAX);
}

/**
 * The error a refused write rejects with. `notSent` is the Bridge's
 * contract for "nothing was applied, drop the saved operation"; `refused`,
 * `status` and `detail` let the app tell a refusal from a rate limit or a
 * host refusal and show GitHub's reason.
 */
export function refusedWrite(action, receipt) {
  const detail = refusalDetail(receipt.body);

  return Object.assign(
    new Error(
      `GitHub refused ${action} (HTTP ${receipt.status}${detail ? `: ${detail}` : ''}). Nothing was applied.`,
    ),
    { notSent: true, refused: true, status: receipt.status, detail },
  );
}

/**
 * GitHub issue actions over the integration proxy, through `dispatch`.
 *
 * `dispatch(path, { method, body })` makes one proxy call for a GitHub API
 * path (`/repos/{owner}/{name}/issues…`, query included) and resolves to
 * `{ status, body }`. In the drive app it is the host's
 * `store.proxy.request` (see `app/transport.ts`): since
 * ontola/atomic-plugins#54 phase 2 the plugin frame calls the proxy itself
 * with a capability from the page and a key only it holds, so this module
 * never sees a credential. The direct transport this used to have, which
 * spent a rotating connection code per request (`getCode`/`setCode`), went
 * with the proxy's connection codes.
 *
 * Writes are journalled before they leave (`journal[id]`, persisted by
 * `save`), so a write whose outcome is unknown is never resent. Calls are
 * serialised, one at a time.
 *
 * A write GitHub answered with a status in `NOT_APPLIED` was refused whole
 * (ontola/atomic-plugins#357): its journal entry is dropped and the call
 * rejects with a `notSent` error carrying `status` and GitHub's `detail`,
 * so the Bridge drops the saved operation and the next pass plans the
 * change again instead of reporting "Uncertain GitHub write". Any other
 * non-2xx answer (401, 403 that is not a rate limit, 5xx) is returned as a
 * receipt without one, and the entry stays: those say nothing certain about
 * what GitHub applied, or mean the connection itself is the problem.
 */
export function proxyTransport({ repository, journal, save, dispatch }) {
  if (typeof dispatch !== 'function')
    throw new Error('proxyTransport needs a dispatch function');
  const root = endpoint(repository);
  let pending = Promise.resolve();

  return (action, args, id) => {
    const operation = async () => {
      if (
        action === 'get_issue' &&
        (!Number.isSafeInteger(args.number) || args.number <= 0)
      )
        throw new Error('Invalid issue number');
      if (
        action === 'create_issue' &&
        (typeof args.title !== 'string' ||
          !args.title.trim() ||
          args.title.length > 256 ||
          (args.body !== undefined && typeof args.body !== 'string'))
      )
        throw new Error('Invalid issue title or body');
      const intent =
        trackerAction(repository, action, args) ??
        (action === 'get_issue'
          ? request('get', 'GET', `${root}/${args.number}`, id)
          : action === 'create_issue'
            ? request('create', 'POST', root, id, args)
            : undefined);
      if (!intent) throw new Error('Unsupported GitHub action');
      const writes = intent.method !== 'GET';
      const signature = JSON.stringify({ action, args });
      const old = journal[id];

      if (writes && old) {
        if (old.signature !== signature)
          throw new Error('Operation identity reused with different arguments');
        if (old.receipt) return old.receipt;
        throw new Error(
          `Uncertain GitHub write (${action}). Inspect its outcome before retrying; it will not be resent.`,
        );
      }

      if (writes) {
        journal[id] = { signature };
        await save();
      }

      const target = new URL(intent.url);
      const receipt = await dispatch(`${target.pathname}${target.search}`, {
        method: intent.method,
        ...(intent.body ? { body: intent.body } : {}),
      }).catch(async error => {
        // A dispatcher that knows the request never left (e.g. the host
        // refused to mint a capability, or the browser cannot make the
        // frame key) says so with `notSent`; only then is the journal entry
        // dropped, so the write is not stuck as uncertain. Anything else
        // stays uncertain.
        if (error?.notSent) {
          if (writes) {
            delete journal[id];
            await save();
          }

          throw error;
        }

        throw new Error(
          `Proxy request failed (${error?.message ?? error}). Check CORS and reconnect; an uncertain write will not be resent.`,
        );
      });

      if (writes && receipt.status >= 200 && receipt.status < 300) {
        journal[id].receipt = receipt;
        await save();
      } else if (writes && NOT_APPLIED.has(receipt.status)) {
        delete journal[id];
        await save();
        throw refusedWrite(action, receipt);
      }

      return receipt;
    };

    const next = pending.then(operation);
    pending = next.catch(() => {});

    return next;
  };
}

/** An explicitly labelled GitHub fixture; no network or real GitHub mutations. */
export function fixtureTransport(state, save) {
  state.issues ??= [
    {
      number: 1,
      title: 'Welcome from GitHub',
      body: 'Edit either tracker, then sync again.',
      state: 'open',
      labels: ['demo'],
    },
  ];
  state.comments ??= [];
  state.receipts ??= {};

  return async (action, args, id) => {
    if (state.receipts[id]) return state.receipts[id];
    let value;
    const issue = state.issues.find(r => r.number === args.number);
    const comment = state.comments.find(r => r.id === args.id);

    switch (action) {
      case 'list_issues':
        value = state.issues.slice((args.page - 1) * 100, args.page * 100);
        break;
      case 'get_issue':
        value = issue;
        break;
      case 'create_issue':
        value = {
          number: Math.max(0, ...state.issues.map(r => r.number)) + 1,
          ...args,
          state: 'open',
          labels: [],
        };
        state.issues.push(value);
        break;
      case 'update_issue':
        value = Object.assign(issue, args);
        break;
      case 'add_doing_label':
        issue.labels = [...new Set([...issue.labels, 'atomic:doing'])];
        value = issue;
        break;
      case 'remove_doing_label':
        issue.labels = issue.labels.filter(l => l !== 'atomic:doing');
        value = issue;
        break;
      case 'add_blocked_label':
        issue.labels = [...new Set([...issue.labels, 'atomic:blocked'])];
        value = issue;
        break;
      case 'remove_blocked_label':
        issue.labels = issue.labels.filter(l => l !== 'atomic:blocked');
        value = issue;
        break;
      case 'list_comments':
        value = state.comments
          .filter(c => c.issue_url.endsWith(`/${args.number}`))
          .slice((args.page - 1) * 100, args.page * 100);
        break;
      case 'get_comment':
        value = comment;
        break;
      case 'create_comment':
        value = {
          id: Math.max(0, ...state.comments.map(r => r.id)) + 1,
          body: args.body,
          issue_url: `https://api.github.com/repos/demo/issues/issues/${args.number}`,
          user: { login: 'demo-user' },
        };
        state.comments.push(value);
        break;
      case 'update_comment':
        value = Object.assign(comment, { body: args.body });
        break;
      default:
        throw new Error(`Unsupported fixture action: ${action}`);
    }

    const receipt = {
      status: value ? 200 : 404,
      body: JSON.stringify(value ?? {}),
    };
    if (!action.startsWith('get_') && !action.startsWith('list_'))
      state.receipts[id] = receipt;
    await save();

    return receipt;
  };
}
