import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  paginate,
  prepareDocument,
  type Transport,
} from "../../syncables/src/browser.js";
import type { OpenApiDocument } from "../../syncables/src/openapi/types.js";

// A Box folder listing whose page holds fewer entries than the limit before
// the end, read with syncables through the actual catalogs, pinned OAD and
// local overlay bytes: under pagination v2 syncables advances by the
// entries returned, reads the short page again from inside it and ends the
// read on the repeated entries; under v3
// (Pagination Schemes 0.7.0 `advance: pageSize`) it steps by the limit to
// `total_count`. Synthetic responses; no provider is called. Run from
// syncables/ with
// `npx vitest run --root .. overlays/tests/box_offsets_syncables.test.ts`.

const repo = fileURLToPath(new URL("../../", import.meta.url));
const compose = (catalog: string): OpenApiDocument =>
  prepareDocument(
    JSON.parse(
      execFileSync("python3", ["overlays/tests/compose_gitlab_platform.py", "box"], {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          ONBOARDING_CATALOG_PATH: resolve(repo, "overlays/catalog", catalog),
        },
      }),
    ) as OpenApiDocument,
  );

/** Ten items at offsets 0-9, offsets 2 and 3 hidden from this caller; limit 4. */
function folder(): { transport: Transport; offsets: number[] } {
  const offsets: number[] = [];
  const transport: Transport = async ({ url }) => {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    offsets.push(offset);
    const entries = [];
    for (let i = offset; i < Math.min(10, offset + 4); i += 1)
      if (i !== 2 && i !== 3) entries.push({ type: "file", id: `f${i}` });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries, offset, limit: 4, total_count: 10 }),
    };
  };
  return { transport, offsets };
}

const read = (catalog: string, transport: Transport) =>
  paginate(compose(catalog), {
    transport,
    path: "/folders/{folder_id}/items",
    pathParams: { folder_id: "0" },
    pageSize: 4,
  });

describe("Box offset lists through the catalogs", () => {
  it("re-reads from inside a short page under pagination v2, and ends with an error", async () => {
    const { transport, offsets } = folder();
    // f4 and f5 come back twice; the repeat ends the read (Pagination
    // Schemes 0.7.0 §4.3.2 asks it of every offset read).
    await expect(
      read("2026-10-12-box-pagination-v2.json", transport),
    ).rejects.toThrow(/holds an item an earlier page returned/);
    expect(offsets).toEqual([0, 2, 4]);
  });

  it("steps by the limit to total_count under pagination v3", async () => {
    const { transport, offsets } = folder();
    const items = await read("2026-10-12-tasks-box-pages.json", transport);
    expect(offsets).toEqual([0, 4, 8]);
    expect(items.map((item) => (item as { id: string }).id)).toEqual([
      "f0", "f1", "f4", "f5", "f6", "f7", "f8", "f9",
    ]);
  });
});
