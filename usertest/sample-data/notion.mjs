/**
 * The sample Notion workspace: the mock proxy's notion fixture
 * (`integrations/notion/fixtures/notion/scenario.mjs`) in its `two-sources`
 * scenario, a "Roadmap" and a "Reading list" database, authored from
 * Notion's documented response shapes. Read-only, as the fixture is: the
 * Notion drive app only reads.
 */
import { notionFixture } from '../../integrations/notion/fixtures/notion/scenario.mjs';

export default {
  platform: 'notion',
  name: 'Notion',
  seed: () => ({}),
  create: () => notionFixture({ scenario: 'two-sources' }),
  // Search and query are POSTs, but nothing here changes the fixture.
  isWrite: () => false,
};
