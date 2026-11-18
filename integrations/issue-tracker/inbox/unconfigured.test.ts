// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import { manifest, run, type Ctx } from './plugin.js';

describe('unconfigured webhook inbox source', () => {
  it('declares no receiver and refuses a run before reaching the host transport', async () => {
    const http = vi.fn();
    expect(manifest.operations).toEqual([]);
    await expect(run({ http } as unknown as Ctx)).rejects.toThrow(
      'explicit --proxy-origin test receiver',
    );
    expect(http).not.toHaveBeenCalled();
  });
});
