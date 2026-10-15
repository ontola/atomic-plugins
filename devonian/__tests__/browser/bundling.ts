// The esbuild bundling, entry-point drivers and expected driver results
// shared by bundle.test.ts (a node:vm context) and
// ../real-browser/entry-points.spec.ts (headless Chromium).
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, type Metafile, type Plugin } from 'esbuild';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  exports: Record<string, string | Record<string, string>>;
};
export const useBuild = process.env.DEVONIAN_TEST_BUILD === '1';

const nodeBuiltins = new Set(builtinModules);
export function isNodeBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    nodeBuiltins.has(specifier) ||
    nodeBuiltins.has(specifier.split('/')[0]!)
  );
}

/** The file a subpath resolves to under the given export conditions. */
export function exportTarget(subpath: string, conditions: string[]): string {
  const entry = pkg.exports[subpath];
  if (entry === undefined) throw new Error(`no export ${subpath}`);
  let target: string | undefined;
  if (typeof entry === 'string') {
    target = entry;
  } else {
    const condition = [...conditions, 'default'].find((c) => c in entry);
    target = condition === undefined ? undefined : entry[condition];
  }
  if (target === undefined) throw new Error(`no target for ${subpath}`);
  const file = useBuild
    ? `${root}${target.slice(2)}`
    : `${root}${target.slice(2).replace(/^build\/(src\/.*)\.js$/, '$1.ts')}`;
  if (!existsSync(file)) throw new Error(`${subpath} -> missing ${file}`);
  return file;
}

function plugins(conditions: string[], nodeImports: string[]): Plugin[] {
  return [
    {
      name: 'devonian-exports',
      setup(b): void {
        b.onResolve({ filter: /^devonian(\/.*)?$/ }, (args) => ({
          path: exportTarget(
            args.path === 'devonian'
              ? '.'
              : `./${args.path.slice('devonian/'.length)}`,
            conditions,
          ),
        }));
      },
    },
    {
      name: 'no-node-builtins',
      setup(b): void {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (!isNodeBuiltin(args.path)) return undefined;
          nodeImports.push(
            `${args.path} <- ${args.importer.replace(root, '')}`,
          );
          return { errors: [{ text: `Node built-in ${args.path}` }] };
        });
      },
    },
  ];
}

export async function bundle(
  entry: string,
  format: 'esm' | 'iife',
  conditions = ['browser'],
): Promise<{ text: string; metafile: Metafile; nodeImports: string[] }> {
  const nodeImports: string[] = [];
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      conditions,
      format,
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
      plugins: plugins(conditions, nodeImports),
    });
    return {
      text: result.outputFiles[0]!.text,
      metafile: result.metafile,
      nodeImports,
    };
  } catch (error) {
    if (nodeImports.length > 0)
      return { text: '', metafile: { inputs: {}, outputs: {} }, nodeImports };
    throw error;
  }
}

/** Packages (by node_modules name) that ended up in a bundle. */
export function packagesIn(metafile: Metafile): string[] {
  return [
    ...new Set(
      Object.keys(metafile.inputs)
        .filter((input) => input.includes('node_modules/'))
        .map((input) =>
          input.replace(/.*node_modules\/((?:@[^/]+\/)?[^/]+).*/, '$1'),
        ),
    ),
  ].sort();
}

export const subpaths = Object.keys(pkg.exports).filter(
  (subpath) => subpath !== './package.json',
);
export const drivers: Record<string, string> = {
  '.': 'root',
  './atomic': 'atomic',
  './background': 'background',
  './lenses': 'lenses',
  './reflect': 'reflect',
};

export const expected: Record<string, unknown> = {
  '.': {
    rightAdded: ['Anvil'],
    seen: ['once:1', 'on:1', 'on:2'],
    resources: 1,
    reconcileRecord: 'function',
  },
  './atomic': {
    published: 't1',
    name: 'Rocket',
    count: 1,
    unbound: 't1',
    bound: null,
  },
  './background': { runs: 1, outcome: 'ran', stored: true },
  './lenses': {
    title: 'After',
    body: null,
    getPut: true,
    putGet: true,
    stablePut: true,
  },
  './reflect': {
    counterpart: { system: 'b', id: '9' },
    kv: 'v',
    origin: { system: 'a', kind: 'issue', id: '1' },
  },
};
