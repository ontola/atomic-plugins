import { createHash } from 'node:crypto';
import { init, compress, decompress } from '@bokuweb/zstd-wasm';

export interface Payload {
  hash: string;
  codec: 'identity' | 'zstd-v1';
  rawBytes: number;
  bytes: Buffer;
}

let ready: Promise<void> | undefined;

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function encode(text: string, limit: number): Promise<Payload> {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length > limit)
    throw new Error('Response exceeds the archive body limit');
  const result: Payload = {
    hash: digest(raw),
    codec: 'identity',
    rawBytes: raw.length,
    bytes: raw,
  };
  if (raw.length < 256) return result;
  await (ready ??= init());
  const packed = Buffer.from(compress(raw, 3));
  return packed.length < raw.length
    ? { ...result, codec: 'zstd-v1', bytes: packed }
    : result;
}

/** Check the single-frame content size before the WASM decoder allocates it. */
function frameSize(bytes: Buffer): number {
  if (bytes.length < 6 || bytes.readUInt32LE(0) !== 0xfd2fb528)
    throw new Error('Invalid archived Zstandard frame');
  const descriptor = bytes[4];
  const singleSegment = (descriptor & 32) !== 0;
  const flag = descriptor >> 6;
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
  const sizeBytes = flag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][flag];
  const offset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes;
  if (!sizeBytes || offset + sizeBytes > bytes.length || descriptor & 8)
    throw new Error('Archived Zstandard frame must declare its content size');
  const value =
    sizeBytes === 8
      ? bytes.readBigUInt64LE(offset)
      : BigInt(bytes.readUIntLE(offset, sizeBytes) + (flag === 1 ? 256 : 0));
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Invalid archived payload size');
  return Number(value);
}

export async function decode(payload: Payload, limit: number): Promise<string> {
  if (
    !Number.isSafeInteger(payload.rawBytes) ||
    payload.rawBytes < 0 ||
    payload.rawBytes > limit ||
    payload.bytes.length > limit
  )
    throw new Error('Archived payload exceeds the body limit');
  let raw: Buffer;
  if (payload.codec === 'identity') raw = payload.bytes;
  else if (payload.codec === 'zstd-v1') {
    if (frameSize(payload.bytes) !== payload.rawBytes)
      throw new Error('Archived frame size does not match its metadata');
    await (ready ??= init());
    raw = Buffer.from(
      decompress(payload.bytes, { defaultHeapSize: payload.rawBytes }),
    );
  } else throw new Error('Unsupported archive codec');
  if (raw.length !== payload.rawBytes || digest(raw) !== payload.hash)
    throw new Error('Archived payload checksum or size mismatch');
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}
