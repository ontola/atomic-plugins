import { canonicalJson } from './replace.js';

/**
 * A short, stable digest of a JSON value (object keys in any order), as a
 * sync baseline: keep the fingerprint of a record as both sides had it at
 * the last sync, and a side whose fingerprint now differs has changed it.
 * 14 hex characters (cyrb53, 53 bits). Not a security measure, and not for
 * telling which field changed: keep the fields themselves for a merge.
 */
export function fingerprint(value: unknown): string {
  const input = canonicalJson(value);
  // cyrb53: two 32-bit FNV-like lanes, 53 bits together.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(14, '0');
}
