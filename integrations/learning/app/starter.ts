// @wc-ignore-file
import tree from '../data/wiskunde-natuurkunde.json' with { type: 'json' };

/** One starter tree: skills by local key, and lessons that point at a key. */
export interface StarterTree {
  name: string;
  language: string;
  skills: {
    key: string;
    name: string;
    description: string;
    requires: string[];
    recommends: string[];
  }[];
  lessons: {
    skill: string;
    name: string;
    /** Key of a mini app (`miniapps.ts`) the lesson is linked to when the tree loads. */
    app?: string;
    format: string;
    minutes: number;
    language: string;
    /** A resource subject or https URL; null while the material is a TODO. */
    content: string | null;
  }[];
}

export const starter: StarterTree = tree;
