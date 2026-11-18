// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JavaScript.
import { bundle } from './build.mjs';

describe('unpublished webhook inbox receiver selection', () => {
  it('requires an explicit receiver instead of sending to a public proxy', async () => {
    await expect(bundle()).rejects.toThrow('explicit --proxy-origin');
  });

  it.each(['http://127.0.0.1:8090', 'https://receiver.test'])(
    'preserves %s',
    async proxyOrigin => {
      const text = await bundle({ proxyOrigin });
      const plugin = await import(
        `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
      );
      expect(plugin.PROXY_ORIGIN).toBe(proxyOrigin);
      expect(
        plugin.manifest.operations.every((operation: { url: string }) =>
          operation.url.startsWith(`${proxyOrigin}/`),
        ),
      ).toBe(true);
      expect(text).not.toContain('https://localthought.io');
      expect(text).not.toContain('https://integrations.atomic.place');
    },
  );

  it.each([
    'https://user:secret@receiver.test',
    'https://receiver.test/path',
    'https://receiver.test?key=secret',
    'file:///tmp/receiver',
  ])(
    'rejects a receiver with credentials or a non-origin URL',
    async proxyOrigin => {
      await expect(bundle({ proxyOrigin })).rejects.toThrow(
        'bare HTTP(S) origin',
      );
    },
  );
});
