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
  IncompleteRead,
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
} from './client/client.js';
export { InMemoryStorageAdapter } from './client/storage.js';
export type { StorageAdapter } from './client/storage.js';
export { mergePatch } from './client/merge-patch.js';

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
export type {
  RuntimeClass,
  RuntimeDescriber,
  RuntimeMembers,
  RuntimeProperty,
} from './read/runtime-schemas.js';
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
export { PageReadError } from './read/pages.js';
export type { WalkOutcome, WindowRange } from './read/pages.js';
export type { ShortPageObject } from './pagination/types.js';

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

// The daemon side of a webhook inbox (ontola/atomic-plugins#369): signed
// requests to the receiver, its consumer routes, and the journal-before-ack
// consumer. Node only: not in `syncables/browser`.
export {
  agentKeyFromSeed,
  sha256Hex,
  signedTransport,
  v2Headers,
  v2Message,
} from './inbox/sign.js';
export type { AtomicAgentKey } from './inbox/sign.js';
export { InboxClient, InboxError } from './inbox/client.js';
export type {
  GapMarker,
  InboxEvent,
  InboxEventPage,
  InboxSubscription,
  ReconciliationRequired,
  SubscribeRequest,
} from './inbox/client.js';
export { InboxConsumer, InMemoryInboxJournal } from './inbox/consumer.js';
export type {
  InboxConsumerOptions,
  InboxJournal,
  StepResult,
  StoredSubscription,
} from './inbox/consumer.js';
export { scopedReads } from './inbox/reads.js';
export type { ScopedRead } from './inbox/reads.js';
