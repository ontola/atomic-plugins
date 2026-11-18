import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isRecord } from '../read/model.js';

const execute = promisify(execFile);
export type NativeOperation = (
  request: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Build the permission-bearing app separately from the browser-safe library. */
export async function buildMacApp(directory: string): Promise<string> {
  if (process.platform !== 'darwin')
    throw new Error('The macOS connector requires macOS');
  const app = join(directory, 'Syncables macOS Connector.app');
  const contents = join(app, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  let source = fileURLToPath(
    new URL('../../../native-macos/main.swift', import.meta.url),
  );
  if (!(await stat(source).catch(() => undefined)))
    source = fileURLToPath(
      new URL('../../native-macos/main.swift', import.meta.url),
    );
  const binary = join(contents, 'MacOS', 'connector');
  const current = await stat(binary).catch(() => undefined);
  const fingerprint = createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
  const fingerprintFile = join(directory, 'native-source.sha256');
  const previous = await readFile(fingerprintFile, 'utf8').catch(
    () => undefined,
  );
  if (!current || previous !== fingerprint) {
    await execute('/usr/bin/swiftc', ['-O', source, '-o', binary], {
      timeout: 120_000,
    });
    await writeFile(
      join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.syncables.macos-connector</string>
<key>CFBundleName</key><string>Syncables macOS Connector</string>
<key>CFBundleExecutable</key><string>connector</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSPhotoLibraryUsageDescription</key><string>Inventory photo and video metadata for Syncables without requesting originals or thumbnails.</string>
</dict></plist>`,
      { mode: 0o600 },
    );
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    await writeFile(fingerprintFile, fingerprint, { mode: 0o600 });
  }
  return app;
}

export function macNative(app: string, directory: string): NativeOperation {
  // LaunchServices attributes Photos consent to this app bundle.
  return async (request) => {
    const id = randomUUID();
    const input = join(directory, id + '.request.json');
    const output = join(directory, id + '.response.json');
    await writeFile(input, JSON.stringify(request), {
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await execute(
        '/usr/bin/open',
        ['-n', '-W', '-a', app, '--args', input, output],
        { timeout: 300_000 },
      );
      const result: unknown = JSON.parse(await readFile(output, 'utf8'));
      if (!isRecord(result))
        throw new Error('Invalid native connector response');
      if (result.error)
        throw new Error(
          String(result.error) +
            (result.code === undefined
              ? ''
              : ` (${result.domain} ${result.code})`),
        );
      return result;
    } finally {
      await rm(input, { force: true });
      await rm(output, { force: true });
    }
  };
}
