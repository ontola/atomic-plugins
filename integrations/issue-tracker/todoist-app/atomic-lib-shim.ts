// @wc-ignore-file
/**
 * Build-time stand-in for `../../browser/lib/src/index.js` in the drive-app
 * bundle only (build.mjs resolves that path here). `../todoist.ts` imports
 * `Datatype` from it for the five projected properties' datatypes, and
 * nothing else; bundling the whole library into a module stored as a string
 * on a resource is not worth that. Typecheck and tests use the real library;
 * build.test.ts pins every value here to it.
 */
export const Datatype = {
  ATOMIC_URL: 'https://atomicdata.dev/datatypes/atomicURL',
  BOOLEAN: 'https://atomicdata.dev/datatypes/boolean',
  DATE: 'https://atomicdata.dev/datatypes/date',
  FLOAT: 'https://atomicdata.dev/datatypes/float',
  INTEGER: 'https://atomicdata.dev/datatypes/integer',
  JSON: 'https://atomicdata.dev/datatypes/json',
  MARKDOWN: 'https://atomicdata.dev/datatypes/markdown',
  RESOURCEARRAY: 'https://atomicdata.dev/datatypes/resourceArray',
  SLUG: 'https://atomicdata.dev/datatypes/slug',
  STRING: 'https://atomicdata.dev/datatypes/string',
  TIMESTAMP: 'https://atomicdata.dev/datatypes/timestamp',
  UNKNOWN: 'unknown-datatype',
} as const;
