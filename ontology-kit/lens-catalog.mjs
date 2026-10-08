/**
 * The shared lens catalog (pieces.md L1, Q-089): build the published lens
 * files from `ontology-kit/lenses.json`, and check them. `ontology.mjs`
 * calls this from `build` and `check`, so the catalog is fresh, immutable
 * and served exactly like the term files. LENSES.md is the format's spec.
 *
 *   ontology/lenses/v<N>             a catalog release: every lens it offers
 *   ontology/lenses/<name>-v<N>      one lens, with its mapping and examples
 *
 * Node builtins only, like ontology.mjs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LensError,
  deepEqual,
  endpointKey,
  lawProblems,
  lensGet,
  lensPut,
  parseMapping,
  referenceKind,
  storedMapping,
} from './lens.mjs';

export const LENS_DIR = 'lenses';
export const LENS_FORMAT = 1;

const LENS_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;
const RELEASE = /^v[1-9][0-9]*$/;
const HTTPS = /^https:\/\/[^\s]+$/;
const IRI = /^https?:\/\/[^\s]+$/;
const SLUG_OR_DOMAIN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const RESOURCE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OPENAPI = /^APIs\/[^\s]+[^/\s]$/;
const ENDPOINT_KINDS = ['class', 'record', 'rdf'];

/** The lens catalog source, or undefined when the repository has none. */
export function readLensSource(base) {
  const file = resolve(base, 'ontology-kit', 'lenses.json');

  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

const releaseOrder = lensSource =>
  Object.keys(lensSource.releases ?? {}).sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );

const kindOf = endpoint =>
  ENDPOINT_KINDS.filter(k => endpoint && Object.hasOwn(endpoint, k));

/**
 * Resolves a reference on a class endpoint: a property shortname that the
 * ontology source defines becomes its subject; an absolute https URL stays.
 */
function propertyRef(ref, termsSource, ontologyBase) {
  if (HTTPS.test(ref)) return ref;
  if (Object.hasOwn(termsSource.properties ?? {}, ref))
    return `${ontologyBase}/properties/${ref}`;

  return undefined;
}

function classRef(ref, termsSource, ontologyBase) {
  if (HTTPS.test(ref)) return ref;
  if (Object.hasOwn(termsSource.classes ?? {}, ref))
    return `${ontologyBase}/classes/${ref}`;

  return undefined;
}

/** The fields a shared class lists, as resolved property subjects. */
function sharedFields(name, termsSource, ontologyBase) {
  const c = termsSource.classes?.[name];
  if (!c) return undefined;
  const ref = r => propertyRef(r, termsSource, ontologyBase) ?? r;

  return {
    requires: (c.requires ?? []).map(ref),
    all: [...(c.requires ?? []), ...(c.recommends ?? [])].map(ref),
  };
}

/** Does a crud-causality overlay under `overlays/<openapi>/` declare it? */
export function overlayDeclaresResource(base, openapi, resource) {
  const dir = resolve(base, 'overlays', openapi);
  if (!existsSync(dir)) return false;

  return readdirSync(dir)
    .filter(f => /^crud-causality-.*-overlay\.yaml$/.test(f))
    .some(f => {
      const lines = readFileSync(resolve(dir, f), 'utf8').split('\n');
      const at = lines.findIndex(l => /^\s*crudResources:\s*$/.test(l));
      if (at < 0) return false;
      const indent = lines[at].search(/\S/);
      const child = lines
        .slice(at + 1)
        .find(l => l.trim() && !l.trim().startsWith('#'));
      const childIndent = child ? child.search(/\S/) : -1;
      if (childIndent <= indent) return false;

      for (const l of lines.slice(at + 1)) {
        if (!l.trim() || l.trim().startsWith('#')) continue;
        const n = l.search(/\S/);
        if (n <= indent) break;
        if (n === childIndent && l.trim() === `${resource}:`) return true;
      }

      return false;
    });
}

/**
 * Resolves one lens's source form to its published form: shared shortnames
 * become subjects in endpoints, mapping references and example rows on
 * class endpoints. Throws on a reference it cannot resolve.
 */
