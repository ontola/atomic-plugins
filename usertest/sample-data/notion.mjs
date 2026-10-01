/**
 * The sample Notion workspace: the mock proxy's notion fixture
 * (`integrations/notion/fixtures/notion/scenario.mjs`) in its `two-sources`
 * scenario, a "Roadmap" and a "Reading list" database, authored from
 * Notion's documented response shapes. Since notion 0.2.0 the app
 * sends reviewed edits (`PATCH /v1/pages/{id}`), which the fixture applies;
 * those are the writes kept and replayed after a remount.
 */
import { notionFixture } from '../../integrations/notion/fixtures/notion/scenario.mjs';

export default {
  platform: 'notion',
  name: 'Notion',
  seed: () => ({}),
  create: () => notionFixture({ scenario: 'two-sources' }),
  // Search and query are POSTs that change nothing; a page PATCH does.
  isWrite: method => method === 'PATCH',
};
