/**
 * The `ci` job in .github/workflows/ci.yml is the single context the branch
 * ruleset requires, and it can only speak for jobs it lists in `needs`. A job
 * added later and not wired in would fail while `CI` still reported success —
 * a green gate over a red run. This asserts it stays exhaustive, apart from
 * the jobs listed in NON_BLOCKING, each with its reason.
 *
 * Parsed with regexes rather than a YAML library: this repo's tooling tests
 * run on plain `node --test` with no dependencies of their own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './lanes.mjs';

const workflow = readFileSync(
  resolve(root, '.github/workflows/ci.yml'),
  'utf8',
).split('\n');

/** Top-level job keys: exactly two spaces of indent inside `jobs:`. */
function jobNames(lines) {
  const start = lines.findIndex(l => l === 'jobs:');
  assert.notEqual(start, -1, 'ci.yml has no jobs: block');
  const names = [];

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) names.push(m[1]);
  }

  return names;
}

/** The `needs:` list of one job, as written in block-sequence form. */
function needsOf(lines, job) {
  const start = lines.findIndex(l => l === `  ${job}:`);
  assert.notEqual(start, -1, `ci.yml has no ${job} job`);
  const needs = [];
  let inNeeds = false;

  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;

    if (/^ {4}needs:\s*$/.test(line)) {
      inNeeds = true;
      continue;
    }

    if (inNeeds) {
      const m = /^ {6}- ([a-z][a-z0-9-]*)\s*$/.exec(line);

      if (m) {
        needs.push(m[1]);
        continue;
      }

      break;
    }
  }

  return needs;
}

/**
 * Jobs the gate deliberately does not wait for, each with the reason a failure
 * in it cannot make a green gate wrong. Keep this list short and explicit.
 */
const NON_BLOCKING = {
  // Only warms the per-pin image cache. build-server falls back to a source
  // build when the image is missing, so a failed publish costs time on later
  // runs, never correctness; waiting for it would hold the gate ~15 minutes.
  'publish-image': 'build-server falls back to a source build',
};

test('the ci gate depends on every other job', () => {
  const jobs = jobNames(workflow);
  assert.ok(jobs.includes('ci'), 'no ci job found');
  const needs = needsOf(workflow, 'ci');
  const uncovered = jobs.filter(
    j => j !== 'ci' && !needs.includes(j) && !(j in NON_BLOCKING),
  );
  assert.deepEqual(
    uncovered,
    [],
    "add these to the ci job's needs, or a failure in them reports green",
  );
});

test('each non-blocking exception is a real job the gate does not wait for', () => {
  const jobs = jobNames(workflow);
  const needs = needsOf(workflow, 'ci');

  for (const job of Object.keys(NON_BLOCKING)) {
    assert.ok(jobs.includes(job), `NON_BLOCKING names "${job}", not a job`);
    assert.ok(
      !needs.includes(job),
      `"${job}" is in ci's needs; drop it from NON_BLOCKING or from needs`,
    );
  }
});

test('every job the ci gate names exists', () => {
  const jobs = new Set(jobNames(workflow));
  for (const need of needsOf(workflow, 'ci'))
    assert.ok(jobs.has(need), `ci needs "${need}", which is not a job`);
});

test('the ci gate always reports, even when jobs are skipped', () => {
  const start = workflow.findIndex(l => l === '  ci:');
  const body = workflow.slice(start, start + 12).join('\n');
  assert.match(
    body,
    /if: always\(\)/,
    'without if: always() the gate is skipped when a dependency fails, and a required skipped check never reports',
  );
});

// --- The published atomic-server e2e image (atomic-server-e2e-image.yml) ---

const IMAGE = 'ghcr.io/ontola/atomic-server-e2e';
const imageWorkflow = readFileSync(
  resolve(root, '.github/workflows/atomic-server-e2e-image.yml'),
  'utf8',
);
const dockerfile = readFileSync(
  resolve(root, 'integrations/tooling/atomic-server-e2e/Dockerfile'),
  'utf8',
);

