# Notion 2026-03-11 overlays

These overlays accompany the integration-proxy slice of the Notion API at
`ontola/openapi-directory` commit `0c8e229623efdcc1d4ab50111d17bcca3214a899`.
The dated catalogs select `auth`, `pagination` and `crud-causality`, in that
order; `pagination-v2` is described in [`overlays/README.md`](../../../README.md).

`runtime-schema-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml` adds a
[Runtime Schemas 0.1.0-draft](../../../../openapi-extensions/spec/runtime-schemas/README.md)
`x-runtime-schema` to the read-only `page` resource: a page's `properties`
are the columns of its data source, read with
`GET /data_sources/{data_source_id}` through a new `references.data_source`
(bound to `parent.data_source_id`), and matched by stable property id and
checked against `type`. It describes the ten property types the Notion app's
lens projects (`integrations/notion/devonian/notion/lens/projection.ts`);
select, status and multi_select carry their options. Relations, people,
formulas, rollups and timestamps are left undescribed on purpose. Sources:
https://developers.notion.com/reference/data-source-properties and
https://developers.notion.com/reference/page-property-values. The value
schemas follow that documentation and are declared, not verified against a
live workspace.

It must come after `crud-causality` in a catalog. Its second action targets
`$.components` rather than the page resource, so that it also resolves
against the bare document, as `validate_oad_pins.py` requires of an overlay
no catalog selects. No dated catalog selects it until syncables reads
`x-runtime-schema`. Check it with:

```sh
python3 overlays/tests/test_notion_runtime_schema.py --directory <openapi-directory clone>
```
