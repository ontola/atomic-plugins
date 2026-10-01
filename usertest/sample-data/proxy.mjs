/**
 * Sample data for drive apps in moderated user testing (#196): the app runs
 * unchanged, but its `store.proxy` is answered in the frame by one of the
 * mock proxy's stateful provider fixtures (`integrations/<app>/fixtures/`)
 * instead of the integration proxy. So a tester needs no Google, GitHub,
 * Clockify or Notion account, and nothing reaches a provider. The rest of
 * the store (the drive, the table, row access) is the host's, unchanged.
 *
 * `usertest/catalog.mjs` bundles this around an app's built module as a
 * separate catalog entry, "<App> (sample data)"; see README.md.
 *
 * The sample account starts connected: the app finds the connection on its
 * first mount and goes straight to its picker or first sync, the path it
 * takes in the real host after connecting a new account (the page comes back
 * from the proxy and the frame mounts fresh). `connect` resolves at once,
 * like picking an existing connection in the host's consent bar, and
 * `disconnect` works as it does at the proxy.
 *
 * The fixture lives in the frame's memory, and the host remounts the frame
 * whenever the tester leaves the app and comes back. To keep the sample
 * account's state across that, the provider's seed, whether it is
 * connected, and every write the app sent are kept as JSON in the
 * description of one resource under the App (the one place a view may
 * always write), and replayed into a fresh fixture on load. Fixtures are
 * deterministic for the same seed and clock, and each write is replayed
 * with `Date` fixed at the time it was first made, so the replay ends in
 * the same state, ETags and timestamps included.
 */

const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const PARENT = 'https://atomicdata.dev/properties/parent';
const CONNECTION = 'sample';
const FORMAT = 1;

/** Runs `fn` with `Date` and `Date.now()` fixed at `ms`. Fixtures are
 * synchronous, so nothing else runs while the global is swapped. */