/** One job's lines, from its `  name:` key to the next top-level job. */
function jobBlock(lines, job) {
  const start = lines.findIndex(l => l === `  ${job}:`);
  assert.notEqual(start, -1, `no ${job} job`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));

  return lines.slice(start, end === -1 ? undefined : end);
}

/** A job's steps, each as its own text, split on `      - ` items. */
function stepsOf(lines, job) {
  const steps = [];

  for (const line of jobBlock(lines, job)) {
    if (/^ {6}- /.test(line)) steps.push([]);
    else if (/^ {6}#/.test(line)) continue;
    if (steps.length) steps.at(-1).push(line);
  }

  return steps.map(s => s.join('\n'));
}

/**
 * The words of the first non-comment line containing `start`, from `start`
 * on, up to a line continuation or `&&`.
 */
function command(text, start) {
  const line = text
    .split('\n')
    .find(l => !/^\s*#/.test(l) && l.includes(start));
  assert.ok(line, `no "${start}" command`);
  const words = line.slice(line.indexOf(start)).split(/\s+/).filter(Boolean);
  const end = words.findIndex(w => w === '\\' || w === '&&');

  return end === -1 ? words : words.slice(0, end);
}

test('build-server tries the image for the pin before building from source', () => {
  const steps = stepsOf(workflow, 'build-server');
  const image = steps.findIndex(s => /id: image\b/.test(s));
  assert.notEqual(image, -1, 'no step with id: image');
  assert.match(
    steps[image],
    new RegExp(`${IMAGE}:\\$\\{\\{ steps\\.pin\\.outputs\\.sha \\}\\}`),
  );
  const build = steps.findIndex(s => s.includes('cargo build --profile e2e'));
  assert.ok(build > image, 'the image has to be tried before the cargo build');

  for (const step of steps.slice(image + 1)) {
    if (step.includes('actions/upload-artifact')) continue;
    assert.match(
      step,
      /if: steps\.image\.outputs\.hit != 'true'/,
      `a source-build step runs even when the image was used:\n${step}`,
    );
  }
});

test("build-server's artifact is the same whether it pulled or built", () => {
  const upload = stepsOf(workflow, 'build-server').find(s =>
    s.includes('actions/upload-artifact'),
  );
  assert.match(upload, /name: atomic-server-binary\n/);
  assert.match(upload, /path: atomic-server\/target\/e2e\/atomic-server\n/);
  assert.doesNotMatch(upload, /if:/, 'the upload must run on both paths');
  const image = stepsOf(workflow, 'build-server').find(s =>
    /id: image\b/.test(s),
  );
  assert.match(image, /atomic-server\/target\/e2e\/atomic-server/);
});

/** The Dockerfile's cargo command with CARGO_FEATURES set to `features`. */
const dockerCargo = features =>
  command(dockerfile, 'cargo build --profile e2e').map(w =>
    w === '"${CARGO_FEATURES}"' ? features : w,
  );

test('the Dockerfile builds exactly what build-server builds', () => {
  const ci = workflow.join('\n');
  assert.match(dockerfile, /\nARG CARGO_FEATURES=wasm-plugins\n/);
  assert.deepEqual(
    dockerCargo('wasm-plugins'),
    command(ci, 'cargo build --profile e2e'),
  );
  assert.deepEqual(
    command(dockerfile, 'wasm-pack build').slice(1),
    command(ci, '"$HOME/.local/bin/wasm-pack" build').slice(1),
  );

  for (const env of ['SKIP_WASM_BUILD=1', 'VITE_E2E=true'])
    assert.ok(dockerfile.includes(env), `Dockerfile does not set ${env}`);
  assert.ok(
    dockerfile.includes('rustup target add wasm32-wasip2'),
    'without wasm32-wasip2 build.rs silently drops the plugin runtime',
  );
});

test('the image workflow publishes per pin, on main and on demand', () => {
  assert.match(
    imageWorkflow,
    /\n {2}push:\n {4}branches: \[main\]\n {4}paths:\n(?: {6}- .*\n)*? {6}- \.atomic-server-ref\n/,
  );
  assert.match(
    imageWorkflow,
    /\n {2}workflow_dispatch:\n {4}inputs:\n {6}sha:/,
  );
  assert.match(imageWorkflow, /\n {2}workflow_call:\n {4}inputs:\n {6}sha:/);
  assert.ok(imageWorkflow.includes(`IMAGE: ${IMAGE}\n`));
  assert.match(imageWorkflow, /linux\/amd64/);
  assert.match(imageWorkflow, /latest-pin/);
  // SHA validated before it names anything.
  assert.ok(imageWorkflow.includes("grep -qxE '[0-9a-f]{40}'"));
});

test('only same-repo pin-bump PRs publish an image from CI', () => {
  const job = jobBlock(workflow, 'publish-image').join('\n');
  assert.match(
    job,
    /uses: \.\/\.github\/workflows\/atomic-server-e2e-image\.yml/,
  );
  assert.match(job, /github\.event_name == 'pull_request'/);
  assert.match(job, /needs\.changes\.outputs\.pin-changed == 'true'/);
  assert.match(
    job,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(job, /packages: write/);
});

test('every tooling test file runs in CI', () => {
  const listed = new Set(
    [
      ...workflow
        .join('\n')
        .matchAll(/integrations\/tooling\/([\w.-]+\.test\.mjs)/g),
    ].map(m => m[1]),
  );
  const onDisk = readdirSync(resolve(root, 'integrations/tooling')).filter(f =>
    f.endsWith('.test.mjs'),
  );
  assert.deepEqual(
    onDisk.filter(f => !listed.has(f)),
    [],
    "add these to ci.yml's Tooling unit tests step",
  );
});

test('the plugin-routes image variant is the Dockerfile with the feature, and CI pulls it before building', () => {
  // The workflow builds :<sha>-plugin-routes with that build argument.
  assert.match(imageWorkflow, /CARGO_FEATURES=\$\{\{ matrix\.features \}\}/);
  assert.ok(imageWorkflow.includes('"wasm-plugins,plugin-routes"'));
  assert.ok(imageWorkflow.includes('"-" + .'), 'the variant tag suffix');
  // Only :<sha> (the default variant) moves :latest-pin.
  assert.match(imageWorkflow, /matrix\.variant == 'default'/);
  assert.match(dockerfile, /dev\.atomicdata\.atomic-server\.features=/);

  const steps = stepsOf(workflow, 'build-server-plugin-routes');
  const image = steps.findIndex(s => /id: image\b/.test(s));
  assert.notEqual(image, -1, 'no step with id: image');
  assert.match(
    steps[image],
    new RegExp(
      `${IMAGE}:\\$\\{\\{ steps\\.pin\\.outputs\\.sha \\}\\}-plugin-routes`,
    ),
  );
  assert.match(steps[image], /dev\.atomicdata\.atomic-server\.features/);
  const build = steps.findIndex(s => s.includes('cargo build --profile e2e'));
  assert.ok(build > image, 'the image has to be tried before the cargo build');
  assert.deepEqual(
    command(steps[build], 'cargo build --profile e2e'),
    dockerCargo('wasm-plugins,plugin-routes'),
  );

  for (const step of steps.slice(image + 1)) {
    if (step.includes('actions/upload-artifact')) continue;
    assert.match(
      step,
      /if: steps\.image\.outputs\.hit != 'true'/,
      `a source-build step runs even when the image was used:\n${step}`,
    );
  }
});

test('the plugin-routes build runs only for lanes that need it, and those lanes get it', () => {
  const build = jobBlock(workflow, 'build-server-plugin-routes').join('\n');
  assert.match(build, /if: needs\.changes\.outputs\.plugin-routes == 'true'/);
  assert.match(
    build,
    /--no-default-features --features wasm-plugins,plugin-routes/,
  );
  assert.match(build, /name: atomic-server-binary-plugin-routes\n/);

  const changes = jobBlock(workflow, 'changes').join('\n');
  assert.match(changes, /lanes\.mjs plugin-routes "\$CHANGED"/);

  // A skipped plugin-routes build must not skip every lane.
  const lane = jobBlock(workflow, 'lane').join('\n');
  assert.match(
    lane,
    /needs: \[changes, build-server, build-server-plugin-routes, build-sidecars\]/,
  );
  assert.match(lane, /!cancelled\(\)/);
  assert.match(lane, /needs\.build-server-plugin-routes\.result != 'failure'/);
  const download = stepsOf(workflow, 'lane').find(s =>
    s.includes('name: atomic-server-binary-plugin-routes'),
  );
  assert.match(download, /if: matrix\.plugin-routes == 'true'/);
  assert.match(lane, /ATOMIC_SERVER_ROUTES_BINARY: /);
});

test('sidecar images are built outside the lane, only for lanes that start one, and reach their spec', () => {
  const changes = jobBlock(workflow, 'changes').join('\n');
  assert.match(changes, /lanes\.mjs sidecars "\$CHANGED"/);
  assert.match(
    changes,
    /sidecars: \$\{\{ steps\.decide\.outputs\.sidecars \}\}/,
  );

  const build = jobBlock(workflow, 'build-sidecars').join('\n');
  assert.match(build, /if: needs\.changes\.outputs\.sidecars != '\[\]'/);
  assert.match(build, /timeout-minutes: \d+/);
  // Named by the content of its source, pulled (and label-checked) first.
  assert.match(build, /git ls-files -s "\$dir" \| sha256sum/);
  const steps = stepsOf(workflow, 'build-sidecars');
  const pull = steps.findIndex(s => s.includes('docker pull'));
  const buildStep = steps.findIndex(s =>
    s.includes('docker/build-push-action'),
  );
  assert.ok(pull !== -1 && buildStep > pull, 'pull before building');
  assert.match(steps[pull], /dev\.atomicdata\.sidecar\.source/);
  assert.match(steps[buildStep], /if: steps\.image\.outputs\.hit != 'true'/);
  assert.match(steps[buildStep], /cache-to: type=gha,.*mode=min/);
  // Fork PRs never publish.
  const publish = steps.find(s => s.includes('docker push'));
  assert.match(
    publish,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(publish, /continue-on-error: true/);
  assert.match(build, /name: sidecar-image-\$\{\{ matrix\.sidecar \}\}/);

  // The lane loads them and names each image to its spec.
  const load = stepsOf(workflow, 'lane').find(s =>
    s.includes('name: Load the sidecar images'),
  );
  assert.match(load, /if: matrix\.sidecars != ''/);
  assert.match(load, /_SIDECAR_IMAGE/);
  assert.match(load, /GITHUB_ENV/);
  const download = stepsOf(workflow, 'lane').find(s =>
    s.includes('pattern: sidecar-image-*'),
  );
  assert.match(download, /if: matrix\.sidecars != ''/);
});

// #43 §2: dorny/paths-filter has no pull_request diff to read on a
// merge_group or workflow_dispatch run. A filter that runs there anyway can
// come back empty, skip every job and leave the run green having tested
// nothing, so every workflow that path-gates runs the filter on pull_request
// only and forces its outputs on for every other event.
test('path filters run on pull_request only; other events run everything', () => {
  const dir = resolve(root, '.github/workflows');
  const gated = readdirSync(dir)
    .filter(f => f.endsWith('.yml'))
    .map(f => [f, readFileSync(resolve(dir, f), 'utf8')])
    .filter(([, text]) => text.includes('dorny/paths-filter'));
  assert.ok(gated.length > 0);

  for (const [file, text] of gated) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('uses: dorny/paths-filter')) return;
      // The step's `if:` sits between its `- name:` and its `uses:`.
      let start = i;
      while (!/^\s*- /.test(lines[start])) start--;
      const step = lines.slice(start, i).join('\n');
      assert.match(
        step,
        /if: github\.event_name == 'pull_request'/,
        `${file}:${i + 1}: run paths-filter on pull_request only`,
      );
    });

    // Each output read from a filter falls back to on outside pull_request.
    for (const m of text.matchAll(
      /^ {6}([\w-]+): \$\{\{ (.*steps\.filter\.outputs\..*) \}\}$/gm,
    ))
      assert.match(
        m[2],
        /^github\.event_name != 'pull_request' && '[^']+' \|\| steps\.filter\.outputs\.[\w-]+$/,
        `${file}: output ${m[1]} must be forced on outside pull_request`,
      );
  }
});
