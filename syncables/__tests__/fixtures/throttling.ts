// @wc-ignore-file
/**
 * The Throttling extension 0.2.0-draft's response headers and signals, as
 * its README gives them (`openapi-extensions/spec/throttling/README.md`,
 * "Response headers and signals in three APIs") and its synthetic example
 * (`examples/response-signals.yaml`), transcribed to TypeScript. The three
 * provider snippets are the spec's reading of public documentation, not
 * verified against the live APIs; the example document is synthetic.
 */
import type { OpenApiDocument } from '../../src/browser.js';
import { petsDocument } from './pets.js';

/** `examples/response-signals.yaml`: GitHub-shaped headers and signals plus a Google-shaped body signal, with a `core` bucket. */
export const responseSignals: OpenApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Illustrative rate-limit headers and throttling signals',
    version: '1.0.0',
  },
  servers: [{ url: 'https://api.example.com' }],
  'x-throttling': {
    limits: {
      core: {
        requests: 5000,
        window: { seconds: 3600, kind: 'fixed' },
        partitionBy: ['user'],
      },
    },
    applies: ['core'],
    headers: {
      'X-RateLimit-Limit': { role: 'limit' },
      'X-RateLimit-Remaining': { role: 'remaining' },
      'X-RateLimit-Used': { role: 'used' },
      'X-RateLimit-Reset': { role: 'reset', unit: 'epochSeconds' },
      'Retry-After': { role: 'retryAfter', unit: 'deltaSecondsOrHttpDate' },
    },
    signals: [
      {
        status: [403, 429],
        header: { name: 'x-ratelimit-remaining', equals: '0' },
        meaning: 'quotaExhausted',
        bucket: 'core',
      },
      {
        status: [403, 429],
        header: { name: 'retry-after', present: true },
        meaning: 'throttled',
      },
      {
        status: [403],
        body: {
          pointer: '/error/errors',
          item: {
            pointer: '/reason',
            in: ['rateLimitExceeded', 'userRateLimitExceeded'],
          },
        },
        meaning: 'throttled',
      },
      {
        status: [403],
        body: { pointer: '/message', contains: 'secondary rate limit' },
        meaning: 'throttled',
        minDelaySeconds: 60,
        description:
          'The message text is an observation, not documented wording.',
      },
    ],
  },
  paths: {
    '/records': {
      get: {
        responses: {
          '200': { description: 'Records' },
          '403': {
            description:
              'Forbidden: a missing permission, or throttling as the signals above describe.',
          },
          '429': { description: 'The API throttled the request.' },
        },
      },
    },
  },
};

/** The README's GitHub snippet: headers, and signals without `limits`. */
export const githubThrottling = {
  headers: {
    'x-ratelimit-limit': { role: 'limit' },
    'x-ratelimit-remaining': { role: 'remaining' },
    'x-ratelimit-used': { role: 'used' },
    'x-ratelimit-reset': { role: 'reset', unit: 'epochSeconds' },
    'retry-after': { role: 'retryAfter', unit: 'deltaSeconds' },
  },
  signals: [
    {
      status: [403, 429],
      header: { name: 'x-ratelimit-remaining', equals: '0' },
      meaning: 'quotaExhausted',
    },
    {
      status: [403, 429],
      header: { name: 'retry-after', present: true },
      meaning: 'throttled',
    },
    {
      status: [403, 429],
      body: { pointer: '/message', contains: 'secondary rate limit' },
      meaning: 'throttled',
      minDelaySeconds: 60,
    },
  ],
};

/** The README's Google snippet: a reason inside the error array. */
export const googleThrottling = {
  signals: [
    {
      status: [403, 429],
      body: {
        pointer: '/error/errors',
        item: {
          pointer: '/reason',
          in: ['rateLimitExceeded', 'userRateLimitExceeded'],
        },
      },
      meaning: 'throttled',
    },
  ],
};

/** The README's Moneybird snippet: a 429 exhausts the one bucket; only Retry-After has a documented unit. */
export const moneybirdThrottling = {
  limits: {
    apiRequests: {
      requests: 150,
      window: { seconds: 300, kind: 'unspecified' },
      partitionBy: ['sourceIp'],
    },
  },
  applies: ['apiRequests'],
  headers: {
    'Retry-After': { role: 'retryAfter', unit: 'deltaSecondsOrHttpDate' },
  },
  signals: [
    { status: [429], meaning: 'quotaExhausted', bucket: 'apiRequests' },
  ],
};

/** The pets fixture with a root `x-throttling`. */
export function throttledPets(throttling: unknown): Record<string, unknown> {
  return {
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
    'x-throttling': throttling,
  };
}
