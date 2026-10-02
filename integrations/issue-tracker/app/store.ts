// @wc-ignore-file
/**
 * The `store` a drive plugin's `view({ root, store })` receives from the host
 * (atomic-server `server/src/plugins/assets/view-client.js`). It is never
 * bundled here. The types are kept by hand in step with that file and with
 * notion's/pets' copies (this is notion's, unchanged); there is no package to
 * import them from yet, and sharing one copy is a maintainer decision
 * (per-plugin containment). If they disagree, view-client.js is ground truth.
 *
 * `proxy` (ontola/atomic-plugins#54 phase 2): the frame names a platform and
 * a connection id, never a credential. view-client.js makes an Ed25519 key in
 * the frame's memory, gets a short-lived capability for it from the page
 * (signed with the user's key, after the page checked the connection is
 * delegated to this app), and calls the integration proxy directly, signing
 * each request with that key. It is feature-detected, never assumed. Without it
 * the app says so and fetches nothing.
 */

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | { [key: string]: JSONValue }
  | JSONValue[];

export interface DataRef {
  table: string;
  rowClass?: string;
}

export interface PluginResource {
  readonly subject: string;
  readonly props: Record<string, JSONValue>;
  get(property: string): JSONValue;
  set(property: string, value: JSONValue): PluginResource;
  remove(property: string): PluginResource;
  save(): Promise<PluginResource>;
  destroy(): Promise<void>;
}

/** One proxy call, made by the host's frame client. Carries a connection reference, never a credential. */
export interface HostProxyRequest {
  platform: string;
  connectionId: string;
  /** The provider path after the proxy's `/proxy/<connection>/<platform>`, e.g. `/v1/search`. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  /** JSON text. */
  body?: string;
}

export interface HostProxyResponse {
  status: number;
  /** Lower-cased, and only an allowlist (`link`, `retry-after`, `etag`, `content-type`). */
  headers?: Record<string, string>;
  /** Parsed JSON when the response parses, the raw text otherwise. */
  body: unknown;
}

/** What `proxy.connect` resolves to, when it resolves. */
export type ConnectResult =
  | { status: 'cancelled' }
  | { status: 'connected'; connectionId: string; platform: string };

export interface HostProxy {
  request(request: HostProxyRequest): Promise<HostProxyResponse>;
  /** Connections for `platform` the person delegated to this app, at the proxy. */
  connections(args: {
    platform: string;
  }): Promise<{ connectionId: string; platform: string }[]>;
  /**
   * Shows the host's consent bar. Resolves `connected` when the person picks
   * a connection they already have (the host delegates it to this app; no
   * reload), `cancelled` when they cancel. Connecting a new account sends the
   * page to the proxy and back, which reloads this view, so then it never
   * settles.
   */
  connect(args: { platform: string }): Promise<ConnectResult>;
  /**
   * Takes this app's delegation off the platform's connections; the
   * connections themselves stay (atomic-server pin 007869464). Optional:
   * older hosts lack it.
   */
  disconnect?(args: { platform: string }): Promise<{
    status: 'disconnected';
    platform: string;
    connectionIds: string[];
  }>;
}

/** Whether the host is drawn light or dark (`store.getTheme()`). */
export type ColorScheme = 'light' | 'dark';

/**
 * What `store.rowAccess()` answers (atomic-server#1740, #1849): whether this
 * app may edit the rows of the table it is a view of, and which of its
 * declared `row-extras` that grant covers.
 */
export type RowAccess =
  | {
      status: 'granted';
      grantedBy: string;
      grantedAt: number;
      via: string;
      extras: string[];
    }
  | { status: 'none' }
  /** Not shown as a table's view. */
  | { status: 'unavailable' };

/** What `store.requestRowAccess()` answers once the person chose. */
export type RowAccessAnswer =
  | { status: 'granted' }
  | { status: 'denied'; reason: string };

export interface PluginStore {
  getApp(): Promise<string>;
  getData(): Promise<DataRef | undefined>;
  getResource(subject: string): Promise<PluginResource>;
  query(args: { property: string; value: string }): Promise<string[]>;
  newResource(args?: {
    parent?: string;
    isA?: string[];
    propVals?: Record<string, JSONValue>;
  }): Promise<PluginResource>;
  /** `handler` takes no argument; re-fetch via getResource for the new data. */
  subscribe(subject: string, handler: () => void): () => void;
  proxy?: HostProxy;
  /*
   * Since atomic-server pin 007869464, feature-detected (older hosts lack
   * them; the app then falls back as noted where it calls them).
   */
  /** Up to 100 subjects in one round trip, in the order asked. */
  getMany?(
    subjects: string[],
  ): Promise<(PluginResource | { subject: string; error: string })[]>;
  /** Opens an http(s) URL after the host shows the person where it goes. */
  openExternal?(url: string): Promise<{ status: 'opened' | 'cancelled' }>;
  /** Shows a resource in the host page, leaving this app. */
  openResource?(
    subject: string,
  ): Promise<{ status: 'opened'; subject: string }>;
  /** The host's light/dark setting. */
  getTheme?(): { colorScheme?: ColorScheme };
  /** Calls back when the person switches light/dark; returns a stop function. */
  onThemeChange?(
    handler: (theme: { colorScheme?: ColorScheme }) => void,
  ): () => void;
  /*
   * Since atomic-server pin a12b74a (#1740, #1849), feature-detected: "Sync
   * this table to GitHub" on a table the app didn't make needs both.
   */
  /** Whether this app may edit the rows of the table it is a view of. */
  rowAccess?(): Promise<RowAccess>;
  /**
   * Asks the person, in the host's own bar ("Allow editing" / "Not now"),
   * to let this app edit the table's rows and keep its `row-extras` on them.
   * Answered straight away when a live grant already covers every extra the
   * App declares now.
   */
  requestRowAccess?(): Promise<RowAccessAnswer>;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
