/** Willow Drop Format encoder (https://willowprotocol.org/specs/drop-format/,
 * status "Proposal") for Willow'25 entries with communal capabilities and no
 * delegations, each followed by its whole payload. The byte layout mirrors
 * the decoder in ../willow-drop/drop.ts, which was checked against drops
 * written by willow25 0.7.9; fixtures/verify-drop checks our output with
 * willow25's own DropDecoder. Also: the data model's recommended timestamp
 * and standard base64, both without Node APIs, for the QuickJS sandbox.
 */
import {
  compact,
  encodePath,
  hex,
  u64,
  unhex,
  validateEntry,
} from './codec.mjs';
import { william3 } from '../willow-drop/william3.ts';

/** The Willow'25 example id: the namespace and subspace of the default entry. */
export const DEFAULT_ID =
  '934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318';

/** The entry the first entry of a drop is encoded against. */
export function defaultEntry() {
  return {
    namespace: unhex(DEFAULT_ID),
    subspace: unhex(DEFAULT_ID),
    path: [],
    timestamp: 0n,
    payloadLength: 0n,
    payloadDigest: william3(new Uint8Array()),
  };
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** A compact U64 in a 2-bit tag with no inline values: tag 0 means 1 byte,
 * 1 means 2, 2 means 4 and 3 means 8. */
function tag2(value) {
  u64(value);
  const size =
    value < 256n ? 1 : value < 65536n ? 2 : value < 4294967296n ? 4 : 8;
  const out = [];
  for (let i = size - 1; i >= 0; i--)
    out.push(Number((value >> BigInt(i * 8)) & 255n));

  return { tag: [1, 2, 4, 8].indexOf(size), bytes: out };
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && same(a[i], b[i])) i++;

  return i;
}

/**
 * The drop of `items`, in order. Each item is `{ entry, signature, payload }`:
 * an Entry (as codec.mjs), the 64-byte Ed25519 signature of its subspace key
 * over `encode_entry`, and the whole payload, whose length and WILLIAM3
 * digest must match the entry. Only communal capabilities (the signer is the
 * subspace) are encoded; the namespace must be communal (last byte even).
 */
export function encodeDrop(items) {
  const out = [];
  let previous = defaultEntry();

  for (const { entry, signature, payload } of items) {
    validateEntry(entry);
    if (entry.namespace[31] % 2 !== 0)
      throw Error('Only communal namespaces are encoded');
    if (!(signature instanceof Uint8Array) || signature.length !== 64)
      throw Error('An authorisation signature is 64 bytes');
    if (
      !(payload instanceof Uint8Array) ||
      BigInt(payload.length) !== entry.payloadLength ||
      hex(william3(payload)) !== hex(entry.payloadDigest)
    )
      throw Error('The payload does not match its entry');
    const namespace = !same(entry.namespace, previous.namespace);
    const subspace = !same(entry.subspace, previous.subspace);
    const time = tag2(entry.timestamp);
    const prefix = commonPrefix(entry.path, previous.path);
    // 01: an entry header; 0x20/0x10: namespace/subspace included; the
    // timestamp's tag; 01: the whole payload follows.
    out.push(
      0x40 |
        (namespace ? 0x20 : 0) |
        (subspace ? 0x10 : 0) |
        (time.tag << 2) |
        0x01,
    );
    if (namespace) out.push(...entry.namespace);
    if (subspace) out.push(...entry.subspace);
    out.push(
      ...compact(BigInt(prefix)),
      ...encodePath(entry.path.slice(prefix)),
    );
    out.push(
      ...time.bytes,
      ...compact(entry.payloadLength),
      ...entry.payloadDigest,
    );
    // A communal capability without delegations: an all-zero header.
    out.push(0x00, ...signature, ...payload);
    previous = entry;
  }

  out.push(0x00);

  return Uint8Array.from(out);
}

/** J2000 (2000-01-01 12:00:00 TT = 11:59:27.816 TAI) on a TAI clock, in
 * microseconds since 1970-01-01 00:00 on that clock. As
 * ../willow-drop/mapping.ts and atomic-server's `plugins/willow.rs`. */
const J2000_TAI_US = 946_727_967_816_000n;
/** TAI − UTC from each UTC instant on, in seconds (IERS Bulletin C). */
const LEAP_SECONDS = [
  [1_483_228_800_000_000n, 37n], // 2017-01-01
  [1_435_708_800_000_000n, 36n], // 2015-07-01
  [1_341_100_800_000_000n, 35n], // 2012-07-01
  [1_230_768_000_000_000n, 34n], // 2009-01-01
  [1_136_073_600_000_000n, 33n], // 2006-01-01
  [0n, 32n], // from 1999-01-01, which covers J2000
];

/**
 * A Unix time in milliseconds (an Atomic commit's `createdAt`) as the data
 * model's recommended timestamp: microseconds of TAI since J2000. willow25
 * 0.7.9 reads timestamps through hifitime's J2000_REF_EPOCH (2000-01-02 12:00
 * TAI), 86,432.184 s away from this reading (worm-blossom/willow_rs#62).
 */
export function willowTime(unixMillis) {
  if (typeof unixMillis !== 'bigint')
    throw Error('Expected bigint milliseconds');
  const us = unixMillis * 1000n;
  const [, offset] = LEAP_SECONDS.find(([start]) => us >= start);
  const value = us + offset * 1_000_000n - J2000_TAI_US;
  if (value < 0n) throw Error('Willow timestamps start at J2000');

  return u64(value);
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding. */
export function base64(bytes) {
  let out = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
  }

  return out;
}
