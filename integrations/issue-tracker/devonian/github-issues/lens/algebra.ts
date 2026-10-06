// @wc-ignore-file
/** Prototype for the next Devonian release; not imported by published apps. */
import { customLens, fieldLens, recordLens } from 'devonian/lenses';
import {
  project,
  unproject,
  validate,
  type Issue,
  type Projection,
} from './index.js';

/** Composite status owns state and workflow labels together. Unchanged fields
 * retain their original representation, even on a title-only edit. */
export const githubIssueLens = recordLens<Issue, Projection>(
  {
    title: fieldLens<Issue, 'title'>('title'),
    body: customLens({
      reads: ['number', 'title', 'body', 'state', 'labels'],
      writes: ['body'],
      get: (issue: Issue) => project(issue).body,
      put: (body: string) => ({ set: { body } }),
    }),
    status: customLens({
      reads: ['number', 'title', 'body', 'state', 'labels'],
      writes: ['state', 'labels'],
      get: (issue: Issue) => project(issue).status,
      put: (status: Projection['status'], previous: Issue) => {
        const updated = unproject({ ...project(previous), status }, previous);

        return { set: { state: updated.state, labels: updated.labels } };
      },
    }),
  },
  validate,
);
