// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import { report } from './report.js';

describe('report', () => {
  it('does nothing without a hook, as in every published build', () => {
    expect(() => report('error', 'boom')).not.toThrow();
    expect(() => report('error', 'boom', {}, 'not a function')).not.toThrow();
  });

  it('hands one entry to the hook a test build installs', () => {
    const hook = vi.fn();

    report('warn', 'Sync finished', { total: 3 }, hook);

    expect(hook).toHaveBeenCalledWith({
      source: 'calendar',
      level: 'warn',
      message: 'Sync finished',
      total: 3,
    });
  });

  it('never throws when the hook does', () => {
    const hook = () => {
      throw new Error('collector down');
    };

    expect(() => report('error', 'boom', {}, hook)).not.toThrow();
  });
});
