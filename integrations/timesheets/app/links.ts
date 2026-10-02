// @wc-ignore-file
/**
 * The project and person rows that time entries link to (#177 Q11: linked
 * records). A time entry row's `work-project` and `work-person` (shared
 * `time-entry-v1` fields) point at rows of the app's own Projects and
 * People tables, of the shared classes `work-project-v1` and
 * `work-person-v1`, which carry only a `name`. Which Clockify project or
 * user a row stands for is a provider extra on it, a Property of the app's
 * own ontology (`clockify-project-id`, `clockify-user-id`).
 *
 * - A sync makes a row per Clockify project it reads (archived ones only
 *   when an entry uses them) and per user an entry names, and sets their
 *   names to Clockify's: a name changed in the table is set back.
 * - A link to a project row without a Clockify id (one a person added, here
 *   or in a table of their own) stands for "the project with this name": a
 *   change to it is resolved by that name when it is listed to send, as a
 *   name typed into the table was up to 0.4.0.
 *
 * One instance per operation (`ensureSchema` makes it): what it read is
 * cached for that operation only, so a rename elsewhere is seen next time.
 */
import { WORK_PERSON, WORK_PROJECT } from './fields.js';
import { atomic, NAME } from './ontology.js';
import type { JSONValue, PluginStore } from './store.js';

export type LinkKind = 'project' | 'person';

/** What a link points at. `id: null`: not a Clockify project or user. */
export interface LinkTarget {
  id: string | null;
  name: string | null;
}

const text = (value: JSONValue) =>
  typeof value === 'string' && value ? value : null;

/** The name a project or person row gets when Clockify gave none. */
export const fallbackName = (kind: LinkKind, id: string) =>
  `Clockify ${kind === 'project' ? 'project' : 'user'} ${id}`;

export class Links {
  private readonly described = new Map<string, LinkTarget>();
  private readonly byId = {
    project: new Map<string, string>(),
    person: new Map<string, string>(),
  };

  constructor(
    private readonly store: PluginStore,
    readonly tables: { projects: string; people: string },
    private readonly props: { projectId: string; memberId: string },
  ) {}

  private idProperty(kind: LinkKind) {
    return kind === 'project' ? this.props.projectId : this.props.memberId;
  }

  private table(kind: LinkKind) {
    return kind === 'project' ? this.tables.projects : this.tables.people;
  }

  /**
   * The Clockify id and name of the row `subject` links to. A row that
   * cannot be read counts as a project or person named by its subject,
   * with no Clockify id, so a change to it is refused rather than read as
   * "no project".
   */
  async describe(kind: LinkKind, subject: string): Promise<LinkTarget> {
    const known = this.described.get(subject);
    if (known) return known;
    let target: LinkTarget;

    try {
      const resource = await this.store.getResource(subject);
      target = {
        id: text(resource.get(this.idProperty(kind))),
        name: text(resource.get(NAME)),
      };
    } catch {
      target = { id: null, name: subject };
    }

    this.described.set(subject, target);
    if (target.id && !this.byId[kind].has(target.id))
      this.byId[kind].set(target.id, subject);

    return target;
  }

  /** The name of the row standing for Clockify `id`, if this operation saw it. */
  nameOf(kind: LinkKind, id: string): string | undefined {
    const subject = this.byId[kind].get(id);

    return (subject && this.described.get(subject)?.name) || undefined;
  }

  /**
   * The row standing for Clockify project or user `id` in the app's own
   * table, made when missing (named `name`, or a placeholder when Clockify
   * gave none). With `rename`, an existing row's name is set to `name`.
   */
  async ensure(
    kind: LinkKind,
    id: string,
    name: string | null,
    options: { rename?: boolean } = {},
  ): Promise<string> {
    let subject = this.byId[kind].get(id);

    if (!subject) {
      const table = this.table(kind);

      for (const candidate of await this.store.query({
        property: this.idProperty(kind),
        value: id,
      })) {
        const resource = await this.store
          .getResource(candidate)
          .catch(() => undefined);

        if (resource?.get(atomic.parent) === table) {
          subject = candidate;
          this.described.set(candidate, {
            id,
            name: text(resource.get(NAME)),
          });
          break;
        }
      }
    }

    if (!subject) {
      const created = await this.store.newResource({
        parent: this.table(kind),
        isA: [kind === 'project' ? WORK_PROJECT : WORK_PERSON],
        propVals: {
          [NAME]: name ?? fallbackName(kind, id),
          [this.idProperty(kind)]: id,
        },
      });
      subject = created.subject;
      this.described.set(subject, { id, name: name ?? fallbackName(kind, id) });
    } else if (
      options.rename &&
      name &&
      this.described.get(subject)?.name !== name
    ) {
      const resource = await this.store.getResource(subject);
      await resource.set(NAME, name).save();
      this.described.set(subject, { id, name });
    }

    this.byId[kind].set(id, subject);

    return subject;
  }

  /**
   * A project row without a Clockify id named `name` in the app's Projects
   * table, made when missing: what a link to "the project with this name"
   * points at.
   */
  async named(name: string): Promise<string> {
    const table = this.tables.projects;

    for (const candidate of await this.store.query({
      property: NAME,
      value: name,
    })) {
      const resource = await this.store
        .getResource(candidate)
        .catch(() => undefined);

      if (
        resource?.get(atomic.parent) === table &&
        !text(resource.get(this.props.projectId))
      ) {
        this.described.set(candidate, { id: null, name });

        return candidate;
      }
    }

    const created = await this.store.newResource({
      parent: table,
      isA: [WORK_PROJECT],
      propVals: { [NAME]: name },
    });
    this.described.set(created.subject, { id: null, name });

    return created.subject;
  }
}
