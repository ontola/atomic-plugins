export { loadOpenApiDocument } from './openapi/load.js';
export type { OpenApiSource } from './openapi/load.js';
export { resolveRefs } from './openapi/resolve-refs.js';
export { applyOverlay, loadOverlay } from './openapi/overlay.js';
export type { OverlayAction, OverlayDocument } from './openapi/overlay.js';
export type {
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  SchemaObject,
} from './openapi/types.js';

export { discoverResources } from './resources/discover.js';
export type { ResourceRoute } from './resources/discover.js';

export { generateFromSchema } from './fake-data/generate.js';

export { createMockServer } from './mock-server/server.js';
export type { MockServer } from './mock-server/server.js';

export { createApiClient } from './client/node.js';
export { defaultWriteFailureClass } from './client/client.js';
export type { ApiClientOptions } from './client/node.js';
export { credentialsFromEnv } from './client/credentials.js';
export type {
  ApiClient,
  PaginateOptions,
  PollingHandle,
  PollOptions,
  SyncResult,
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
  MissingRecordFailure,
} from './client/client.js';
export { InMemoryStorageAdapter } from './client/storage.js';
export type { StorageAdapter } from './client/storage.js';

// The read path (also available without Node built-ins as `syncables/browser`).
export {
  prepareDocument,
  describePlatform,
  readPlatform,
  paginate as paginateOperation,
} from './read/read.js';
export type {
  PaginateOptions as PaginateOperationOptions,
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
export { buildBody, buildQuery } from './pagination/request-builder.js';
export type { PageCursor } from './pagination/request-builder.js';
export { parseLinkHeader } from './pagination/response-parser.js';
export { LinkRefused, resolveLink } from './pagination/links.js';
export type { ResolveLinkOptions } from './pagination/links.js';
export type { LinkResolutionObject } from './pagination/types.js';
export {
  classifyThrottling,
  declaredThrottling,
  headerTime,
  operationBuckets,
} from './throttling/throttling.js';
export type {
  BodyPredicate,
  HeaderPredicate,
  HeaderRole,
  HeaderRoleObject,
  SignalObject,
  ThrottlingDeclaration,
  ThrottlingMeaning,
  ThrottlingResponse,
  ThrottlingVerdict,
  TimeUnit,
} from './throttling/throttling.js';
export { halves, WindowReadError } from './pagination/window.js';
export type {
  RangeWindowObject,
  WindowBounds,
  WindowFormat,
  WindowUnit,
} from './pagination/types.js';
export type { WalkOutcome, WindowRange } from './read/pages.js';

export {
  PaginationSchemeError,
  resolveEffectiveScheme,
} from './pagination/autodetect.js';
export type { EffectiveScheme } from './pagination/autodetect.js';
export { validatePaginationScheme } from './pagination/validate.js';
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
