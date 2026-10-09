/**
 * `syncables/browser`: the reader and local replica, safe to bundle for a browser (or an
 * iframe plugin). Nothing reachable from this module imports a Node
 * built-in or `js-yaml` — `__tests__/unit/browser/bundle.test.ts` bundles it
 * with esbuild `platform: 'browser'` and fails on any such import — and
 * the reader uses an injected Transport; the client also accepts one,
 * or adapts supplied/global fetch for direct HTTP.
 *
 * Not included: the mock server, environment credential loading, and the file-path
 * loaders (`loadOpenApiDocument`, `loadOverlay`). Pass documents and
 * overlays as parsed objects.
 */

export {
  prepareDocument,
  describePlatform,
  readPlatform,
  paginate,
} from './read/read.js';
export type {
  PaginateOptions,
  ReadOptions,
  ReadRecord,
  ReadResult,
} from './read/read.js';
export { mergeQuerySelections } from './read/model.js';
export type { PlatformDescription, QuerySelection } from './read/model.js';
export {
  DATATYPES,
  deriveOntology,
  ontologyShortname,
} from './read/ontology.js';
export type { Datatype, Ontology, Term } from './read/ontology.js';
export { coveredSpan, instantsOf, wallClockParam } from './read/time-zone.js';
export type { CoveredSpan, FieldSpan, ReadCoverage } from './read/time-zone.js';
export { DEFAULT_READ_LIMITS } from './read/pages.js';
export type { ReadLimits } from './read/pages.js';
export { fetchTransport } from './read/transport.js';
export type {
  FetchLike,
  ListMethod,
  Transport,
  TransportRequest,
  TransportResponse,
  HttpMethod,
} from './read/transport.js';
export { createApiClient, defaultWriteFailureClass } from './client/client.js';
export type {
  ApiClient,
  ApiClientOptions,
  PendingWriteInfo,
  PendingWriteState,
  PendingWriteType,
  WriteConflict,
  WriteResolution,
  WriteFailure,
  WriteFailureClass,
  AuthBlock,
  MissingRecord,
  MissingRecordEvidence,
  PaginateOptions as ClientPaginateOptions,
  PollingHandle,
  PollOptions,
  SyncResult,
  CollectionCoverage,
} from './client/client.js';
export { InMemoryStorageAdapter } from './client/storage.js';
export type { StorageAdapter } from './client/storage.js';
export {
  apiKeyAuth,
  bearerAuth,
  authenticatedTransport,
} from './client/auth.js';
export type { Authenticate, Credentials } from './client/auth.js';
export { readCollections } from './read/collections.js';
export type {
  CollectionReadOptions,
  CollectionReadResult,
  CollectionSnapshot,
} from './read/collections.js';
export type { RawReadResponse, StoreReadResponse } from './read/responses.js';

export { applyOverlay } from './openapi/apply-overlay.js';
export type {
  OverlayAction,
  OverlayDocument,
} from './openapi/apply-overlay.js';
export { resolveRefs } from './openapi/resolve-refs.js';
export type {
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  SchemaObject,
} from './openapi/types.js';

export {
  PaginationSchemeError,
  resolveEffectiveScheme,
} from './pagination/autodetect.js';
export type { EffectiveScheme } from './pagination/autodetect.js';
export { validatePaginationScheme } from './pagination/validate.js';
export { buildBody, buildQuery } from './pagination/request-builder.js';
export type { PageCursor } from './pagination/request-builder.js';
export { parseLinkHeader } from './pagination/response-parser.js';
export { LinkRefused, resolveLink } from './pagination/links.js';
export type { ResolveLinkOptions } from './pagination/links.js';
export type { LinkResolutionObject } from './pagination/types.js';
export { halves, WindowReadError } from './pagination/window.js';
export type {
  RangeWindowObject,
  WindowBounds,
  WindowFormat,
  WindowUnit,
} from './pagination/types.js';
export type { WalkOutcome, WindowRange } from './read/pages.js';
export type {
  AutoDetectObject,
  PaginationApplicationObject,
  PaginationResponseState,
  PaginationSchemeObject,
  PaginationSchemesMap,
  RequestRole,
  ResponseRole,
  SchemeType,
} from './pagination/types.js';
