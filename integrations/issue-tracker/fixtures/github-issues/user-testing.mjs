/**
 * Synthetic, for user testing. Every organisation, repository, person, issue
 * and link here is invented; none of it was recorded from GitHub.
 *
 * The `user-testing` scenario of the github-issues fixture (opt in with
 * MOCK_SCENARIO=user-testing on the mock proxy): a small web studio's
 * repositories, rich enough for a moderated think-aloud session with the
 * issue-tracker drive app. The default scenario (`atomic-fixture/tracker`,
 * which CI's e2e asserts) is not affected.
 *
 * Keep titles, bodies and comments to what a real team would write: a
 * tester reads them. Notes on which edge case an issue covers belong in
 * comments here, not in the data.
 */

/** Listed by `GET /user/repos` with `has_issues: false` in this scenario. */
export const USER_TESTING_NO_ISSUES_REPOSITORY = 'acme-studio/old-site';

const LABELS = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  design: 'f9d0c4',
  docs: '0075ca',
  maintenance: 'fbca04',
  'good first issue': '7057ff',
  planning: 'c5def5',
};

const DOING = 'atomic:doing';

/**
 * One issue: `labels` are names from LABELS (plus DOING, kept as a plain
 * string, the way the mock's label routes add it), `age` and `updated` in
 * days before the mock started, `body: null` as GitHub sends an issue that
 * never had one.
 */
const WEBSITE = [
  {
    title: 'Contact form accepts an empty email address',
    body: [
      'Steps to reproduce:',
      '',
      '1. Open /contact',
      '2. Fill in a name and a message, leave the email empty',
      '3. Press **Send**',
      '',
      'The form says "Thanks, we will get back to you!" but we have no way to reply.',
    ].join('\n'),
    labels: ['bug'],
    author: 'tomas-k',
    age: 21,
    updated: 2,
    comments: [
      {
        login: 'priya-dev',
        body: 'Same on Safari 18. Chrome blocks it, so it is probably the `required` attribute missing on one of the two forms.',
        age: 20,
      },
      {
        login: 'tomas-k',
        body: 'There are two forms? I only knew about the one in the footer.',
        age: 19,
      },
      {
        login: 'priya-dev',
        body: 'The footer one and the full page one. They were copied at some point.',
        age: 2,
      },
    ],
  },
  {
    title: 'Add a dark mode toggle to the header',
    body: [
      'Lots of visitors browse in the evening. Plan:',
      '',
      '- [x] Pick the dark palette with design',
      '- [ ] Toggle component in the header',
      '- [ ] Remember the choice between visits',
      '- [ ] Follow the system setting until someone picks',
    ].join('\n'),
    labels: ['enhancement', 'design', DOING],
    author: 'priya-dev',
    assignees: ['priya-dev'],
    age: 30,
    updated: 1,
    comments: [
      {
        login: 'noor-design',
        body: 'Palette is in the Figma file, page "Dark". Contrast checked for body text and buttons.',
        age: 12,
      },
    ],
  },
  {
    title: 'Hero image is blurry on retina screens',
    body: 'The hero on the home page is exported at 1x. We need a 2x version and `srcset`.',
    labels: ['bug', 'design'],
    state: 'closed',
    author: 'noor-design',
    age: 40,
    updated: 25,
  },
  {
    title: 'Write a README section on local development',
    body: [
      'New people ask how to run the site locally. Something like:',
      '',
      '```sh',
      'npm install',
      'cp .env.example .env',
      'npm run dev',
      '```',
      '',
      'Plus a note that the image build needs `vips` installed.',
    ].join('\n'),
    labels: ['docs', 'good first issue'],
    author: 'tomas-k',
    age: 18,
    updated: 18,
  },
  {
    title: 'Update Node to 22 in CI',
    body: 'Node 18 is out of support. Bump `.nvmrc` and the CI image.',
    labels: ['maintenance'],
    state: 'closed',
    author: 'tomas-k',
    age: 35,
    updated: 28,
  },
  {
    // The very long title.
    title:
      'Navigation menu overlaps the page content on small screens when the cookie banner is open and the page is zoomed in to 200 percent, which hides the first heading',
    body: [
      'Seen on a 360 px wide phone with browser zoom at 200%.',
      '',
      'Screenshot: https://files.example.org/acme/nav-overlap.png',
      '',
      'The menu is `position: fixed` and the banner pushes it down.',
    ].join('\n'),
    labels: ['bug', 'design'],
    author: 'jules-w',
    age: 9,
    updated: 9,
  },
  {
    // No body at all.
    title: 'Plan the Q4 content calendar',
    body: null,
    labels: ['planning'],
    author: 'noor-design',
    age: 6,
    updated: 6,
  },
  {
    title: 'Replace the icon font with inline SVG icons',
    body: 'The icon font is 90 KB and flashes squares while it loads. Inline SVG sprites would fix both.',
    labels: ['enhancement', 'maintenance', DOING],
    author: 'tomas-k',
    assignees: ['tomas-k'],
    age: 14,
    updated: 3,
  },
  {
    title: 'Footer links point to the old blog',
    body: 'The "Blog" and "Archive" links in the footer still go to blog.example.org instead of /blog.',
    labels: ['bug', 'good first issue'],
    author: 'jules-w',
    age: 11,
    updated: 4,
    comments: [
      {
        login: 'tomas-k',
        body: 'I changed both links on my branch, just need to merge it.',
        age: 4,
      },
    ],
  },
  {
    title: 'Newsletter sign-up returns a 500 error',
    body: [
      'Signing up from the home page fails. The server log says:',
      '',
      '```',
      'POST /api/newsletter 500',
      'Error: list id missing (NEWSLETTER_LIST_ID)',
      '```',
      '',
      'Probably the variable was not copied when we moved hosting.',
    ].join('\n'),
    labels: ['bug'],
    author: 'priya-dev',
    age: 3,
    updated: 1,
    comments: [
      {
        login: 'jules-w',
        body: 'Two people emailed us about this today.',
        age: 2,
      },
      {
        login: 'priya-dev',
        body: 'Confirmed: the variable is not set on the new host.',
        age: 1,
      },
    ],
  },
  {
    title: 'Document the colour tokens',
    body: 'List every `--color-*` token with where it is used, so we stop adding near-duplicates.',
    labels: ['docs', 'design'],
    state: 'closed',
    author: 'noor-design',
    age: 50,
    updated: 33,
  },
  {
    title: 'Add alt text to all team photos',
    body: 'The team page has eleven photos without `alt`. Describe each person briefly.',
    labels: ['enhancement', 'good first issue'],
    author: 'jules-w',
    age: 16,
    updated: 16,
  },
  {
    title: 'Move analytics to a privacy-friendly provider',
    body: [
      'We want to drop the cookie banner if we can. Options to compare:',
      '',
      '- self-hosted',
      '- a hosted EU service',
      '',
      'Notes from the last call: https://notes.example.org/acme/analytics',
    ].join('\n'),
    labels: ['planning', 'maintenance'],
    author: 'priya-dev',
    age: 27,
    updated: 8,
  },
  {
    title: "Typo on the pricing page: 'recieve'",
    body: 'Second paragraph under "Studio plan".',
    labels: ['bug'],
    state: 'closed',
    author: 'jules-w',
    age: 13,
    updated: 12,
  },
  {
    title: 'Speed up the image build step',
    body: 'The image step takes 6 minutes of the 8-minute deploy. Cache resized images between builds.',
    labels: ['maintenance', DOING],
    author: 'tomas-k',
    assignees: ['tomas-k', 'priya-dev'],
    age: 10,
    updated: 2,
  },
  {
    title: 'Case studies page: filter by industry',
    body: [
      '- [ ] Add an `industry` field to each case study',
      '- [ ] Filter chips above the grid',
      '- [ ] Keep the filter in the URL so it can be shared',
    ].join('\n'),
    labels: ['enhancement', 'design'],
    author: 'noor-design',
    age: 5,
    updated: 5,
  },
];