function resolveLens(name, lens, termsSource, ontologyBase) {
  const sides = {};

  for (const side of ['source', 'target']) {
    const endpoint = lens[side];
    const [kind] = kindOf(endpoint);
    if (kind === 'class') {
      const subject = classRef(endpoint.class, termsSource, ontologyBase);
      if (!subject)
        throw new Error(
          `lens ${name}: ${side} class "${endpoint.class}" is neither a class in source.json nor an absolute https URL`,
        );
      sides[side] = {
        endpoint: { class: subject },
        kind,
        shared: endpoint.class,
      };
    } else sides[side] = { endpoint: structuredClone(endpoint), kind };
  }

  const ref = (side, value) => {
    if (sides[side].kind !== 'class') return value;
    const subject = propertyRef(value, termsSource, ontologyBase);
    if (!subject)
      throw new Error(
        `lens ${name}: ${side} "${value}" is neither a property in source.json nor an absolute https URL`,
      );

    return subject;
  };

  const mapping = {
    ...lens.mapping,
    fields: (lens.mapping?.fields ?? []).map(f => ({
      ...f,
      source: ref('source', f.source),
      target: ref('target', f.target),
    })),
    ...(Array.isArray(lens.mapping?.guards)
      ? {
          guards: lens.mapping.guards.map(g =>
            g && typeof g.at === 'string'
              ? { ...g, at: ref('source', g.at) }
              : g,
          ),
        }
      : {}),
  };

  const row = (side, value) => {
    if (sides[side].kind !== 'class' || !value || typeof value !== 'object')
      return structuredClone(value);

    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [ref(side, k), structuredClone(v)]),
    );
  };

  const examples = (lens.examples ?? []).map(e => ({
    source: row('source', e.source),
    ...(e.target !== undefined ? { target: row('target', e.target) } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    ...(e.edits
      ? {
          edits: e.edits.map(edit => ({
            ...(edit.direction !== undefined
              ? { direction: edit.direction }
              : {}),
            ...(edit.target !== undefined
              ? { target: row('target', edit.target) }
              : {}),
            ...(edit.source !== undefined
              ? { source: row('source', edit.source) }
              : {}),
            ...(edit.error !== undefined ? { error: edit.error } : {}),
          })),
        }
      : {}),
  }));

  return { sides, mapping, examples };
}

/**
 * The key a release's one-lens-per-pair rule and the source-is-not-target
 * rule compare: `endpointKey`, except that a record is its provider and
 * resource, with or without the `openapi` folder that declares it.
 */
function pairKey(endpoint, termsSource, ontologyBase) {
  if (endpoint.class !== undefined)
    return (
      classRef(endpoint.class, termsSource, ontologyBase) ?? endpoint.class
    );
  if (endpoint.record)
    return `record:${endpoint.record.provider}#${endpoint.record.resource}`;

  return endpointKey(endpoint);
}

const DATATYPE = 'https://atomicdata.dev/datatypes/';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Why `value` is not of an Atomic datatype, or undefined when it is. */
export function datatypeProblem(value, datatype) {
  const kind = datatype.startsWith(DATATYPE)
    ? datatype.slice(DATATYPE.length)
    : undefined;
  const ok = {
    string: () => typeof value === 'string',
    markdown: () => typeof value === 'string',
    slug: () => typeof value === 'string' && /^[a-z0-9-]+$/.test(value),
    uri: () => typeof value === 'string',
    atomicURL: () => typeof value === 'string' && /^https?:\/\//.test(value),
    boolean: () => typeof value === 'boolean',
    integer: () => Number.isSafeInteger(value),
    timestamp: () => Number.isSafeInteger(value),
    float: () => typeof value === 'number' && Number.isFinite(value),
    date: () => typeof value === 'string' && DAY.test(value),
    resourceArray: () =>
      Array.isArray(value) && value.every(v => typeof v === 'string'),
    json: () => true,
  }[kind];
  if (!ok) return `has the unknown datatype ${datatype}`;

  return ok() ? undefined : `is ${JSON.stringify(value)}, not a ${kind} value`;
}

/**
 * Example rows on a class endpoint, checked against the datatypes
 * source.json gives its properties (only those: other vocabularies' terms
 * are not known here).
 */
function rowDatatypeProblems(row, termsSource, ontologyBase) {
  const problems = [];
  if (!row || typeof row !== 'object') return problems;

  for (const [shortname, p] of Object.entries(termsSource.properties ?? {})) {
    const subject = `${ontologyBase}/properties/${shortname}`;
    if (!Object.hasOwn(row, subject)) continue;
    const problem = datatypeProblem(row[subject], p.datatype);
    if (problem) problems.push(`${shortname} ${problem}`);
  }

  return problems;
}

