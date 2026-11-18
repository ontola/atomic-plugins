import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  deviceLogin: vi.fn(),
  listConnections: vi.fn(),
  probeApi: vi.fn(),
}));
vi.mock('../../../src/cli/auth.js', () => auth);

describe('CLI issuer selection', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it.each([
    ['daemon', '--interactive'],
    ['send'],
    ['sync', '--interactive', '--write'],
    ['sync', '--interactive', '--manage'],
  ])(
    'rejects invalid grant-stdin arguments before authentication: %j',
    async (...args) => {
      vi.resetModules();
      vi.clearAllMocks();
      const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      process.argv = ['node', 'syncables', ...args, '--connection-grant-stdin'];
      await import('../../../src/cli/main.js');
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      expect(error.mock.calls[0][0]).toContain(
        'requires interactive sync or send',
      );
      expect(auth.deviceLogin).not.toHaveBeenCalled();
      expect(auth.listConnections).not.toHaveBeenCalled();
    },
  );

  it.each([
    [undefined, 'https://integrations.atomic.place'],
    ['https://proxy.example', 'https://proxy.example'],
    ['http://127.0.0.1:11872', 'http://127.0.0.1:11872'],
    ['https://localthought.io', 'https://localthought.io'],
  ])('selects issuer %s for a fresh device login', async (issuer, expected) => {
    vi.resetModules();
    vi.clearAllMocks();
    const session = { issuer: expected, accessToken: 'invented-token' };
    auth.deviceLogin.mockResolvedValue(session);
    auth.listConnections.mockResolvedValue({
      owner: 'invented-owner',
      connections: [],
    });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.argv = [
      'node',
      'syncables',
      'auth-test',
      '--client-id',
      'test-client',
      ...(issuer === undefined ? [] : ['--issuer', issuer]),
    ];
    await import('../../../src/cli/main.js');
    await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
    expect(auth.deviceLogin).toHaveBeenCalledWith(
      { issuer: expected, clientId: 'test-client' },
      expect.any(Object),
    );
    expect(auth.listConnections).toHaveBeenCalledWith(session);
    expect(auth.probeApi).not.toHaveBeenCalled();
  });
});
