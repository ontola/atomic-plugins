// @wc-ignore-file
/**
 * M2 hooks (#123 M2, the timeline lens): how the views show time whose
 * coverage is **unknown**, and **conflicts** between this drive and
 * Clockify. Both are fields of `Timesheet` (`../model/types.ts`).
 *
 * The views call these two functions in the right places. Since M2 the
 * timeline sweep (`../timeline/sweep.ts`) fills both fields and these
 * render them read-only; each returns `null` when there is nothing to show.
 */
import type { Interval, Timesheet } from '../model/types.js';
import {
  renderConflictList,
  renderUnknownSpans,
  type ConflictActions,
} from '../timeline/render.js';
import { button } from './components.js';
import type { H } from './dom.js';

/**
 * Called by the Week and Entries views above the grid or day list: the
 * table's rows missing a required `time-entry-v1` field (#177;
 * ontology-kit's rule: shown as incomplete, never skipped), each with its
 * note and, when the host can show a row, an "Open row" button. Nothing
 * when `sheet.incomplete` is empty or absent.
 */
export function renderIncomplete(
  h: H,
  sheet: Timesheet,
  onOpen?: (id: string) => void,
): HTMLElement | null {
  const rows = sheet.incomplete ?? [];
  if (!rows.length) return null;
  const n = rows.length;

  return h(
    'div',
    {
      class: 'unknown incomplete',
      role: 'note',
      'aria-label': 'Incomplete rows',
    },
    h(
      'p',
      { style: 'margin:0 0 4px' },
      h('strong', null, `${n} ${n === 1 ? 'row is' : 'rows are'} incomplete`),
      `: not counted as ${n === 1 ? 'an entry' : 'entries'}, and not sent to Clockify. Fill the column in the table.`,
    ),
    h(
      'ul',
      { style: 'margin:0;padding:0;list-style:none' },
      rows.map(row =>
        h(
          'li',
          {
            'data-incomplete': row.id,
            style:
              'display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-height:28px',
          },
          h('span', null, row.description || '(no description)'),
          h('strong', null, row.note),
          onOpen
            ? button(h, 'Open row', {
                variant: 'sec',
                key: `open-row:${row.id}`,
                label: `Open row ${row.description || '(no description)'}`,
                onClick: () => onOpen(row.id),
              })
            : null,
        ),
      ),
    ),
  );
}

/**
 * Called by the Week and Entries views for the displayed week (`span`,
 * `[from, to)` in epoch ms), above the grid or day list. `unknown` is
 * `sheet.unknown` clipped to `span`, possibly empty.
 *
 * M2: a "Not loaded" note listing the spans (`../timeline/render.ts`);
 * nothing when `unknown` is empty.
 */
export function renderUnknown(
  h: H,
  sheet: Timesheet,
  _span: Interval,
  unknown: Interval[],
): HTMLElement | null {
  return renderUnknownSpans(h, sheet, unknown);
}

/**
 * Called once at the top of the content area of every data view, above the
 * error banners' data. `sheet.conflicts` may be empty.
 *
 * One line per conflict (`../timeline/render.ts`); nothing when there is
 * none. With `actions` (#123 M4) each line offers its resolutions; without,
 * it is read-only (no connection, or not synced yet).
 */
export function renderConflicts(
  h: H,
  sheet: Timesheet,
  actions?: ConflictActions,
): HTMLElement | null {
  return renderConflictList(h, sheet, actions);
}

/** Spans shorter than this are not shown: the views count whole minutes,
 * and the few seconds between a sync's read and "now" would otherwise read
 * as "Not loaded: 08:09 – 08:09". */
export const MIN_UNKNOWN_MS = 60_000;

/** `sheet.unknown` clipped to `span`, without sub-minute slivers. */
export const unknownIn = (sheet: Timesheet, span: Interval): Interval[] =>
  sheet.unknown
    .map(i => ({
      from: Math.max(i.from, span.from),
      to: Math.min(i.to, span.to),
    }))
    .filter(i => i.to - i.from >= MIN_UNKNOWN_MS);
