import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readPlatform,
  prepareDocument,
  type Transport,
} from "../../syncables/src/browser.js";
import type { OpenApiDocument } from "../../syncables/src/openapi/types.js";

// An empty Google Tasks list answered without `items`, read through the
// actual catalogs, pinned OAD and local overlay bytes: the 2026-10-11
// catalog (pagination v1) fails the read, the 2026-10-12 one (v2,
// Pagination Schemes 0.7.0 emptyWhenAbsent) reads it as empty. Synthetic
// responses; no provider is called. Run from syncables/ with
// `npx vitest run --root .. overlays/tests/google_tasks_empty_lists_syncables.test.ts`.

const reply = (body: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const repo = fileURLToPath(new URL("../../", import.meta.url));
const compose = (catalog: string): OpenApiDocument =>
  prepareDocument(
    JSON.parse(
      execFileSync(
        "python3",
        ["overlays/tests/compose_gitlab_platform.py", "google-tasks"],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          env: {
            ...process.env,
            ONBOARDING_CATALOG_PATH: resolve(repo, "overlays/catalog", catalog),
          },
        },
      ),
    ) as OpenApiDocument,
  );

// One task list, "empty", whose tasks list has no `items` at all.
const transport: Transport = async ({ url }) =>
  url.pathname.endsWith("/users/@me/lists")
    ? reply({ items: [{ id: "empty", title: "Empty" }] })
    : reply({ kind: "tasks#tasks", etag: '"e1"' });

describe("Google Tasks empty lists through the catalogs", () => {
  it("fails the read under pagination v1", async () => {
    const result = await readPlatform(compose("2026-10-11-gitlab-box.json"), {
      platform: "google-tasks",
      constants: {},
      transport,
    });
    expect(result.errors.join()).toMatch(/No items array at items/);
  });

  it("reads an empty list under pagination v2", async () => {
    const result = await readPlatform(
      compose("2026-10-12-tasks-empty-lists.json"),
      { platform: "google-tasks", constants: {}, transport },
    );
    expect(result.errors).toEqual([]);
    expect(
      result.records.filter((record) => record.resource === "task"),
    ).toEqual([]);
    expect(
      result.records.map((record) => [record.resource, record.id]),
    ).toEqual([["tasklist", "empty"]]);
  });
});
