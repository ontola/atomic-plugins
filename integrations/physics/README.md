# Physics mini apps (Lenzen, Magneten, Trillingen)

Three small interactive physics drive apps for lessons, secondary school to
university. Plain DOM and SVG, no framework, no network, no storage, no external
assets. They use no ontology-kit terms, so they are not under the ontology gate:
their catalog entries are `enabled: true, experimental: true` (offered under
"Show experimental plugins").

| Catalog id       | Folder    | App                                                                    |
| ---------------- | --------- | ---------------------------------------------------------------------- |
| `physics-lens`   | `lens/`   | Thin lens: drag object and focal points, three principal rays, image   |
| `physics-magnet` | `magnet/` | One or two bar magnets: field lines, compass, filings, strength, force |
| `physics-spring` | `spring/` | Damped mass on a spring: animation, live u(t), T = 2 pi sqrt(m/C)      |

```
core/    pure, tested physics with no DOM: optics.ts, magnet.ts, oscillator.ts
shared/  host mount (theme, styles), DOM helpers, drag/keys, frame loop, build
lens/ magnet/ spring/   strings.ts (nl and en), view.ts, main.ts, styles.css, build.mjs
e2e/     physics.spec.ts: installs each from the catalog and drives it
```

`apps.mjs` `APP_FOLDERS` maps each catalog shortname to its folder; the
committed modules are `apps/physics-*/0.1.0/ui.js`.

## Host integration

Each module exports `view({ root, store })` and reads only `store.getTheme()` /
`onThemeChange()` for the colour scheme; background and text come from the
host's `--t-color-*` variables, the diagram colours are the app's own per
scheme. The UI is Dutch when the browser language starts with `nl`, else English.

## Physics and its simplifications

- Lens: ideal thin lens, 1/f = 1/v + 1/b, real-is-positive b, f < 0 for concave.
  N is shown as |b|/v; the signed magnification -b/v gives upright or inverted.
- Magnets: each bar is a pair of point poles (inverse square, softened) a little
  inside the ends, in the plane of the axes; field lines are RK4 with equal-flux
  seeding from the north poles. Far away it matches a point dipole (tested). The
  field inside the bar is not drawn. Force between magnets sums the pole pairs.
- Spring: m u'' + c u' + C u = 0 with RK4 in fixed 1/240 s steps (tested against
  the closed form for all damping regimes). The measured period is the time
  between upward zero crossings, so with damping it is the damped period.

Animation: a frame loop that asks for `requestAnimationFrame` only while the
document is visible, the app is in view, and something moves.

Tests: `node integrations/tooling/run-lane.mjs physics --tier typecheck|unit|e2e`.
