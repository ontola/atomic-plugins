// @wc-ignore-file
/**
 * The sidebar at 900px and wider (DESIGN.md §4): a mini month that moves the
 * main view, and the imported calendar with its visibility checkbox and
 * Read-only tag. What was not imported is the sync-status card's
 * (`ui/status.ts`), above the views.
 */
import type { Ctx } from './context.js';
import type { CalendarMeta } from './sync.js';
import { isReadOnly } from './sync.js';
import { h, ICONS, svg } from './ui/dom.js';
import { addDays, longDay, mondayOf, monthTitle } from './time.js';

export function sidebar(
  ctx: Ctx,
  {
    month,
    selected,
    weekFrom,
    weekDays,
    meta,
    visible,
    onMonth,
    onVisible,
  }: {
    /** Any date in the month shown. */
    month: string;
    selected: string;
    weekFrom: string;
    weekDays: number;
    meta: CalendarMeta;
    visible: boolean;
    onMonth: (date: string) => void;
    onVisible: (visible: boolean) => void;
  },
): HTMLElement {
  const { doc } = ctx;
  const first = `${month.slice(0, 7)}-01`;
  const start = mondayOf(first);
  const nextMonth = addDays(first, 32).slice(0, 7);
  const prevMonth = addDays(first, -1).slice(0, 7);
  const weekEnd = addDays(weekFrom, weekDays);
  const cells: HTMLElement[] = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d =>
    h(doc, 'span', { class: 'mm-w', 'aria-hidden': 'true' }, d),
  );

  for (let i = 0; i < 42; i++) {
    const date = addDays(start, i);
    if (i >= 35 && date.slice(0, 7) !== month.slice(0, 7)) break;
    const classes = [
      'mm-d',
      date.slice(0, 7) !== month.slice(0, 7) ? 'out' : '',
      date >= weekFrom && date < weekEnd ? 'in-wk' : '',
      date === ctx.today ? 'today' : '',
    ]
      .filter(Boolean)
      .join(' ');
    cells.push(
      h(
        doc,
        'button',
        {
          class: classes,
          'data-key': `mm-${date}`,
          'aria-label': longDay(date),
          'aria-current': date === selected ? 'date' : undefined,
          onclick: () => ctx.goTo(date),
        },
        String(Number(date.slice(8))),
      ),
    );
  }

  const readOnly = isReadOnly(meta.accessRole);

  return h(
    doc,
    'aside',
    { class: 'side', 'aria-label': 'Calendars' },
    h(
      doc,
      'div',
      {},
      h(
        doc,
        'div',
        { class: 'mm-hd' },
        h(doc, 'b', {}, monthTitle(first)),
        h(
          doc,
          'span',
          {},
          h(
            doc,
            'button',
            {
              class: 'icon-btn',
              style: 'width:24px;height:24px',
              'aria-label': 'Previous month',
              'data-key': 'mm-prev',
              onclick: () => onMonth(`${prevMonth}-01`),
            },
            svg(doc, ICONS.prev),
          ),
          h(
            doc,
            'button',
            {
              class: 'icon-btn',
              style: 'width:24px;height:24px',
              'aria-label': 'Next month',
              'data-key': 'mm-next',
              onclick: () => onMonth(`${nextMonth}-01`),
            },
            svg(doc, ICONS.next),
          ),
        ),
      ),
      h(
        doc,
        'div',
        { class: 'mm-g', role: 'group', 'aria-label': monthTitle(first) },
        ...cells,
      ),
    ),
    h(
      doc,
      'section',
      { class: 'side-sec' },
      h(doc, 'h2', {}, 'My calendars'),
      h(
        doc,
        'ul',
        { class: 'cals' },
        h(
          doc,
          'li',
          {},
          h(
            doc,
            'label',
            {},
            h(doc, 'input', {
              type: 'checkbox',
              checked: visible,
              'data-key': 'cal-visible',
              onchange: (event: Event) =>
                onVisible((event.target as HTMLInputElement).checked),
            }),
            h(doc, 'span', {
              class: 'sw',
              style: `--c:${meta.color}`,
              'aria-hidden': 'true',
            }),
            h(doc, 'span', { class: 'nm' }, meta.summary),
            readOnly ? h(doc, 'em', { class: 'tag' }, 'Read-only') : null,
          ),
        ),
      ),
    ),
  );
}
