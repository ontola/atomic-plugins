import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Transport } from "../../syncables/src/browser.js";
import type { OpenApiDocument } from "../../syncables/src/openapi/types.js";

// Also exercise an installed npm release with this same fixture; the source
// version number alone does not establish which consumer was published.
const consumer = process.env.SYNCABLES_TEST_MODULE
  ? await import(/* @vite-ignore */ process.env.SYNCABLES_TEST_MODULE)
  : await import("../../syncables/src/browser.js");
const { prepareDocument, describePlatform, readPlatform, readCollections } =
  consumer as typeof import("../../syncables/src/browser.js");

// Compose the candidate's real immutable OAD and overlay pins. Only the
// provider responses below are synthetic; no ClickUp request is made.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const document = prepareDocument(
  JSON.parse(
    execFileSync(
      "python3",
      ["overlays/tests/compose_gitlab_platform.py", "clickup"],
      {
        cwd: repo,
        env: {
          ...process.env,
          ONBOARDING_CATALOG_PATH:
            "overlays/catalog/2026-10-08-gitlab-tasks-clickup.json",
        },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  ) as OpenApiDocument,
  [],
);

describe("ClickUp Syncables read metadata", () => {
  it("reads from page zero without claiming an assumed short-page end is complete", async () => {
    const description = describePlatform(document);
    expect(description.collections).toEqual(["workspaces", "workspaceTasks"]);
    expect(description.parameters).toEqual([]);
    expect(description.upstream).toBe("https://api.clickup.com/api");

    const total = 250;
    const pageSize = 100;
    const requests: string[] = [];
    const transport: Transport = async ({ url, method }) => {
      expect(method).toBe("GET");
      requests.push(url.href);
      let body: unknown;

      if (url.pathname === "/api/v2/team") {
        body = { teams: [{ id: "1234", name: "Workspace" }] };
      } else if (url.pathname === "/api/v2/team/1234/task") {
        const page = Number(url.searchParams.get("page"));
        expect(Number.isInteger(page) && page >= 0).toBe(true);
        body = {
          tasks: Array.from(
            {
              length: Math.max(0, Math.min(pageSize, total - page * pageSize)),
            },
            (_, index) => ({
              id: `task-${page * pageSize + index}`,
              name: `Task ${page * pageSize + index}`,
              team_id: "1234",
              parent: null,
            }),
          ),
        };
      } else {
        throw new Error(`Unexpected ClickUp request ${url.href}`);
      }

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
    };

    const result = await readPlatform(document, {
      platform: "clickup",
      constants: {},
      limits: { maxRecords: 1000 },
      transport,
    });
    const base = "https://api.clickup.com/api/v2";
    expect(requests).toEqual([
      `${base}/team`,
      `${base}/team/1234/task?page=0`,
      `${base}/team/1234/task?page=1`,
      `${base}/team/1234/task?page=2`,
    ]);
    expect(result.errors).toEqual([]);
    expect(
      result.records.filter((record) => record.resource === "task"),
    ).toHaveLength(total);

    // The provider documents the page cap, not that a short page is final.
    const read = await readCollections(document, { transport, constants: {} });
    const tasks = read.collections.find(
      (snapshot) => snapshot.collection.name === "workspaceTasks",
    );
    expect(tasks?.items).toHaveLength(total);
    expect(tasks?.complete).toBe(false);
    expect(tasks?.notComplete).toMatch(/assumed, not documented/);
  });
});
