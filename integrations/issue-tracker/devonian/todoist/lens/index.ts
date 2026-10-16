// @wc-ignore-file
/** Passive API v1 task lens; completion and scheduling stay read-only. */
import {
  fieldLens,
  readOnlyLens,
  recordLens,
  type ValueLens,
} from 'devonian/lenses';
import {
  AtomicSchema,
  Datatype,
  IS_A,
  type AtomicPatch,
  type AtomicResource,
} from 'devonian/atomic';
import { classes as sharedClasses } from '../../../../../ontology-kit/terms.mjs';

export const issueTerms = {
  class: sharedClasses['issue-v1'].subject,
  name: 'https://atomicdata.dev/properties/name',
  body: 'https://atomicdata.dev/task/v1/body',
  status: 'https://atomicdata.dev/task/v1/status',
  due: 'https://atomicdata.dev/task/v1/due-date',
  todo: 'https://atomicdata.dev/task/v1/todo',
  done: 'https://atomicdata.dev/task/v1/done',
} as const;
export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  checked: boolean;
  is_deleted?: boolean;
  due?: { date: string; [field: string]: unknown } | null;
  [field: string]: unknown;
}
export interface IssueView {
  name: string;
  body: string;
  status: 'todo' | 'done';
  dueDay: string | null;
}

function dueDay(task: TodoistTask): string | null {
  if (task.due === null || task.due === undefined) return null;
  const date = task.due.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/u.test(date))
    throw new Error('Expected a Todoist due date or ISO datetime');
  const day = date.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== day ||
    day.startsWith('0000')
  )
    throw new Error('Invalid Todoist civil day');

  return day;
}

function validateSource(task: TodoistTask): void {
  if (
    typeof task.id !== 'string' ||
    !task.id ||
    typeof task.checked !== 'boolean'
  )
    throw new Error('Expected a Todoist string ID and boolean checked field');
  if (task.is_deleted !== undefined && typeof task.is_deleted !== 'boolean')
    throw new Error('Expected a boolean is_deleted field');
  if (task.is_deleted)
    throw new Error('Deleted tasks require a deletion event, not a projection');
  if (
    typeof task.content !== 'string' ||
    !task.content.trim() ||
    typeof task.description !== 'string'
  )
    throw new Error('Expected nonempty task content and a string description');
  dueDay(task);
}

const mapping = recordLens<TodoistTask, IssueView>({
  name: fieldLens<TodoistTask, 'content'>('content'),
  body: fieldLens<TodoistTask, 'description'>('description'),
  status: readOnlyLens(['checked'], (task: TodoistTask) =>
    task.checked ? 'done' : 'todo',
  ),
  dueDay: readOnlyLens(['due'], dueDay),
});

export const todoistIssueLens: ValueLens<TodoistTask, IssueView> =
  Object.freeze({
    ...mapping,
    get(task: TodoistTask) {
      validateSource(task);

      return mapping.get(task);
    },
    put(view: IssueView, previous: TodoistTask) {
      validateSource(previous);
      if (
        typeof view.name !== 'string' ||
        !view.name.trim() ||
        typeof view.body !== 'string'
      )
        throw new Error('Expected nonempty issue name and a string body');

      return mapping.put(view, previous);
    },
  });
export function todoistIssueSchema(): AtomicSchema {
  return new AtomicSchema()
    .property(issueTerms.name, Datatype.STRING)
    .property(issueTerms.body, Datatype.MARKDOWN)
    .property(issueTerms.status, Datatype.RESOURCEARRAY)
    .property(issueTerms.due, Datatype.DATE);
}
export function todoistToAtomic(task: TodoistTask): AtomicPatch {
  const view = todoistIssueLens.get(task);

  return {
    set: {
      [IS_A]: [issueTerms.class],
      [issueTerms.name]: view.name,
      [issueTerms.body]: view.body,
      [issueTerms.status]: [issueTerms[view.status]],
      ...(view.dueDay !== null ? { [issueTerms.due]: view.dueDay } : {}),
    },
    unset: view.dueDay === null ? [issueTerms.due] : [],
  };
}
export function todoistFromAtomic(
  resource: AtomicResource,
  previous: TodoistTask,
): TodoistTask {
  const classes = resource[IS_A];
  const status = resource[issueTerms.status];
  if (!Array.isArray(classes) || !classes.includes(issueTerms.class))
    throw new Error('Expected an Atomic issue-v1');
  if (
    !Array.isArray(status) ||
    status.length !== 1 ||
    ![issueTerms.todo, issueTerms.done].includes(
      status[0] as typeof issueTerms.todo,
    )
  )
    throw new Error('Expected exactly one Todo or Done status');

  return todoistIssueLens.put(
    {
      name: resource[issueTerms.name] as string,
      body: (resource[issueTerms.body] ?? '') as string,
      status: status[0] === issueTerms.done ? 'done' : 'todo',
      dueDay: (resource[issueTerms.due] ?? null) as string | null,
    },
    previous,
  );
}
/** POST /api/v1/tasks/{id}; no checked, due, assignee or label writes. */
export function todoistUpdatePlan(
  resource: AtomicResource,
  previous: TodoistTask,
) {
  const next = todoistFromAtomic(resource, previous);
  const body: { content?: string; description?: string } = {};
  if (next.content !== previous.content) body.content = next.content;
  if (next.description !== previous.description)
    body.description = next.description;

  return { id: previous.id, body };
}
