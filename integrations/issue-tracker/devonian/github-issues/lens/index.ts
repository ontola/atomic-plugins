// @wc-ignore-file
/**
 * Passive GitHub issue mapping. No store, transport or synchronization state.
 *
 * GitHub has only open and closed. The two workflow labels carry the rest
 * (ontola/atomic-plugins#177, Q8): `atomic:doing` is Doing and
 * `atomic:blocked` is Blocked. Closed is Done whatever the labels say; an
 * open issue with both labels is Blocked.
 */
export type Status = 'Todo' | 'Doing' | 'Blocked' | 'Done';
export const STATUSES: readonly Status[] = ['Todo', 'Doing', 'Blocked', 'Done'];
/** The workflow labels, lower case, by the status they stand for. */
export const STATUS_LABELS = {
  Doing: 'atomic:doing',
  Blocked: 'atomic:blocked',
} as const;
const WORKFLOW_LABELS: string[] = Object.values(STATUS_LABELS);
const labelName = (label: string | { name: string }) =>
  (typeof label === 'string' ? label : label.name).toLowerCase();

export type Projection = {
  title: string;
  body: string;
  status: Status;
};
export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<string | { name: string }>;
  pull_request?: unknown;
}
export function project(issue: Issue): Projection {
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0 ||
    typeof issue.title !== 'string' ||
    !(issue.body === null || typeof issue.body === 'string') ||
    !['open', 'closed'].includes(issue.state) ||
    !Array.isArray(issue.labels)
  )
    throw new Error('GitHub returned an invalid issue');

  const names = issue.labels.map(labelName);

  return {
    title: issue.title,
    body: issue.body ?? '',
    status:
      issue.state === 'closed'
        ? 'Done'
        : names.includes(STATUS_LABELS.Blocked)
          ? 'Blocked'
          : names.includes(STATUS_LABELS.Doing)
            ? 'Doing'
            : 'Todo',
  };
}
export function validate(value: Projection): void {
  if (
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    typeof value.body !== 'string' ||
    !STATUSES.includes(value.status)
  )
    throw new Error(
      'Cards require a title, Markdown body and exactly one Todo/Doing/Blocked/Done status',
    );
}

/** Fields owned by the lens; labels are managed separately without replacing other labels. */
export function issueFields(value: Projection): {
  title: string;
  body: string;
  state: 'open' | 'closed';
} {
  return {
    title: value.title,
    body: value.body,
    state: value.status === 'Done' ? 'closed' : 'open',
  };
}

/**
 * Reverse mapping preserves every field and label outside the projection.
 * Each status leaves exactly its own workflow label, if it has one.
 */
export function unproject<T extends Issue>(value: Projection, previous: T): T {
  validate(value);
  const labels = previous.labels.filter(
    label => !WORKFLOW_LABELS.includes(labelName(label)),
  );
  if (value.status === 'Doing' || value.status === 'Blocked')
    labels.push(STATUS_LABELS[value.status]);

  return { ...previous, ...issueFields(value), labels };
}

/** Minimal reverse patch used by the existing reviewed synchronization workflow. */
export function issuePatch(
  desired: Projection,
  previous?: Projection,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (previous && previous.title !== desired.title) patch.title = desired.title;
  if (previous && previous.body !== desired.body) patch.body = desired.body;
  if (
    (!previous && desired.status === 'Done') ||
    (previous && (previous.status === 'Done') !== (desired.status === 'Done'))
  )
    patch.state = desired.status === 'Done' ? 'closed' : 'open';

  return patch;
}

export interface LabelChip {
  name: string;
  /** `#rrggbb`, only when GitHub sent a well-formed hex colour. */
  color?: string;
}

/** Read-only issue fields for display; never part of a patch or `unproject`. */
export interface IssueExtras {
  labels: LabelChip[];
  assignees: string[];
  /** GitHub's own count; absent when the payload has none. */
  commentCount?: number;
}

/**
 * Labels (without the `atomic:doing` and `atomic:blocked` workflow labels,
 * which are the Doing and Blocked statuses), assignee logins and GitHub's comment count. Only ever written to
 * the Atomic side as provenance metadata: `issueFields`/`issuePatch` above
 * do not read these, so they cannot reach GitHub.
 */
export function issueExtras(
  issue: Pick<Issue, 'labels'> & {
    assignees?: unknown;
    comments?: unknown;
  },
): IssueExtras {
  const labels: LabelChip[] = [];

  for (const label of issue.labels) {
    const name = typeof label === 'string' ? label : label?.name;
    if (
      typeof name !== 'string' ||
      WORKFLOW_LABELS.includes(name.toLowerCase())
    )
      continue;
    const raw =
      typeof label === 'object' ? (label as { color?: unknown }).color : '';
    const color = typeof raw === 'string' ? raw : '';
    labels.push(
      /^[0-9a-f]{6}$/i.test(color)
        ? { name, color: `#${color.toLowerCase()}` }
        : { name },
    );
  }

  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees
        .map(a => (a as { login?: unknown })?.login)
        .filter((login): login is string => typeof login === 'string')
    : [];

  return {
    labels,
    assignees,
    ...(Number.isSafeInteger(issue.comments) && (issue.comments as number) >= 0
      ? { commentCount: issue.comments as number }
      : {}),
  };
}
