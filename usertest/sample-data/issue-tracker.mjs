/**
 * The sample GitHub account: the mock proxy's github-issues fixture in its
 * `user-testing` scenario (`integrations/issue-tracker/fixtures/
 * github-issues/user-testing.mjs`), an invented web studio's repositories
 * `acme-studio/website` and `acme-studio/brand-guide`, plus
 * `acme-studio/old-site` with issues turned off. Every person, issue and
 * comment there is made up.
 */
import { githubTracker } from '../../integrations/issue-tracker/fixtures/github-issues/scenario.mjs';
import { USER_TESTING_REPOSITORIES } from '../../integrations/issue-tracker/fixtures/github-issues/user-testing.mjs';

export default {
  platform: 'github-issues',
  name: 'GitHub',
  seed: () => ({}),
  create() {
    const fixture = githubTracker({ scenario: 'user-testing' });
    // Seed now, while the clock is the account's creation time, rather than
    // on the first read, so a replay gets the same dates.
    for (const name of Object.keys(USER_TESTING_REPOSITORIES))
      fixture.snapshot(name);

    return fixture;
  },
};