const BRAND_GUIDE = [
  {
    title: 'Export the logo in SVG and PNG',
    body: 'Both the full logo and the mark, on light and dark backgrounds.',
    labels: ['design'],
    author: 'noor-design',
    age: 20,
    updated: 7,
  },
  {
    title: 'Add a page on tone of voice',
    body: null,
    labels: ['docs'],
    author: 'priya-dev',
    age: 8,
    updated: 8,
  },
];

/** The scenario's repositories, in the order `GET /user/repos` lists them. */
export const USER_TESTING_REPOSITORIES = {
  'acme-studio/website': WEBSITE,
  'acme-studio/brand-guide': BRAND_GUIDE,
};

/**
 * Fills one repository through the fixture's own `createIssue`,
 * `updateIssue` and `createComment`, then sets what those leave at their
 * defaults (authors, assignees, label colours, dates). `state` is the
 * repository's stored `{ issues, comments }`.
 */
export function seedUserTesting(name, api, state, startedAt = Date.now()) {
  const daysAgo = days =>
    new Date(startedAt - days * 24 * 60 * 60 * 1000).toISOString();

  for (const input of USER_TESTING_REPOSITORIES[name] ?? []) {
    const { number } = api.createIssue(name, {
      title: input.title,
      body: input.body ?? '',
    });
    const stored = state.issues.find(i => i.number === number);

    for (const c of input.comments ?? []) {
      const { id } = api.createComment(name, number, { body: c.body });
      Object.assign(
        state.comments.find(x => x.id === id),
        {
          user: { login: c.login },
          created_at: daysAgo(c.age),
          updated_at: daysAgo(c.age),
        },
      );
    }

    Object.assign(stored, {
      body: input.body,
      state: input.state ?? 'open',
      labels: input.labels.map(label =>
        label === DOING ? label : { name: label, color: LABELS[label] },
      ),
      assignees: (input.assignees ?? []).map(login => ({ login })),
      user: { login: input.author },
      created_at: daysAgo(input.age),
      updated_at: daysAgo(input.updated),
      ...(input.state === 'closed'
        ? { closed_at: daysAgo(input.updated) }
        : {}),
    });
  }
}
