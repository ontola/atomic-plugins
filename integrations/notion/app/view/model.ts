// @wc-ignore-file
/**
 * The status view's pure logic: which databases the table syncs with, the
 * status pill, warning counts, whether Sync now is offered. No DOM, so it is
 * unit-tested directly (`view.test.ts`). The #89 browsing logic (columns,
 * search, sort, board groups) went with the browsing views (#177 Q9).
 */
import { isRunning, type ViewState } from '../controller.js';
import type { SyncRecord } from '../record.js';
import type { Row } from '../rows.js';
import type { DataSourceReport } from '../sync.js';
import { ago, clock } from '../ui/format.js';
import type { PillModel } from '../ui/shell.js';

export interface Source {
  title: string;
  count: number;
  report?: DataSourceReport;
}

/** The databases the table syncs with: from the sync record, else from the rows. */
export function sources(rows: readonly Row[], last?: SyncRecord): Source[] {
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(row.dataSource, (counts.get(row.dataSource) ?? 0) + 1);
  const out: Source[] = [];

  for (const report of last?.dataSources ?? []) {
    out.push({
      title: report.title,
      count: counts.get(report.title) ?? 0,
      report,
    });
    counts.delete(report.title);
  }

  for (const [title, count] of counts) if (title) out.push({ title, count });

  return out;
}

/** Grouped warning lines of a record, as the sync details list them. */
export function notes(record: SyncRecord | undefined): number {
  if (!record) return 0;

  return (
    record.general.length +
    record.dataSources.reduce(
      (n, d) =>
        n +
        new Set(d.formatted.map(f => f.property)).size +
        (d.archived.length ? 1 : 0) +
        d.errors.length,
      0,
    )
  );
}

export function pill(
  state: ViewState,
  now: number,
  locale?: string,
): PillModel | undefined {
  switch (state.kind) {
    case 'loading':
    case 'no-proxy':
    case 'not-connected':
    case 'connecting':
      return undefined;

    case 'syncing': {
      const active = [...state.progress]
        .reverse()
        .find(p => p.phase !== 'done');

      return {
        tone: 'sync',
        text: active ? `Syncing… ${active.title}` : 'Syncing…',
      };
    }

    case 'importing': {
      const total = state.progress.length;
      if (!total) return { tone: 'sync', text: 'Importing…' };
      const at = Math.min(
        total,
        state.progress.filter(p => p.phase === 'done').length + 1,
      );

      return {
        tone: 'sync',
        text: `Importing ${at} of ${total} ${total === 1 ? 'database' : 'databases'}`,
      };
    }

    case 'no-databases':
      return { tone: 'warn', text: 'No databases shared' };
    case 'reauth':
      return { tone: 'neg', text: 'Reconnect needed' };
    case 'disconnected':
      return { tone: 'muted', text: 'Not connected' };
    case 'rate-limited':
      return {
        tone: 'warn',
        text: `Paused until ${clock(state.retryAt, locale)}`,
      };
    case 'failed':
      return { tone: 'neg', text: 'Sync failed' };

    case 'ready': {
      if (!state.last) return { tone: 'muted', text: 'Not synced yet' };
      const n = notes(state.last);

      return n
        ? { tone: 'warn', text: `Synced · ${n} ${n === 1 ? 'note' : 'notes'}` }
        : { tone: 'ok', text: `Synced ${ago(state.last.at, now)}` };
    }
  }
}

/** Whether the header's "Sync now" is offered, and enabled. */
export function syncAction(state: ViewState): {
  shown: boolean;
  enabled: boolean;
} {
  if (
    !('rows' in state) ||
    state.kind === 'reauth' ||
    state.kind === 'disconnected'
  )
    return { shown: false, enabled: false };

  return {
    shown: true,
    enabled:
      !isRunning(state) &&
      state.kind !== 'rate-limited' &&
      !!state.connectionId,
  };
}
