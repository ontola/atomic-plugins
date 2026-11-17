// @wc-ignore-file
/** The host's view-client.js contract, feature-detected for row editing. */
export type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | Value[]
  | { [key: string]: Value };
export interface Resource {
  readonly subject: string;
  get(property: string): Value;
  set(property: string, value: Value): Resource;
  save(): Promise<Resource>;
}
export interface Store {
  getApp(): Promise<string>;
  getData(): Promise<{ table: string; rowClass?: string } | undefined>;
  getResource(subject: string): Promise<Resource>;
  query(args: { property: string; value: string }): Promise<string[]>;
  subscribe(subject: string, handler: () => void): () => void;
  rowAccess?(): Promise<{ status: string }>;
  requestRowAccess?(): Promise<{ status: string; reason?: string }>;
  openResource?(subject: string): Promise<unknown>;
  getTheme?(): { colorScheme?: 'light' | 'dark' };
  onThemeChange?(
    handler: (theme: { colorScheme?: 'light' | 'dark' }) => void,
  ): () => void;
}
