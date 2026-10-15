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
  WritePreconditionState,
  WriteConflict,
  WriteResolution,
  WriteFailure,
  WriteFailureClass,
  AuthBlock,
  MissingRecord,
  MissingRecordEvidence,
  PresenceChange,
  PresenceMark,
  PresenceMarkValue,
  MissingRecordFailure,
  PaginateOptions as ClientPaginateOptions,
  PollingHandle,
  PollOptions,
  SyncResult,
  CollectionCoverage,
  IncompleteRead,
  MatchedCreate,
} from './client/client.js';
export { InMemoryStorageAdapter } from './client/storage.js';
export type { StorageAdapter } from './client/storage.js';
export { mergePatch } from './client/merge-patch.js';
export { fingerprint } from './client/fingerprint.js';
export { replaceOf, replaceBlock } from './client/replace.js';
export type { BlockObject, ReplaceDeclaration } from './client/replace.js';
export {
  unkeyedListsOf,
  flattenList,
  nestList,
  pairItems,
  mergeUnkeyedList,
} from './client/unkeyed-lists.js';
export type {
  UnkeyedList,
  FlatListItem,
  LocalListItem,
  MergedListItem,
  UnkeyedListMerge,
} from './client/unkeyed-lists.js';
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
export {
  absoluteIri,
  checkProduces,
  lensFits,
  parseProduces,
  producedClasses,
  resourcesProducing,
  sameSubject,
} from './read/produced-classes.js';
export type {
  ProducedClass,
  ResourceProduction,
} from './read/produced-classes.js';

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
  invalidAutoDetected,
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
export {
  classifyThrottling,
  declaredThrottling,
  fallbackWindow,
  headerTime,
  limitsInForce,
  operationBuckets,
  parseTiers,
} from './throttling/throttling.js';
export type {
  BodyPredicate,
  HeaderPredicate,
  HeaderRole,
  HeaderRoleObject,
  SignalObject,
  ThrottlingDeclaration,
  Tier,
  ThrottlingMeaning,
  ThrottlingResponse,
  ThrottlingVerdict,
  TimeUnit,
} from './throttling/throttling.js';
export { Pacer } from './throttling/pacing.js';
export type { Quota } from './throttling/pacing.js';
export { halves, WindowReadError } from './pagination/window.js';
export type {
  RangeWindowObject,
  WindowBounds,
  WindowFormat,
  WindowUnit,
} from './pagination/types.js';
export { PageReadError, responseIncomplete } from './read/pages.js';
export type { WalkOutcome, WindowRange } from './read/pages.js';
export type {
  IncompleteObject,
  JsonScalar,
  ShortPageObject,
} from './pagination/types.js';
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

// The webhook inbox consumer (ontola/atomic-plugins#369), without signing
// (`signedTransport` needs `node:crypto`; a host that signs for the caller,
// such as atomic-server's sandbox, does not need it). Nothing here needs
// `URL`, `Buffer` or `TextDecoder`.
export {
  DEFAULT_BACKOFF_SECONDS,
  InboxClient,
  InboxError,
  parseRetryAfter,
} from './inbox/client.js';
export type {
  GapMarker,
  InboxEvent,
  InboxEventPage,
  InboxSubscription,
  ReconciliationRequired,
  SubscribeRequest,
} from './inbox/client.js';
export {
  DEFAULT_WAIT_SECONDS,
  InboxConsumer,
  InMemoryInboxJournal,
} from './inbox/consumer.js';
export type {
  InboxConsumerOptions,
  InboxJournal,
  StepResult,
  StoredSubscription,
} from './inbox/consumer.js';
export { decodeBase64Utf8, pathSegment, scopedReads } from './inbox/reads.js';
export type { ScopedRead } from './inbox/reads.js';
