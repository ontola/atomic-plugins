// @wc-ignore-file
/**
 * Hands this app's errors, and a line per finished sync, to a user-testing
 * log hook, when one is installed.
 *
 * The app runs in a sandboxed frame, and the host shows an app's errors there
 * without reporting them anywhere, so without this nobody but the person at
 * the screen sees them. The app itself still makes no network request
 * (build.test.ts checks the bundle for `fetch(`): the test catalog's build
 * (ontola/atomic-plugins `usertest/catalog.mjs`) prepends a small prelude
 * that defines `globalThis.__USERTEST_REPORT__` and posts to the collector.
 * A published build has no prelude, so `report` does nothing there.
 *
 * Handed over: the error message and stack, the banner's problem kind and
 * status, and per sync the counts plus the ids and reasons of unreadable
 * events. Never: event titles, descriptions or other row content.
 */

export type Level = 'error' | 'warn' | 'info';

type Hook = (entry: Record<string, unknown>) => void;

declare global {
  var __USERTEST_REPORT__: Hook | undefined;
}

export function report(
  level: Level,
  message: string,
  data: Record<string, unknown> = {},
  hook: unknown = globalThis.__USERTEST_REPORT__,
): void {
  if (typeof hook !== 'function') return;

  try {
    (hook as Hook)({ source: 'calendar', level, message, ...data });
  } catch {
    // A broken hook never affects the app.
  }
}

export const errorStack = (error: unknown) =>
  error instanceof Error ? error.stack : undefined;

/** Reports what escapes every handler. */
export function reportUncaught(target: Window): void {
  target.addEventListener('error', event =>
    report('error', event.message, {
      kind: 'uncaught',
      stack: errorStack(event.error),
    }),
  );
  target.addEventListener('unhandledrejection', event =>
    report(
      'error',
      event.reason instanceof Error
        ? event.reason.message
        : String(event.reason),
      { kind: 'unhandled-rejection', stack: errorStack(event.reason) },
    ),
  );
}
