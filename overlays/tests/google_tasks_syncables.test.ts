import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  describePlatform,
  readPlatform,
  prepareDocument,
  type Transport,
} from "../../syncables/src/browser.js";
import type { OpenApiDocument } from "../../syncables/src/openapi/types.js";

const reply = (body: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Read the actual candidate catalog, pinned OAD and local overlay bytes.
// A handwritten equivalent would miss composition and schema-parser failures.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const googleTasks = prepareDocument(
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
          ONBOARDING_CATALOG_PATH: resolve(
            repo,
            "overlays/catalog/2026-10-08-gitlab-tasks.json",
          ),
        },
      },
    ),
  ) as OpenApiDocument,
);

describe("Google Tasks Syncables read metadata", () => {
  it("discovers task lists as the root input and imports two pages per nested list", async () => {
    expect(describePlatform(googleTasks).parameters).toEqual([]);
    expect(describePlatform(googleTasks).collections).toEqual([
      "taskLists",
      "tasks",
    ]);

    const transport = vi.fn<Transport>(async ({ url }) => {
      const path = url.pathname;
      const token = url.searchParams.get("pageToken");
      if (path.endsWith("/users/@me/lists")) {
        return token
          ? reply({ items: [{ id: "personal", title: "Personal" }] })
          : reply({
              items: [{ id: "work", title: "Work" }],
              nextPageToken: "list-page-2",
            });
      }
      const tasklist = decodeURIComponent(path.split("/")[4] ?? "");
      if (tasklist === "work") {
        return token
          ? reply({
              items: [{ id: "child", title: "Child task", parent: "parent" }],
            })
          : reply({
              items: [{ id: "parent", title: "Parent task" }],
              nextPageToken: "task-page-2",
            });
      }
      return reply({
        items: [{ id: "personal-task", title: "Personal task" }],
      });
    });

    const result = await readPlatform(googleTasks, {
      platform: "google-tasks",
      constants: {},
      transport,
    });

    expect(
      transport.mock.calls.map(
        ([request]) => request.url.pathname + request.url.search,
      ),
    ).toEqual([
      "/tasks/v1/users/@me/lists",
      "/tasks/v1/users/@me/lists?pageToken=list-page-2",
      "/tasks/v1/lists/work/tasks",
      "/tasks/v1/lists/work/tasks?pageToken=task-page-2",
      "/tasks/v1/lists/personal/tasks",
    ]);
    expect(result.errors).toEqual([]);
    expect(
      result.records
        .filter((record) => record.resource === "task")
        .map((record) => [record.namespace, record.id, record.name]),
    ).toEqual([
      ["work", "parent", "Parent task"],
      ["work", "child", "Child task"],
      ["personal", "personal-task", "Personal task"],
    ]);
    expect(
      result.records.find((record) => record.id === "child")?.values.parent,
    ).toBe("parent");
  });
});