export function atTime(ms, fn) {
  const Real = globalThis.Date;
  class Fixed extends Real {
    constructor(...args) {
      if (args.length) super(...args);
      else super(ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = Fixed;
  try {
    return fn();
  } finally {
    globalThis.Date = Real;
  }
}

const lower = headers =>
  Object.fromEntries(
    Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );

/**
 * A provider fixture, as the mock proxy sees it: `request(method, url,
 * body, headers)` with `url` at `/proxy/<platform>/<path>`.
 */
function call(fixture, platform, write, at) {
  const url = new URL(
    `/proxy/${platform}${write.path}`,
    'https://sample-data.invalid',
  );
  for (const [k, v] of Object.entries(write.query ?? {}))
    url.searchParams.set(k, v);
  const body =
    write.body === undefined || write.body === ''
      ? undefined
      : JSON.parse(write.body);

  return atTime(at, () =>
    fixture.request(write.method ?? 'GET', url, body, lower(write.headers)),
  );
}

/**
 * The sample account: the fixture, plus its persisted state.
 * `provider` is `{ platform, name, seed(), create(seed), isWrite? }`.
 */
export function sampleAccount(store, provider) {
  const marker = `Sample ${provider.name} account (user testing)`;
  const isWrite = provider.isWrite ?? (method => method !== 'GET');
  let state;
  let fixture;
  let resource;
  let saving = Promise.resolve();

  const warn = (message, error) => {
    console.warn(`[sample data] ${message}`, error);
    globalThis.__USERTEST_REPORT__?.({
      level: 'warning',
      source: 'sample-data',
      app: provider.name,
      message: `${message}: ${error?.message ?? error}`,
    });
  };

  const load = async () => {
    try {
      const app = await store.getApp();
      for (const subject of await store.query({
        property: NAME,
        value: marker,
      })) {
        const found = await store.getResource(subject);
        if (found.get(PARENT) !== app) continue;
        const saved = JSON.parse(String(found.get(DESCRIPTION)));
        if (saved?.format !== FORMAT) continue;
        resource = found;
        return saved;
      }
    } catch (error) {
      warn('could not read the saved sample account; starting fresh', error);
    }

    return {
      format: FORMAT,
      seed: provider.seed(),
      createdAt: Date.now(),
      connected: true,
      writes: [],
    };
  };

  /** Saves the state, one save at a time; a failure only costs persistence. */
  const persist = () => {
    const text = JSON.stringify(state);
    saving = saving.then(async () => {
      try {
        if (!resource)
          resource = await store.newResource({
            propVals: { [NAME]: marker, [DESCRIPTION]: text },
          });
        else await resource.set(DESCRIPTION, text).save();
      } catch (error) {
        warn('could not save the sample account', error);
      }
    });

    return saving;
  };

  const ready = (async () => {
    state = await load();
    // A new account's seed is saved at once: Clockify's entries are relative
    // to it, so a second mount must not make a new one.
    if (!resource) await persist();
    fixture = atTime(state.createdAt, () => provider.create(state.seed));
    for (const write of state.writes)
      try {
        call(fixture, provider.platform, write, write.at);
      } catch (error) {
        warn('could not replay a saved write', error);
      }
  })();

  const proxy = {
    async request(req) {
      await ready;
      if (req.platform !== provider.platform || req.connectionId !== CONNECTION)
        return { status: 404, headers: {}, body: { error: 'No connection' } };
      const write = {
        method: req.method ?? 'GET',
        path: req.path,
        ...(req.query ? { query: req.query } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        headers: {
          ...lower(req.headers),
          ...(req.ifMatch ? { 'if-match': req.ifMatch } : {}),
        },
      };
      const at = Date.now();
      let response;
      try {
        response = await call(fixture, provider.platform, write, at);
      } catch (error) {
        warn(
          `the sample ${provider.name} failed on ${write.method} ${write.path}`,
          error,
        );
        return {
          status: 500,
          headers: {},
          body: { error: 'Sample data error' },
        };
      }
      if (
        isWrite(write.method, write.path) &&
        response.status >= 200 &&
        response.status < 300
      ) {
        state.writes.push({ ...write, at });
        await persist();
      }

      return {
        status: response.status,
        headers: lower(response.headers),
        body: structuredClone(response.body),
      };
    },
    async connections({ platform }) {
      await ready;

      return platform === provider.platform && state.connected
        ? [{ platform, connectionId: CONNECTION }]
        : [];
    },
    async connect({ platform }) {
      await ready;
      if (platform !== provider.platform) return { status: 'cancelled' };
      state.connected = true;
      await persist();

      return { status: 'connected', connectionId: CONNECTION, platform };
    },
    async disconnect({ platform }) {
      await ready;
      const was = state.connected && platform === provider.platform;
      if (was) {
        state.connected = false;
        await persist();
      }

      return {
        status: 'disconnected',
        platform,
        connectionIds: was ? [CONNECTION] : [],
      };
    },
  };

  return { proxy, ready, state: () => state, fixture: () => fixture };
}

/** The host's store with `proxy` answered by the sample account. */
export function withSampleProxy(store, proxy) {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'proxy') return proxy;
      const value = Reflect.get(target, key, target);

      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, key) {
      return key === 'proxy' || Reflect.has(target, key);
    },
  });
}

/** A line above the app saying the data is invented, outside the app's own
 * root so the app cannot clear it. */
function banner(root, provider) {
  const doc = root?.ownerDocument;
  if (!doc || !root.parentNode) return;
  const note = doc.createElement('p');
  note.setAttribute('role', 'note');
  note.textContent = `Sample data: this app is not connected to a real ${provider.name} account. Everything it shows from ${provider.name} is invented.`;
  note.style.cssText =
    'margin:0;padding:6px 12px;font:13px/1.4 system-ui,sans-serif;' +
    'background:var(--t-color-warning,#fff3c4);color:#222;' +
    'border-bottom:1px solid rgba(0,0,0,.15)';
  root.parentNode.insertBefore(note, root);
}

/** `view({ root, store })` for the app's own `view`, on sample data. */
export function sampleView(appView, provider) {
  return async ({ root, store, ...rest }) => {
    banner(root, provider);
    const { proxy } = sampleAccount(store, provider);

    return appView({ ...rest, root, store: withSampleProxy(store, proxy) });
  };
}
