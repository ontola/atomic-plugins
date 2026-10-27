import { describe, expect, it } from 'vitest';
import { encode, decode } from '../../../src/postgres/codec.js';
import { requestIdentity } from '../../../src/postgres/identity.js';

describe('local compressed payloads', () => {
  it('preserves response text exactly and compresses repetitive JSON', async () => {
    const body = JSON.stringify(
      {
        title: 'Invented café issue',
        notes: 'a long repeated note '.repeat(1000),
      },
      null,
      2,
    );
    const payload = await encode(body, 100_000);
    expect(payload.codec).toBe('zstd-v1');
    expect(payload.bytes.length).toBeLessThan(payload.rawBytes / 10);
    expect(await decode(payload, 100_000)).toBe(body);
    const tiny = await encode('', 100);
    expect(tiny.codec).toBe('identity');
    expect(await decode(tiny, 100)).toBe('');
  });

  it('checks size and checksums and refuses oversized frames before decoding', async () => {
    await expect(encode('too long', 3)).rejects.toThrow('body limit');
    const packed = await encode('repeat '.repeat(1000), 10_000);
    await expect(decode({ ...packed, rawBytes: 1 }, 10_000)).rejects.toThrow(
      'frame size',
    );
    await expect(
      decode({ ...packed, rawBytes: 100_000 }, 10_000),
    ).rejects.toThrow('body limit');
    const tiny = await encode('hello', 100);
    await expect(
      decode({ ...tiny, bytes: Buffer.from('world') }, 100),
    ).rejects.toThrow('checksum');
  });

  it('keys representations, excludes credentials, and refuses mutations and secret URLs', () => {
    const url = new URL('https://api.example/issues?page=1');
    const first = requestIdentity({
      url,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        authorization: 'invented-private-value',
        cookie: 'invented-cookie',
      },
    });
    expect(JSON.stringify(first.request)).not.toContain('invented-private');
    expect(JSON.stringify(first.request)).not.toContain('invented-cookie');
    const other = requestIdentity({
      url,
      method: 'GET',
      headers: { accept: 'text/plain' },
    });
    expect(first.key).not.toBe(other.key);
    const conditional = requestIdentity({
      url,
      method: 'GET',
      headers: { accept: 'application/json', 'if-none-match': 'demo-etag' },
    });
    expect(conditional.cacheKey).toBe(first.cacheKey);
    expect(conditional.key).not.toBe(first.key);
    expect(() => requestIdentity({ url, method: 'POST', headers: {} })).toThrow(
      'GET',
    );
    expect(() =>
      requestIdentity({
        url: new URL('https://api.example?access_token=demo'),
        method: 'GET',
        headers: {},
      }),
    ).toThrow('secrets');
  });
});
