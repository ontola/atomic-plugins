# Value lenses (unreleased)

`devonian/lenses` is a synchronous, browser-safe lens algebra, also exported
from `devonian`. It has no runtime dependencies. This entry point is new source
for the next release; npm `devonian` 0.8.0 does not contain it.

A lens reads a view from a source and puts an edited view back into the
previous source. It preserves fields outside its declared ownership. The
previous source supplies information that the view cannot express. Callbacks
receive detached copies, and returned sources and views are detached copies.
Use structured-cloneable, JSON-like plain objects, arrays and primitive values;
functions and class instances are outside this initial API's domain.

## Small mappings and composition

```ts
import { customLens, fieldLens, recordLens } from 'devonian/lenses';

interface Source {
  title: string;
  body: string | null;
  labels: string[];
}
interface View { name: string; body: string }

const issue = recordLens<Source, View>({
  name: fieldLens<Source, 'title'>('title'),
  body: customLens<Source, string>({
    reads: ['body'],
    writes: ['body'],
    get: source => source.body ?? '',
    put: body => ({ set: { body } }),
  }),
});

const previous = { title: 'Before', body: null, labels: ['bug'] };
const updated = issue.put({ name: 'After', body: '' }, previous);
// { title: 'After', body: null, labels: ['bug'] }
```

An unchanged view field does not invoke its write callback. This preserves a
null body's original representation during a title edit, even though the view
shows it as an empty string. This also preserves absent properties and provider
formatting. It means putting an unchanged view is not a normalization command.

- `fieldLens<Source, Key>(key)` maps one top-level field directly, with no
  coercion. A value of `undefined` sets a property to undefined; deletion
  instead needs an explicit custom `unset` patch.
- `customLens<Source, View>({ reads, writes, get, put, equal? })` groups fields
  with a shared meaning. Its `put` returns `{ set?, unset? }`. Writes outside
  the declared top-level keys, or setting and removing the same key, throw.
  A nested object is owned as a whole top-level field; merge its unmanaged
  children from `previous` in the callback.
- `readOnlyLens(reads, get)` permits an unchanged view and rejects an edit.
- `recordLens<Source, View>(bindings, validate?)` combines named views. It
  rejects overlapping source ownership and extra/missing view keys. Each
  component computes its patch against the same original source snapshot.
  Group coupled writes into one component. The optional whole-view validator
  runs on edited views before any component write callback.
- `composeLenses(outer, inner)` puts through the inner view and then the outer
  source. It carries the outer lens's conservative source dependency and
  ownership metadata. The caller must ensure the inner edits are within the
  outer lens's supported domain.

`reads` is descriptive dependency metadata, not a sandbox: a callback receives
the complete source. Disjoint ownership alone does not establish lens laws;
components may read fields another component writes. Such dependencies require
compatible views, a whole-view constraint or a composite mapping.

## Supported edits and laws

`checkLensLaws(lens, source, desiredView, sourceEqual?)` evaluates three examples:

- `getPut`: putting the current view preserves the source.
- `putGet`: reading the updated source recovers the desired view.
- `stablePut`: putting the same desired view again preserves the updated source.

The checker propagates exceptions for unsupported edits. A custom view equality
can be supplied to `customLens`; source equality can be supplied to the checker.
The default `lensEqual` compares JSON-like data structurally, ignoring object
key order but distinguishing missing properties from properties set to undefined.
Array order matters. Other value types require explicit equality functions.

These checks establish behavior for the supplied examples, not a formal proof
over all values. They do not test the stronger law that two successive different
puts equal only the last put: changing a Clockify project can discard its old
task, so that stronger law is not promised. They do not establish convergence,
durability or conflict resolution. Metadata and custom callbacks are trusted
application code; invariants on unmanaged fields remain the provider's concern.

## Existing provider prototypes

Provider code stays in its integration folder:

- `integrations/issue-tracker/devonian/github-issues/lens/algebra.ts` exports
  `githubIssueLens`. Title and body are separate fields; status owns GitHub
  `state` and workflow labels together. It supports Todo, Doing, Blocked and
  Done, with existing precedence rules. Unchanged status keeps original label
  spelling, metadata and even redundant workflow labels. A changed status
  replaces workflow labels while retaining unrelated ones. Changed views must
  have a nonempty title, as required by the existing provider validator.
- `integrations/timesheets/devonian/clockify/lens/algebra.ts` exports
  `clockifyEntryLens(context)`. Its edit view has `name`, grouped
  `interval: { start, end }`, `billable` and `projectId`. Project identity owns
  the dependent task: a changed project removes `taskId`. Tags, provider fields
  and unchanged date strings/description formatting stay intact. Display project
  names are not writable fields. Changed times require safe whole-second epoch
  milliseconds, matching the provider serializer's precision; unsupported
  subsecond edits throw rather than silently lose precision. Names must be
  nonempty trimmed text; `Time entry` represents an empty description. The
  prototype reuses existing running/locked/custom-field/project/interval
  restrictions and captures a copy of host-supplied context.

Both prototypes have deterministic law and preservation tests. They are not
imported by current app entry points or exported by the integrations' existing
barrels, so their published app modules remain unchanged. Production adoption
requires a Devonian npm release followed by explicit app dependency/version
updates and rebuilt immutable bundles. The Clockify prototype updates a source
representation; the existing `putBody` function still defines its replacement
HTTP request body. Provider review, conflict checks and transport stay outside
these value lenses. No live-provider or real-browser evidence is claimed here.

Graph extraction and dynamic Notion property schemas are later design exercises;
this first version does not pretend they are independent field mappings.
