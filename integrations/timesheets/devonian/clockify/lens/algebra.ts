// @wc-ignore-file
/** Prototype for the next Devonian release; not imported by published apps. */
import { customLens, recordLens } from 'devonian/lenses';
import {
  blockers,
  clockifyInstant,
  descriptionOf,
  entryValues,
  type ClockifyTimeEntry,
  type EntryValues,
  type WriteContext,
} from './writeBack.js';

/** Coupled source fields stay together. Project names are read-only display
 * metadata; the edit view addresses a project by its stable identity. */
export interface ClockifyEdit {
  name: string;
  interval: { start: number; end: number };
  billable: boolean;
  projectId: string | null;
}

function values(source: ClockifyTimeEntry): EntryValues {
  const result = entryValues(source);
  if (!result) throw new Error('Lens requires a completed REGULAR entry');

  return result;
}

/** Context is supplied by the host, never read from a clock or network here.
 * This lens updates a complete source representation; putBody still owns the
 * provider's request-body contract and the surrounding host owns review. */
export function clockifyEntryLens(context: WriteContext) {
  const snapshot = structuredClone(context);

  return recordLens<ClockifyTimeEntry, ClockifyEdit>(
    {
      name: customLens({
        reads: ['description', 'type', 'timeInterval'],
        writes: ['description'],
        get: (source: ClockifyTimeEntry) => values(source).name,
        put: (name: string) => ({ set: { description: descriptionOf(name) } }),
      }),
      interval: customLens({
        reads: ['timeInterval', 'type'],
        writes: ['timeInterval'],
        get: (source: ClockifyTimeEntry) => {
          const { start, end } = values(source);

          return { start, end };
        },
        put: (
          interval: ClockifyEdit['interval'],
          previous: ClockifyTimeEntry,
        ) => {
          const current = values(previous);
          for (const key of ['start', 'end'] as const)
            if (
              interval[key] !== current[key] &&
              (!Number.isSafeInteger(interval[key]) ||
                interval[key] % 1000 !== 0)
            )
              throw new Error('Changed Clockify times require whole seconds');

          return {
            set: {
              timeInterval: {
                ...previous.timeInterval,
                start:
                  interval.start === current.start
                    ? previous.timeInterval.start
                    : clockifyInstant(interval.start),
                end:
                  interval.end === current.end
                    ? previous.timeInterval.end
                    : clockifyInstant(interval.end),
              },
            },
          };
        },
      }),
      billable: customLens({
        reads: ['billable', 'type', 'timeInterval'],
        writes: ['billable'],
        get: (source: ClockifyTimeEntry) => values(source).billable,
        put: (billable: boolean) => ({ set: { billable } }),
      }),
      projectId: customLens({
        reads: ['projectId', 'taskId', 'type', 'timeInterval'],
        writes: ['projectId', 'taskId'],
        get: (source: ClockifyTimeEntry) => values(source).projectId,
        put: (projectId: string | null) => ({
          set: { projectId },
          unset: ['taskId'],
        }),
      }),
    },
    (view, previous) => {
      if (
        typeof view.name !== 'string' ||
        view.name !== view.name.trim() ||
        !view.name
      )
        throw new Error('Clockify name must be nonempty trimmed text');
      if (
        typeof view.billable !== 'boolean' ||
        (view.projectId !== null &&
          (typeof view.projectId !== 'string' || !view.projectId))
      )
        throw new Error('Invalid Clockify billable flag or project identity');
      const desired = {
        ...values(previous),
        name: view.name,
        billable: view.billable,
        projectId: view.projectId,
        ...view.interval,
      };
      const reasons = blockers(previous, snapshot, desired);
      if (reasons.length) throw new Error(reasons.join(' '));
    },
  );
}
