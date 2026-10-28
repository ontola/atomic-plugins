// @wc-ignore-file
/**
 * The mini apps the starter tree creates in the drive, one per starter lesson
 * that names an `app` key. Their module source is the built physics modules
 * (`../../physics/*`), bundled in as strings by `build.mjs` through the
 * `virtual-physics-modules` import, so loading the tree needs no network and
 * no catalog: the source ends up in the App's entry point (`plugin-source`)
 * where the teacher and Atomic's assistant can read and change it.
 */
import sources from 'virtual-physics-modules';

/** One drive app the app can create: what the sidebar shows, and its code. */
export interface MiniApp {
  name: string;
  emoji: string;
  description: string;
  /** The whole ES module, exporting `view({ root, store })`. */
  source: string;
}

export const MINI_APPS: Record<string, MiniApp> = {
  lens: {
    name: 'Lenzen',
    emoji: '\u{1F50D}',
    description:
      'Interactieve dunne lens: sleep het voorwerp en de brandpunten en zie de drie hoofdstralen en het beeld.',
    source: sources.lens,
  },
  magnet: {
    name: 'Magneten',
    emoji: '\u{1F9F2}',
    description:
      'Interactieve staafmagneten: veldlijnen, kompas en ijzervijlsel, aantrekking en afstoting.',
    source: sources.magnet,
  },
  spring: {
    name: 'Trillingen',
    emoji: '\u{1F300}',
    description:
      'Interactieve massa aan een veer: stel m, C, amplitude en demping in en volg u(t) live.',
    source: sources.spring,
  },
};
