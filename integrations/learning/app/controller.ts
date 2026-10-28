// @wc-ignore-file
/**
 * Loads the tree, the learner's mastery and the lessons through the adapter,
 * keeps the view state (selection, goal) and runs the three actions. All the
 * learning logic is the core's; nothing here decides what is open.
 */
import {
  buildGraph,
  masteredSet,
  type Mastery,
  type SkillGraph,
} from '../core/index.js';
import { starter } from './starter.js';
import {
  adopt,
  atomic,
  isResourceRef,
  loadStarter,
  linkLesson,
  masteryStore,
  readLessons,
  skillSource,
  type Lesson,
  type Tables,
} from './adapter.js';
import type { MiniApp } from './miniapps.js';
import type { Strings } from './strings.js';
import type { PluginStore } from './store.js';

export type State =
  | { kind: 'loading' }
  | { kind: 'unusable' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      tables: Tables;
      graph: SkillGraph;
      mastery: Mastery;
      mastered: ReadonlySet<string>;
      lessons: Lesson[];
      /** Everything directly under this app, mini apps included: Start opens these as resources. */
      children: ReadonlySet<string>;
      selected?: string;
      goal?: string;
      /** What the app is doing, or what just happened, for a status line. */
      busy?: 'starter' | 'mastery';
      notice?:
        | 'denied'
        | 'failed'
        | 'badLink'
        | { loaded: number; apps: number };
      /** The "Maak met AI" request being shown for an interactive lesson. */
      ai?: { lesson: string; prompt: string; copied: boolean };
    };

export function createController(
  store: PluginStore,
  onState: (state: State) => void,
  /** The mini apps "Load starter tree" creates in the drive, by starter key. */
  miniApps: Record<string, MiniApp> = {},
) {
  let state: State = { kind: 'loading' };
  let tables: Tables | undefined;
  let masteryTable: ReturnType<typeof masteryStore> | undefined;

  const set = (next: State) => {
    state = next;
    onState(state);
  };

  const ready = () => (state.kind === 'ready' ? state : undefined);

  /** Reads the three tables; keeps selection, goal and notice across reloads. */
  async function load(): Promise<void> {
    try {
      tables ??= await adopt(store, await store.getData());
      if (!tables.usable) return set({ kind: 'unusable' });
      masteryTable ??= masteryStore(store, tables.mastery);
      const [skills, mastery, lessons, children] = await Promise.all([
        skillSource(store, tables.skills).readSkills(),
        masteryTable.readMastery(),
        readLessons(store, tables.lessons),
        store
          .getApp()
          .then(app => store.query({ property: atomic.parent, value: app })),
      ]);
      const graph = buildGraph(skills);
      const before = ready();
      set({
        kind: 'ready',
        tables,
        graph,
        mastery,
        mastered: masteredSet(graph, mastery),
        lessons,
        children: new Set(children),
        ...(before?.selected && graph.resolve(before.selected)
          ? { selected: graph.resolve(before.selected)! }
          : {}),
        ...(before?.goal && graph.resolve(before.goal)
          ? { goal: graph.resolve(before.goal)! }
          : {}),
        ...(before?.notice ? { notice: before.notice } : {}),
        ...(before?.ai ? { ai: before.ai } : {}),
      });
    } catch (error) {
      set({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const patch = (changes: Partial<Extract<State, { kind: 'ready' }>>) => {
    const s = ready();
    if (s) set({ ...s, ...changes });
  };

  return {
    state: () => state,
    load,
    select: (id: string | undefined) => patch({ selected: id }),
    setGoal: (id: string | undefined) => patch({ goal: id }),

    /** "Ik beheers dit" and its undo: one mastery row per skill, level 1 or 0. */
    async toggleMastery(id: string): Promise<void> {
      const s = ready();
      if (!s || !masteryTable) return;
      const level = s.mastered.has(id) ? 0 : 1;
      const mastery = new Map(s.mastery).set(id, level);
      set({
        ...s,
        mastery,
        mastered: masteredSet(s.graph, mastery),
        busy: 'mastery',
      });

      try {
        await masteryTable.set(id, level);
        patch({ busy: undefined });
      } catch {
        await load();
        patch({ notice: 'failed' });
      }
    },

    /** Links an interactive lesson to a resource (did: or atomic:) or an https URL. */
    async linkLesson(lesson: string, target: string): Promise<void> {
      const to = target.trim();

      if (!isResourceRef(to) && !/^https?:\/\/\S+$/.test(to))
        return patch({ notice: 'badLink' });

      try {
        await linkLesson(store, lesson, to);
        await load();
        patch({ notice: undefined });
      } catch {
        await load();
        patch({ notice: 'failed' });
      }
    },

    /**
     * The request to hand the assistant for an interactive lesson with no app:
     * what the lesson teaches, for whom, and which lesson to link the result
     * to. The host gives a drive app no way to open the assistant with it, so
     * the person pastes it (see `show`).
     */
    promptFor(lesson: string, ui: Strings): string | undefined {
      const s = ready();
      const row = s?.lessons.find(l => l.subject === lesson);
      const skill = s?.graph.nodes.get(
        s.graph.resolve(row?.teaches[0] ?? '') ?? '',
      );

      return row && skill
        ? ui.aiPrompt(
            skill.name,
            ui.aiAudience(skill.level),
            row.name,
            row.subject,
          )
        : undefined;
    },

    /** Shows a request under its lesson, or hides it. */
    showPrompt: (
      ai: { lesson: string; prompt: string; copied: boolean } | undefined,
    ) => patch({ ai }),

    async loadStarter(): Promise<void> {
      const s = ready();
      if (!s) return;
      set({ ...s, busy: 'starter', notice: undefined });

      try {
        const result = await loadStarter(store, s.tables, starter, miniApps);
        await load();
        patch({
          busy: undefined,
          notice:
            result.status === 'denied'
              ? 'denied'
              : { loaded: result.skills, apps: result.apps },
        });
      } catch {
        await load();
        patch({ busy: undefined, notice: 'failed' });
      }
    },
  };
}