/**
 * Problems with lenses.json, given the ontology source it refers to. `base`
 * is the repository root, for the `openapi` paths. Whether `implementation`
 * files exist is `implementationProblems`, which `check` runs only for
 * lenses that are not published yet.
 */
export function lensSourceProblems(
  lensSource,
  termsSource,
  ontologyBase,
  base,
) {
  const problems = [];
  if (lensSource === undefined) return problems;
  const lenses = lensSource.lenses ?? {};
  const releases = lensSource.releases ?? {};

  const text = (what, value) => {
    if (typeof value !== 'string' || !value.trim())
      problems.push(`${what} needs a non-empty string`);
  };

  for (const [name, lens] of Object.entries(lenses)) {
    const at = `lens ${name}`;
    if (!LENS_NAME.test(name))
      problems.push(`${at}: a lens name is a slug ending in -v<N>`);
    text(`${at}: name`, lens.name);
    text(`${at}: description`, lens.description);

    for (const side of ['source', 'target']) {
      const endpoint = lens[side];
      const kinds = kindOf(endpoint);

      if (kinds.length !== 1 || Object.keys(endpoint).length !== 1) {
        problems.push(
          `${at}: ${side} is exactly one of {"class"}, {"record"} or {"rdf"}`,
        );
        continue;
      }

      if (kinds[0] === 'record') {
        const r = endpoint.record ?? {};
        const extra = Object.keys(r).filter(
          k => !['provider', 'resource', 'openapi'].includes(k),
        );
        if (extra.length)
          problems.push(`${at}: ${side} record: unknown ${extra.join(', ')}`);
        if (typeof r.provider !== 'string' || !SLUG_OR_DOMAIN.test(r.provider))
          problems.push(
            `${at}: ${side} record needs a provider (an openapi-directory provider key or a lowercase name)`,
          );
        if (typeof r.resource !== 'string' || !RESOURCE.test(r.resource))
          problems.push(`${at}: ${side} record needs a resource name`);

        if (r.openapi !== undefined) {
          if (typeof r.openapi !== 'string' || !OPENAPI.test(r.openapi))
            problems.push(
              `${at}: ${side} record openapi is a path under overlays/, "APIs/<provider>/…"`,
            );
          else if (!r.openapi.startsWith(`APIs/${r.provider}/`))
            problems.push(
              `${at}: ${side} record openapi ${r.openapi} is not under APIs/${r.provider}/`,
            );
          else if (!overlayDeclaresResource(base, r.openapi, r.resource))
            problems.push(
              `${at}: no crud-causality overlay in overlays/${r.openapi}/ declares crudResources.${r.resource}`,
            );
        }
      } else if (kinds[0] === 'rdf') {
        if (typeof endpoint.rdf !== 'string' || !IRI.test(endpoint.rdf))
          problems.push(`${at}: ${side} rdf is an RDF class IRI`);
      } else if (typeof endpoint.class !== 'string')
        problems.push(`${at}: ${side} class is a shortname or a subject`);
    }

    if (
      lens.implementation !== undefined &&
      (typeof lens.implementation !== 'string' ||
        !/^integrations\/[^\s]+$/.test(lens.implementation))
    )
      problems.push(
        `${at}: implementation is a repository path under integrations/`,
      );

    if (
      lens.limits !== undefined &&
      (!Array.isArray(lens.limits) ||
        !lens.limits.every(l => typeof l === 'string' && l.trim()))
    )
      problems.push(`${at}: limits is a list of sentences`);
    if (!Array.isArray(lens.examples) || lens.examples.length === 0)
      problems.push(
        `${at}: needs at least one example: the evidence its laws are checked on`,
      );
    else
      lens.examples.forEach((e, i) => {
        const where = `${at}: example ${i + 1}`;
        if (!e || typeof e !== 'object' || e.source === undefined)
          problems.push(`${where} needs a source`);
        else if ((e.target === undefined) === (e.error === undefined))
          problems.push(
            `${where} has either a target (what get gives) or an error (the code get refuses with)`,
          );
        else if (e.error !== undefined && e.edits !== undefined)
          problems.push(`${where}: an example get refuses has no edits`);

        for (const [j, edit] of (e?.edits ?? []).entries()) {
          const what = `${where}, edit ${j + 1}`;
          const backward = edit?.direction === 'backward';
          if (edit?.direction !== undefined && !backward)
            problems.push(`${what}: direction is "backward" or left out`);
          else if (
            backward &&
            (edit.source === undefined ||
              edit.target === undefined ||
              edit.error !== undefined)
          )
            problems.push(
              `${what}: a backward edit has a source (the view) and a target (the row it gives)`,
            );
          else if (
            !backward &&
            (edit?.target === undefined ||
              (edit.source === undefined) === (edit.error === undefined))
          )
            problems.push(
              `${what}: an edit has a target and either a source (what put gives) or an error`,
            );
        }
      });
  }

  if (problems.length) return problems;

  for (const [name, lens] of Object.entries(lenses))
    if (
      pairKey(lens.source, termsSource, ontologyBase) ===
      pairKey(lens.target, termsSource, ontologyBase)
    )
      problems.push(`lens ${name}: its source and target are the same`);

  for (const [name, lens] of Object.entries(lenses)) {
    const at = `lens ${name}`;
    let resolved;

    try {
      resolved = resolveLens(name, lens, termsSource, ontologyBase);
    } catch (error) {
      problems.push(error.message);
      continue;
    }

    const { sides, mapping, examples } = resolved;
    let parsed;

    try {
      parsed = parseMapping(mapping);
    } catch (error) {
      problems.push(`${at}: ${error.message}`);
      continue;
    }

    if (parsed.version < 2)
      problems.push(`${at}: catalog lenses use mapping version 2 or 3`);

    for (const side of ['source', 'target']) {
      const want = sides[side].kind === 'class' ? 'key' : 'pointer';

      const refs = [
        ...parsed.fields.map(f => f[side]),
        ...(side === 'source' ? parsed.guards.map(g => g.at) : []),
      ];

      for (const ref of refs)
        if (referenceKind(ref) !== want)
          problems.push(
            `${at}: ${side} "${ref}" must be ${want === 'key' ? 'a property (shortname or absolute URL) on a class endpoint' : 'a JSON Pointer on a record or rdf endpoint'}`,
          );

      const shared = sides[side].shared;
      const fields = shared && sharedFields(shared, termsSource, ontologyBase);
      if (!fields) continue;

      for (const f of parsed.fields)
        if (!fields.all.includes(f[side]))
          problems.push(
            `${at}: ${side} ${f[side]} is not a field of the shared class ${shared}`,
          );

      for (const required of fields.requires)
        if (!parsed.fields.some(f => f[side] === required))
          problems.push(
            `${at}: maps no ${side} for ${required}, which ${shared} requires`,
          );
    }

    examples.forEach((example, i) => {
      const where = `${at}: example ${i + 1}`;
      const rows = [
        ['source', 'source', example.source],
        ['target', 'target', example.target],
        ...(example.edits ?? []).flatMap((edit, j) => [
          ['target', `edit ${j + 1} target`, edit.target],
          ['source', `edit ${j + 1} source`, edit.source],
        ]),
      ].filter(([, , row]) => row !== undefined);

      for (const [side, label, row] of rows)
        if (sides[side].kind === 'class')
          for (const p of rowDatatypeProblems(row, termsSource, ontologyBase))
            problems.push(`${where}: ${label}: ${p}`);

      if (example.error !== undefined) {
        try {
          lensGet(parsed, example.source);
          problems.push(
            `${where}: expected get to refuse with ${example.error}`,
          );
        } catch (error) {
          if (!(error instanceof LensError) || error.code !== example.error)
            problems.push(
              `${where}: expected get to refuse with ${example.error}, got ${error.message}`,
            );
        }

        return;
      }

      try {
        const got = lensGet(parsed, example.source);
        if (!deepEqual(got, example.target))
          problems.push(
            `${where}: get gives ${JSON.stringify(got)}, the example says ${JSON.stringify(example.target)}`,
          );
        for (const p of lawProblems(parsed, example.source))
          problems.push(`${where}: ${p}`);
        for (const p of lawProblems(
          parsed,
          example.target,
          undefined,
          'backward',
        ))
          problems.push(`${where}: ${p}`);

        for (const [j, edit] of (example.edits ?? []).entries()) {
          const what = `${where}, edit ${j + 1}`;

          if (edit.direction === 'backward') {
            const put = lensPut(
              parsed,
              edit.source,
              example.target,
              'backward',
            );
            if (!deepEqual(put, edit.target))
              problems.push(
                `${what} (backward): put gives ${JSON.stringify(put)}, the example says ${JSON.stringify(edit.target)}`,
              );
            continue;
          }

          if (edit.error !== undefined) {
            try {
              lensPut(parsed, edit.target, example.source);
              problems.push(`${what}: expected a ${edit.error} refusal`);
            } catch (error) {
              if (!(error instanceof LensError) || error.code !== edit.error)
                problems.push(
                  `${what}: expected a ${edit.error} refusal, got ${error.message}`,
                );
            }

            continue;
          }

          const put = lensPut(parsed, edit.target, example.source);
          if (!deepEqual(put, edit.source))
            problems.push(
              `${what}: put gives ${JSON.stringify(put)}, the example says ${JSON.stringify(edit.source)}`,
            );
          for (const p of lawProblems(parsed, example.source, edit.target))
            problems.push(`${what}: ${p}`);
        }
      } catch (error) {
        problems.push(`${where}: ${error.message}`);
      }
    });
  }

  const listed = new Set();

  for (const [release, r] of Object.entries(releases)) {
    const at = `lens release ${release}`;
    if (!RELEASE.test(release)) problems.push(`${at}: a release is named v<N>`);
    text(`${at}: name`, r.name);
    text(`${at}: description`, r.description);

    if (!Array.isArray(r.lenses) || r.lenses.length === 0) {
      problems.push(`${at}: lists no lenses`);
      continue;
    }

    const pairs = new Map();

    for (const name of r.lenses) {
      listed.add(name);

      if (!Object.hasOwn(lenses, name)) {
        problems.push(`${at}: lists lens ${name}, which is not defined`);
        continue;
      }

      const lens = lenses[name];
      const pair = [
        pairKey(lens.source, termsSource, ontologyBase),
        pairKey(lens.target, termsSource, ontologyBase),
      ]
        .sort()
        .join(' <-> ');

      if (pairs.has(pair))
        problems.push(
          `${at}: ${pairs.get(pair)} and ${name} both connect ${pair}; one release offers one lens per pair of classes`,
        );
      else pairs.set(pair, name);
    }
  }

  for (const name of Object.keys(lenses))
    if (!listed.has(name)) problems.push(`lens ${name} is in no release`);

  return problems;
}

