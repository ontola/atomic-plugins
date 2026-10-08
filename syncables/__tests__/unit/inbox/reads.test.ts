import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import type { InboxEvent } from '../../../src/inbox/client.js';
import { scopedReads } from '../../../src/inbox/reads.js';

// The Webhook Deliveries spec's synthetic GitHub fixture and one of its
// signed deliveries (openapi-extensions/spec/webhook-deliveries/examples):
// fake ids, a fake owner; the document declares which reads an event asks.
const examples = new URL(
  '../../../../openapi-extensions/spec/webhook-deliveries/examples/',
  import.meta.url,
);
const document = yaml.load(
  readFileSync(new URL('github-fixture.yaml', examples), 'utf8'),
);
const delivery = JSON.parse(
  readFileSync(
    new URL('github-deliveries/issues-edited.json', examples),
    'utf8',
  ),
) as { body: string };

function event(eventType: string, body: string): InboxEvent {
  return {
    cursor: 'c',
    generation: 'g1',
    deliveryId: 'd',
    eventType,
    action: 'edited',
    receivedAt: '2026-10-09T12:00:00Z',
    source: { kind: 'repository', key: '2000002' },
    payload: {
      mediaType: 'application/json',
      bytes: body.length,
      sha256: '0'.repeat(64),
      body: Buffer.from(body).toString('base64'),
    },
  };
}

describe('scopedReads', () => {
  it('names the issue and its collection for an issues delivery', () => {
    expect(scopedReads(document, event('issues', delivery.body))).toEqual([
      {
        kind: 'resource',
        resource: 'issue',
        path: '/repos/fixture-owner/fixture-repo/issues/7',
      },
      {
        kind: 'collection',
        resource: 'issue',
        collection: 'issues',
        path: '/repos/fixture-owner/fixture-repo/issues',
      },
    ]);
  });

  it('encodes each value as one path segment', () => {
    const body = JSON.parse(delivery.body);
    body.repository.name = 'a/b?c';
    const reads = scopedReads(document, event('issues', JSON.stringify(body)));
    expect(reads[0].path).toBe('/repos/fixture-owner/a%2Fb%3Fc/issues/7');
  });

  it('asks nothing for undeclared events, missing values or unreadable bodies', () => {
    expect(
      scopedReads(document, event('installation_repositories', delivery.body)),
    ).toEqual([]);
    const body = JSON.parse(delivery.body);
    delete body.issue;
    // The collection still binds; the issue itself cannot be named.
    expect(
      scopedReads(document, event('issues', JSON.stringify(body))).map(
        (r) => r.kind,
      ),
    ).toEqual(['collection']);
    expect(scopedReads(document, event('issues', 'not json'))).toEqual([]);
    expect(scopedReads({}, event('issues', delivery.body))).toEqual([]);
  });
});
