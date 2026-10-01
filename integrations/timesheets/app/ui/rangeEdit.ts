// @wc-ignore-file
/**
 * "Edit a time range" (#123 M4): mark `[from, to)` as worked on a project,
 * worked with no project, or not worked. The range is in the profile's time
 * zone, to the minute. Saving plans it and stages it on the rows; it is
 * listed under "Changes to send" and reaches Clockify only when sent.
 */
import type { RangeRequest } from '../controller.js';
import type { ClockifyProject } from '../../devonian/clockify/lens/index.js';
import { button } from './components.js';
import type { H } from './dom.js';
import { fromLocalInput, localInput } from './edit.js';

const HOUR = 3_600_000;

export interface RangeEditorProps {
  timeZone: string;
  projects: ClockifyProject[];
  projectRequired: boolean;
  /** Epoch ms: the form starts on the last whole hour before it. */
  now: number;
  /** Why the last save was refused, if it was. */
  error?: string;
  onSave: (request: RangeRequest) => void;
  onCancel: () => void;
}

/** The `What` select's value for a target, and back. */
const NOT_WORKED = 'not-worked';
const NO_PROJECT = 'worked:';

export function targetOf(value: string): RangeRequest['target'] {
  if (value === NOT_WORKED) return { kind: 'didNotWork' };

  return { kind: 'worked', projectId: value.slice('worked:'.length) || null };
}

export function rangeEditor(
  h: H,
  p: RangeEditorProps,
): { body: HTMLElement; footer: HTMLElement[] } {
  const end = Math.floor(p.now / HOUR) * HOUR;
  const from = h('input', {
    id: 'rg-from',
    type: 'datetime-local',
    class: 'inp',
    step: 60,
    value: localInput(end - HOUR, p.timeZone),
  });
  const to = h('input', {
    id: 'rg-to',
    type: 'datetime-local',
    class: 'inp',
    step: 60,
    value: localInput(end, p.timeZone),
  });
  const what = h(
    'select',
    { id: 'rg-what', class: 'sel' },
    ...p.projects.map(project =>
      h(
        'option',
        { value: `worked:${project.id}` },
        `Worked on ${project.name}`,
      ),
    ),
    p.projectRequired
      ? null
      : h('option', { value: NO_PROJECT }, 'Worked, no project'),
    h('option', { value: NOT_WORKED }, 'Did not work'),
  );
  const problem = h(
    'p',
    { class: 'chg-blocked', role: 'alert', hidden: !p.error },
    p.error ?? '',
  );
  const field = (id: string, label: string, control: HTMLElement) =>
    h('div', { class: 'field' }, h('label', { for: id }, label), control);

  const save = () => {
    const a = fromLocalInput(from.value, p.timeZone);
    const b = fromLocalInput(to.value, p.timeZone);

    if (a === undefined || b === undefined || !(a < b)) {
      problem.textContent = 'From has to be a time before To.';
      problem.hidden = false;

      return;
    }

    p.onSave({ from: a, to: b, target: targetOf(what.value) });
  };

  const body = h(
    'form',
    { class: 'edit', 'aria-label': 'Edit a time range' },
    field('rg-from', `From (${p.timeZone})`, from),
    field('rg-to', `To (${p.timeZone})`, to),
    field('rg-what', 'What happened', what),
    problem,
    h(
      'p',
      { class: 'prov' },
      'Entries in the range are trimmed, split, extended or created so Clockify says exactly this for it, and nothing changes outside it. You review every change under “Changes to send” before anything reaches Clockify.',
    ),
  );
  body.addEventListener('submit', event => {
    event.preventDefault();
    save();
  });

  return {
    body,
    footer: [
      button(h, 'Plan changes', { key: 'range-save', onClick: save }),
      button(h, 'Cancel', {
        variant: 'ghost',
        key: 'range-cancel',
        onClick: p.onCancel,
      }),
    ],
  };
}
