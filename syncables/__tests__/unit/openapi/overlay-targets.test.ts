// @wc-ignore-file
import { readdirSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  applyOverlay,
  parseOverlayTarget,
  type OverlayDocument,
} from '../../../src/openapi/apply-overlay.js';

// The target grammar of integration-proxy's catalog.rs `parse_target`,
// which the overlays in this repository are written for: `$`, then `.name`
// or `['name']` segments. Most of them address an operation by its path,
// `$.paths['/users.list'].get`, which a dot-path cannot spell.

const overlay = (actions: OverlayDocument['actions']): OverlayDocument => ({
  overlay: '1.0.0',
  info: { title: 'Test', version: '1.0.0' },
  actions,
});

describe('parseOverlayTarget', () => {
  it.each([
    ['$', []],
    ['$.components', ['components']],
    ["$.paths['/users.list'].get", ['paths', '/users.list', 'get']],
    [
      "$.paths['/{id}/issues'].get.responses['200'].content['application/json'].schema",
      [
        'paths',
        '/{id}/issues',
        'get',
        'responses',
        '200',
        'content',
        'application/json',
        'schema',
      ],
    ],
    ["$['paths']['a[b']", ['paths', 'a[b']],
  ])('splits %s', (target, keys) => {
    expect(parseOverlayTarget(target)).toEqual(keys);
  });

  it.each([
    'components',
    '$.',
    '$..paths',
    '$.paths[*]',
    '$.paths[0]',
    '$.paths["/pets"]',
    "$.paths['/pets'",
    "$.paths['/pets']get",
    '$.paths[?(@.get)]',
  ])('refuses %s', (target) => {
    expect(() => parseOverlayTarget(target)).toThrow(
      /Unsupported overlay target/,
    );
  });
});

describe('parseOverlayTarget unescapes nothing, as the proxy does', () => {
  it('reads a backslash before a quote as two literal characters', () => {
    expect(parseOverlayTarget("$.paths['a\\'b']")).toEqual(['paths', "a\\'b"]);
  });

  it("ends a bracket segment at the first ']", () => {
    expect(() => parseOverlayTarget("$.paths['a']b']")).toThrow(
      /Unsupported overlay target/,
    );
  });
});

describe('__proto__', () => {
  it.each(['$.__proto__', "$.paths['__proto__']", '$.a.__proto__.b'])(
    'refuses the target %s',
    (target) => {
      expect(() => parseOverlayTarget(target)).toThrow(
        /a __proto__ segment is refused/,
      );
    },
  );

  it('keeps a __proto__ key in a document and an update as an own member', () => {
    // JSON.parse makes "__proto__" an own key; plain assignment of it
    // would set the prototype instead.
    const document = JSON.parse('{"paths": {"__proto__": {"x": 1}}}') as Record<
      string,
      Record<string, unknown>
    >;
    const update = JSON.parse('{"__proto__": {"y": 2}, "polluted": true}');
    const result = applyOverlay(
      document,
      overlay([
        { target: '$.paths', update },
        { target: '$', update: JSON.parse('{"__proto__": {"z": 3}}') },
      ]),
    ) as Record<string, Record<string, unknown>>;
    const paths = result['paths']!;
    expect(Object.getPrototypeOf(paths)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(paths, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(paths, '__proto__')?.value).toEqual({
      x: 1,
      y: 2,
    });
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual(
      { z: 3 },
    );
    expect((paths as { y?: unknown }).y).toBeUndefined();
    expect(({} as { y?: unknown; z?: unknown }).y).toBeUndefined();
    expect(({} as { y?: unknown; z?: unknown }).z).toBeUndefined();
  });
});

describe('applyOverlay with bracket targets', () => {
  const document = {
    paths: {
      '/users.list': {
        get: {
          operationId: 'listUsers',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/oauth/token': { post: { security: [{ basic: [] }] } },
    },
  };

  it('merges onto an operation addressed by its path', () => {
    const result = applyOverlay(
      document,
      overlay([
        {
          target: "$.paths['/users.list'].get.responses['200']",
          update: { 'x-envelope': 'members' },
        },
      ]),
    );
    expect(result.paths['/users.list'].get).toEqual({
      operationId: 'listUsers',
      responses: { '200': { description: 'OK', 'x-envelope': 'members' } },
    });
  });

  it('replaces an array target with an array update, as the proxy does', () => {
    const update = [{ notionOAuthClient: [] }];
    const result = applyOverlay(
      document,
      overlay([{ target: "$.paths['/oauth/token'].post.security", update }]),
    );
    expect(result.paths['/oauth/token'].post.security).toEqual(update);
    // The result holds a copy: changing it leaves the overlay alone.
    (result.paths['/oauth/token'].post.security as unknown[]).push('x');
    expect(update).toEqual([{ notionOAuthClient: [] }]);
  });

  it('refuses a root update that is not an object', () => {
    expect(() =>
      applyOverlay(document, overlay([{ target: '$', update: [] }])),
    ).toThrow(/cannot replace the document root/);
  });

  it('does not walk into an inherited member', () => {
    const result = applyOverlay(
      {},
      overlay([{ target: '$.toString', update: { a: 1 } }]),
    );
    expect(Object.hasOwn(result, 'toString')).toBe(true);
    expect((result as Record<string, unknown>)['toString']).toEqual({ a: 1 });
  });
});

// Every overlay this repository publishes applies. Applied to an empty
// document, so the missing objects along each target are created: this
// checks the grammar and the action shapes, not the composed result, which
// the proxy's catalog test and the overlays' Python check cover against the
// pinned OADs (whose $refs an empty document cannot resolve).
const APIS = new URL('../../../../overlays/APIs/', import.meta.url);
const overlayFiles = (
  readdirSync(APIS, { recursive: true }) as string[]
).filter((file) => file.endsWith('-overlay.yaml'));

describe("this repository's overlays", () => {
  it('are all found', () => {
    expect(overlayFiles.length).toBeGreaterThan(500);
  });

  it('all apply', () => {
    let actions = 0;
    const failures: string[] = [];
    for (const file of overlayFiles) {
      const parsed = yaml.load(
        readFileSync(new URL(file, APIS), 'utf8'),
      ) as OverlayDocument;
      if (!Array.isArray(parsed?.actions)) continue;
      actions += parsed.actions.length;
      try {
        applyOverlay({}, parsed);
      } catch (error) {
        failures.push(`${file}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(actions).toBeGreaterThan(2000);
  });
});
