import type { OpenApiDocument } from '../openapi/types.js';
import {
  applyOverlay,
  parseOverlayTarget,
  type OverlayDocument,
} from '../openapi/apply-overlay.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { isRecord } from '../read/model.js';
import { nodeHash } from '../postgres/json-graph.js';

export interface ProjectionContract {
  sourceDocumentHash: string;
  overlay: OverlayDocument;
}
export interface AtomicTablesProjectionOptions {
  projectionContracts?: ProjectionContract[];
}
export function canonicalProjectionJson(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalProjectionJson).join(',') + ']';
  if (isRecord(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ':' + canonicalProjectionJson(value[key]),
        )
        .join(',') +
      '}'
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error('Projection contract must contain JSON values');
  return encoded;
}
const withoutAnnotations = (
  resource: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(resource).filter(
      ([key]) => key !== 'x-embeddedResources' && key !== 'references',
    ),
  );

/** Projection overlays cannot change accepted read/auth/identity contracts. */
export function projectionModels(
  sources: { documentHash: string; document: OpenApiDocument }[],
  options: AtomicTablesProjectionOptions,
): Map<string, { document: OpenApiDocument; hash?: string }> {
  const contracts = new Map<string, ProjectionContract>();
  for (const contract of options.projectionContracts ?? []) {
    if (
      !/^[a-f0-9]{64}$/.test(contract.sourceDocumentHash) ||
      !sources.some(
        (source) => source.documentHash === contract.sourceDocumentHash,
      )
    )
      throw new Error(
        'Projection contract source hash does not match a selected OpenAPI document',
      );
    if (contracts.has(contract.sourceDocumentHash))
      throw new Error('Duplicate projection contract for source document hash');
    const overlay = contract.overlay;
    if (
      !isRecord(overlay) ||
      overlay.overlay !== '1.0.0' ||
      !isRecord(overlay.info) ||
      !Array.isArray(overlay.actions) ||
      !overlay.actions.length ||
      overlay.actions.length > 100 ||
      Buffer.byteLength(canonicalProjectionJson(overlay)) > 1024 * 1024
    )
      throw new Error('Invalid or oversized projection overlay');
    for (const action of overlay.actions) {
      if (!isRecord(action) || action.remove || !isRecord(action.update))
        throw new Error(
          'Projection overlays allow object updates only, never removal',
        );
      const path = parseOverlayTarget(action.target);
      if (
        path.length < 2 ||
        path[0] !== 'components' ||
        path[1] !== 'crudResources'
      )
        throw new Error(
          'Projection overlay updates must stay under components.crudResources',
        );
    }
    contracts.set(contract.sourceDocumentHash, contract);
  }
  const results = new Map<
    string,
    { document: OpenApiDocument; hash?: string }
  >();
  for (const source of sources) {
    const contract = contracts.get(source.documentHash);
    if (!contract) {
      results.set(source.documentHash, {
        document: structuredClone(source.document),
      });
      continue;
    }
    const document = applyOverlay(source.document, contract.overlay);
    const oldResources = source.document.components?.crudResources;
    const newResources = document.components?.crudResources;
    if (!isRecord(oldResources) || !isRecord(newResources))
      throw new Error('Projection overlay needs declared CRUD resources');
    for (const [name, oldResource] of Object.entries(oldResources)) {
      const next = newResources[name];
      if (
        !isRecord(oldResource) ||
        !isRecord(next) ||
        canonicalProjectionJson(withoutAnnotations(oldResource)) !==
          canonicalProjectionJson(withoutAnnotations(next))
      )
        throw new Error(
          'Projection overlay cannot change existing resource schema, identity or collections',
        );
      if (oldResource.references !== undefined) {
        if (!isRecord(oldResource.references) || !isRecord(next.references))
          throw new Error(
            'Projection overlay cannot replace existing references',
          );
        for (const [key, value] of Object.entries(oldResource.references))
          if (
            canonicalProjectionJson(value) !==
            canonicalProjectionJson(next.references[key])
          )
            throw new Error(
              'Projection overlay cannot change existing references',
            );
      }
    }
    for (const [name, resource] of Object.entries(newResources)) {
      if (Object.hasOwn(oldResources, name)) continue;
      if (
        !isRecord(resource) ||
        Object.keys(resource).some(
          (key) =>
            ![
              'description',
              'title',
              'schema',
              'identity',
              'collections',
              'references',
              'x-embeddedResources',
            ].includes(key),
        )
      )
        throw new Error(
          'New projection resources allow schema and identity metadata only',
        );
      if (resource.collections !== undefined) {
        if (
          !isRecord(resource.collections) ||
          Object.values(resource.collections).some(
            (collection) =>
              !isRecord(collection) ||
              Object.keys(collection).some(
                (key) => !['urlTemplate', 'envelope'].includes(key),
              ),
          )
        )
          throw new Error(
            'New projection collections cannot add request or authentication settings',
          );
      }
    }
    results.set(source.documentHash, {
      document: resolveRefs(document),
      hash: nodeHash(
        canonicalProjectionJson({
          version: 1,
          sourceDocumentHash: source.documentHash,
          overlay: contract.overlay,
        }),
      ),
    });
  }
  return results;
}
