// @wc-ignore-file
/**
 * The `store` a drive plugin's `view({ root, store })` receives, provided by
 * the host at runtime (atomic-server `server/src/plugins/assets/view-client.js`,
 * served from `/plugin-ui?format=client`) and never bundled here. Kept in
 * sync with that file by hand; if they disagree, view-client.js is ground
 * truth.
 *
 * A copy of `integrations/pets/app/store.ts`, with the operations of pin
 * 007869464 (`openExternal`, `openResource`, `getTheme`, `onThemeChange`,
 * `proxy.disconnect`; typed in atomic-server's `@tomic/plugin`) as optional
 * members. Calendar is the first app to
 * use `ifMatch`: view-client.js sends it to the proxy as `If-Match`. Kept
 * per plugin on purpose (strict per-plugin containment).
 *
 * `proxy` (ontola/atomic-plugins#54 phase 2): the frame names a platform and
 * a connection id, never a credential. view-client.js makes an Ed25519 key in
 * the frame's memory, gets a short-lived capability for it from the page
 * (signed with the user's key, after the page checked the connection is
 * delegated to this app), and calls the integration proxy directly, signing
 * each request with that key. It is feature-detected, never assumed.
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
  /** Provider path after the proxy's `/proxy/<connection>/<platform>` prefix; may carry `?query`. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  /** JSON text. */
  body?: string;
  /** Sent as `If-Match`; the only request header a frame can set. */
  ifMatch?: string;
}

export interface HostProxyResponse {
  status: number;
  /** Lower-cased; only `link`, `retry-after`, `etag`, `content-type`. */
  headers?: Record<string, string>;
  /** Parsed JSON when the response was JSON, the raw text otherwise. */
  body: unknown;
}

export interface ConnectionReference {
  connectionId: string;
  platform: string;
}

/** What `proxy.connect` resolves to, when it resolves. */
export type ConnectResult =
  | { status: 'cancelled' }
  | { status: 'connected'; connectionId: string; platform: string };

export interface HostProxy {
  request(request: HostProxyRequest): Promise<HostProxyResponse>;
  connections(args: { platform: string }): Promise<ConnectionReference[]>;
  /**
   * Shows the host's consent bar. Resolves `connected` when the person picks
   * a connection they already have (the host delegates it to this app; no
   * reload), `cancelled` when they cancel. Connecting a new account sends the
   * page to the proxy and back, which reloads this view, so then it never
   * settles.
   */
  connect(args: { platform: string }): Promise<ConnectResult>;
  /**
   * Takes this app's delegation off its `platform` connections at the proxy;
   * the connection itself stays for other apps. Feature-detected (pin
   * 007869464 and later).
   */
  disconnect?(args: { platform: string }): Promise<{
    status: 'disconnected';
    platform: string;
    connectionIds: string[];
  }>;
}

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
  subscribe(subject: string, handler: () => void): () => void;
  /** Feature-detected: hosts without integration-proxy support lack it. */
  proxy?: HostProxy;
  /**
   * Whether this app may edit the rows of the table it is a view of.
   * Feature-detected (pin a12b74a has it), like `requestRowAccess`.
   */
  rowAccess?(): Promise<RowAccess>;
  /**
   * Asks the person, in the host's own bar ("Allow editing" / "Not now"),
   * to let this app edit the table's rows and keep its `row-extras` on them.
   * Answered straight away when a live grant already covers every extra the
   * App declares now.
   */
  requestRowAccess?(): Promise<RowAccessAnswer>;
  /**
   * Opens an http(s) link in a new tab after the person confirms it in the
   * host (the frame has no popup rights). Feature-detected, like the rest
   * below: hosts before pin 007869464 lack them.
   */
  openExternal?(url: string): Promise<{ status: 'opened' | 'cancelled' }>;
  /** Shows a resource the person can read in the host page, leaving the app. */
  openResource?(
    subject: string,
  ): Promise<{ status: 'opened'; subject: string }>;
  /** The host's light or dark setting. */
  getTheme?(): { colorScheme: ColorScheme };
  /** Called when the person switches the host's theme; returns an unsubscribe. */
  onThemeChange?(
    handler: (theme: { colorScheme: ColorScheme }) => void,
  ): () => void;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
