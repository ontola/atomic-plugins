import { describe, expect, it } from 'vitest';

import { InboxClient } from '../../../src/inbox/client.js';
import { requestUrl, trimBase } from '../../../src/inbox/url.js';

const transport = async (): Promise<never> => {
  throw new Error('not called');
};

describe('trimBase (#481 review)', () => {
  it('keeps a canonical base and strips every trailing slash', () => {
    for (const [base, trimmed] of [
      ['https://proxy.example', 'https://proxy.example'],
      ['https://proxy.example/', 'https://proxy.example'],
      ['https://proxy.example///', 'https://proxy.example'],
      ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
      ['https://proxy.example:8443/inbox/', 'https://proxy.example:8443/inbox'],
      ['http://10.0.0.1:9000', 'http://10.0.0.1:9000'],
    ]) {
      expect(trimBase(base!)).toBe(trimmed);
      // What a transport gets is exactly what is signed.
      expect(requestUrl(`${trimmed}/subscriptions/s`).href).toBe(
        `${trimmed}/subscriptions/s`,
      );
    }
  });

  it('refuses a base that URL would rewrite, so the signed URL would differ', () => {
    for (const base of [
      'https://Proxy.example',
      'https://proxy.example:443',
      'http://proxy.example:80',
      'https://proxy.example:0443',
      'https://proxy.example?x=1',
      'https://proxy.example#top',
      'https://user@proxy.example',
      'https://proxy.example/a b',
      'https://proxy.example/%7Einbox',
      'https://proxy.example/a/../b',
      'https://proxy.example/./b',
      'ftp://proxy.example',
      // IP literals URL rewrites or refuses (#481 review).
      'http://127.1',
      'http://0x7f.0.0.1',
      'http://010.0.0.1',
      'http://1.2.3.4.5',
      'http://256.0.0.1',
      'http://[::1]',
      'http://[0:0::1]',
      'http://[::ffff:1.2.3.4]',
      'proxy.example',
      '',
    ]) {
      expect(() => trimBase(base)).toThrow('not a canonical base URL');
      expect(() => new InboxClient(base, transport)).toThrow(TypeError);
    }
  });
});

describe('trimBase without URL (the QuickJS sandbox)', () => {
  it('refuses the same IP literals by the pattern alone', () => {
    const saved = globalThis.URL;
    try {
      (globalThis as { URL?: unknown }).URL = undefined;
      for (const base of [
        'http://127.1',
        'http://0x7f.0.0.1',
        'http://010.0.0.1',
        'http://1.2.3.4.5',
        'http://[0:0::1]',
      ]) {
        expect(() => trimBase(base)).toThrow('not a canonical base URL');
      }
      expect(trimBase('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    } finally {
      globalThis.URL = saved;
    }
  });
});
