import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import type { createApiClient } from '../../../src/browser.js';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(
  new URL('../../../src/browser.ts', import.meta.url),
);
const nodeEntry = fileURLToPath(
  new URL('../../../src/index.ts', import.meta.url),
);

const builtins = new Set(builtinModules);
function isNodeBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    builtins.has(specifier.split('/')[0] as string)
  );
}

/** Records every import of a Node built-in (and marks it external so the build can finish and report them all). */
function recordNodeImports(found: string[]): Plugin {
  return {
    name: 'record-node-imports',
    setup(pluginBuild): void {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (!isNodeBuiltin(args.path)) {
          return undefined;
        }
        found.push(`${args.path} (imported by ${args.importer})`);
        return { path: args.path, external: true };
      });
    },
  };
}

async function bundle(
  file: string,
): Promise<{ nodeImports: string[]; inputs: string[]; text: string }> {
  const nodeImports: string[] = [];
  const result = await build({
    entryPoints: [file],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [recordNodeImports(nodeImports)],
  });
  return {
    nodeImports,
    inputs: Object.keys(result.metafile.inputs),
    text: result.outputFiles[0]?.text ?? '',
  };
}

describe('syncables/browser bundle', () => {
  it('executes the bundled local-first client with browser globals and a custom transport', async () => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'Syncables',
      target: 'es2022',
      write: false,
    });
    const api = runInNewContext(`${result.outputFiles[0]?.text}; Syncables`, {
      URL,
      crypto: webcrypto,
      structuredClone,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    }) as { createApiClient: typeof createApiClient };
    const client = api.createApiClient(
      {
        openapi: '3.0.0',
        info: { title: 'Browser fixture', version: '1' },
        servers: [{ url: 'https://browser.example' }],
        paths: {
          '/items': { get: { responses: {} }, post: { responses: {} } },
          '/items/{id}': { put: { responses: {} }, delete: { responses: {} } },
        },
      },
      {
        transport: async (request) => ({
          status: 200,
          headers: {},
          body:
            request.method === 'GET'
              ? '[{"id":"1","title":"old"}]'
              : (request.body ?? ''),
        }),
      },
    );
    await client.sync();
    await client.update('/items', '1', { title: 'edited' });
    expect(await client.get('/items', '1')).toMatchObject({ title: 'edited' });
    const created = await client.create('/items', { title: 'created' });
    expect(typeof created['id']).toBe('string');
    expect(await client.get('/items', String(created['id']))).toMatchObject({
      title: 'created',
    });
  });

  it('bundles for platform: browser without importing any Node built-in', async () => {
    const { nodeImports, inputs, text } = await bundle(entry);
    expect(nodeImports).toEqual([]);
    // Only this package's own sources: no js-yaml, no transitive dependency
    // that could pull a Node built-in in later.
    expect(
      inputs.every(
        (input) => input.includes('src/') && !input.includes('node_modules'),
      ),
    ).toBe(true);
    expect(
      inputs.some(
        (input) =>
          input.includes('mock-server') ||
          input.includes('client/credentials') ||
          input.includes('client/node'),
      ),
    ).toBe(false);
    // Node-only globals that a bundler would not shim either.
    expect(text).not.toMatch(/\bprocess\.|\bBuffer\.|\brequire\(/);
  });

  it('detects a Node built-in when one is imported (the check is not vacuous)', async () => {
    const { nodeImports } = await bundle(nodeEntry);
    expect(nodeImports.length).toBeGreaterThan(0);
    expect(nodeImports.some((line) => line.startsWith('node:http'))).toBe(true);
  });
});
