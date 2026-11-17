// @wc-ignore-file
/**
 * The `store` a drive app's `view({ root, store })` receives, as far as this
 * app uses it. Provided by the host at runtime (atomic-server
 * `server/src/plugins/assets/view-client.js`), never bundled here; kept by
 * hand in step with the other apps' copies (per-plugin containment). If they
 * disagree, view-client.js is ground truth. The learning app never touches
 * the integration proxy: it has no network and no credential.
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

export type GetManyEntry = PluginResource | { subject: string; error: string };

/** The most subjects one `getMany` call takes. */
export const GET_MANY_MAX = 100;

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
  getMany?(subjects: string[]): Promise<GetManyEntry[]>;
  getTheme?(): { colorScheme?: 'light' | 'dark' };
  onThemeChange?(
    handler: (theme: { colorScheme?: 'light' | 'dark' }) => void,
  ): () => void;
  /** Opens an http(s) URL after the host shows the person where it goes. */
  openExternal?(url: string): Promise<{ status: 'opened' | 'cancelled' }>;
  /** Shows a resource in the host page, leaving this app. */
  openResource?(
    subject: string,
  ): Promise<{ status: 'opened'; subject: string }>;
  /** Whether this app may edit the rows of the table it is a view of. */
  rowAccess?(): Promise<{ status: 'granted' | 'none' | 'unavailable' }>;
  /** Asks the person, in the host's bar, to allow editing those rows. */
  requestRowAccess?(): Promise<{ status: 'granted' | 'denied' }>;
}

export interface ViewArgs {
  root: HTMLElement;
  store: PluginStore;
}