/**
 * `implementation` paths that do not exist, for lenses not in `published`
 * (their names). A published lens file never changes, so its path records
 * where its code lens was when it was published, and moving that code must
 * not fail CI; the path is informative, never executed.
 */
export function implementationProblems(
  lensSource,
  base,
  published = new Set(),
) {
  if (lensSource === undefined) return [];

  return Object.entries(lensSource.lenses ?? {})
    .filter(
      ([name, lens]) =>
        !published.has(name) &&
        typeof lens.implementation === 'string' &&
        !existsSync(resolve(base, lens.implementation)),
    )
    .map(
      ([name, lens]) =>
        `lens ${name}: implementation ${lens.implementation} does not exist`,
    );
}

const firstRelease = (lensSource, name) =>
  releaseOrder(lensSource).find(r =>
    (lensSource.releases[r].lenses ?? []).includes(name),
  );

/**
 * The files the catalog publishes, as a map from repository-relative path
 * to text. `render` and `TERMS_DIR` come from ontology.mjs. Assumes
 * `lensSourceProblems` found nothing.
 */
export function generateLenses(
  lensSource,
  termsSource,
  ontologyBase,
  { render, termsDir },
) {
  const files = new Map();
  if (lensSource === undefined) return files;
  const subject = name => `${ontologyBase}/${LENS_DIR}/${name}`;

  for (const release of releaseOrder(lensSource)) {
    const r = lensSource.releases[release];
    files.set(
      `${termsDir}/${LENS_DIR}/${release}`,
      render({
        '@id': subject(release),
        lensFormat: LENS_FORMAT,
        name: r.name,
        description: r.description,
        lenses: r.lenses.map(subject),
      }),
    );
  }

  for (const [name, lens] of Object.entries(lensSource.lenses ?? {})) {
    const { sides, mapping, examples } = resolveLens(
      name,
      lens,
      termsSource,
      ontologyBase,
    );
    const doc = {
      '@id': subject(name),
      lensFormat: LENS_FORMAT,
      release: subject(firstRelease(lensSource, name)),
      name: lens.name,
      description: lens.description,
      source: sides.source.endpoint,
      target: sides.target.endpoint,
      mapping: storedMapping(mapping),
    };
    if (lens.limits?.length) doc.limits = [...lens.limits];
    if (lens.implementation) doc.implementation = lens.implementation;
    doc.examples = examples;
    files.set(`${termsDir}/${LENS_DIR}/${name}`, render(doc));
  }

  return files;
}
