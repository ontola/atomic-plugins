import { spawn } from 'node:child_process';

export async function keychainCommand(
  args: string[],
  input = '',
): Promise<string> {
  if (process.platform !== 'darwin')
    throw new Error(
      'Persistent credentials require macOS Keychain; use --interactive for a foreground test',
    );
  return new Promise<string>((done, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Keychain access failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      return code === 0
        ? done(Buffer.concat(chunks).toString('utf8'))
        : reject(
            Object.assign(
              new Error('Keychain item unavailable or access refused'),
              { code },
            ),
          );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
