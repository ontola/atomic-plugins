// @wc-ignore-file
/**
 * The connect refusals are matched by the proxy's own wording (problem.ts
 * `PROXY_MESSAGES`), because the host passes only the message to the frame
 * (ontola/atomic-server#2321). This fails when the proxy rewords one of them,
 * so the table is updated in the same change.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROXY_MESSAGES } from './problem.js';

const API_ERROR = new URL(
  '../../../integration-proxy/src/api_error.rs',
  import.meta.url,
);

describe('the proxy messages problem.ts matches', () => {
  const source = readFileSync(API_ERROR, 'utf8');

  it.each(PROXY_MESSAGES.map(([pattern, code]) => [code, pattern] as const))(
    '%s: its phrase is still in integration-proxy/src/api_error.rs',
    (code, pattern) => {
      expect(source).toMatch(pattern);
      // The variant that answers the code is in the same file.
      expect(source).toContain(`=> "${code}"`);
    },
  );
});
