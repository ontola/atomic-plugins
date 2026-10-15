import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  InMemoryStorageAdapter,
  prepareDocument,
  type TransportRequest,
  type TransportResponse,
} from "../../syncables/src/browser.js";
import type { OpenApiDocument } from "../../syncables/src/openapi/types.js";

// GitHub issue creates with labels as a compound create (CRUD Causality
// 0.5.0 §4.7), read by syncables through the actual catalog bytes: the
// github-issues entry of catalog/2026-10-12-tasks-box-pages.json, with
// crud-causality v2 (#530) in place of v1 and the compound-create overlay
// after it. With v1, whose added fields say `source: server`, syncables would
// send its own placeholder issue number in the create body. A fake GitHub drops the labels of a create
// without push access, as GitHub documents; syncables then adds them with
// "Add labels to an issue". Synthetic responses; no provider is called. Run
// from syncables/ with
// `npx vitest run --root .. overlays/tests/github_compound_create_syncables.test.ts`.

const repo = fileURLToPath(new URL("../../", import.meta.url));
const COMPOUND =
  "https://ontola.github.io/atomic-plugins/overlays/APIs/github.com/github-issues/1.1.4/compound-create-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml";

function compose(): OpenApiDocument {
  const catalog = JSON.parse(
    readFileSync(resolve(repo, "overlays/catalog/2026-10-12-tasks-box-pages.json"), "utf8"),
  ) as { platforms: { name: string; overlays: string[] }[] };
  const issues = catalog.platforms.find((p) => p.name === "github-issues")!;
  issues.overlays = [
    ...issues.overlays.map((url) => url.replace("/crud-causality-", "/crud-causality-v2-")),
    COMPOUND,
  ];
  const path = join(mkdtempSync(join(tmpdir(), "compound-")), "catalog.json");
  writeFileSync(path, JSON.stringify(catalog));
  return prepareDocument(
    JSON.parse(
      execFileSync("python3", ["overlays/tests/compose_gitlab_platform.py", "github-issues"], {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ONBOARDING_CATALOG_PATH: path },
      }),
    ) as OpenApiDocument,
  );
}

const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

describe("GitHub compound create through the catalog", () => {
  it("adds the labels a create without push access dropped", async () => {
    const requests: { line: string; body?: unknown }[] = [];
    const labels: { name: string }[] = [];
    const transport = async (r: TransportRequest): Promise<TransportResponse> => {
      const body = r.body ? JSON.parse(r.body) : undefined;
      requests.push({ line: `${r.method} ${r.url.pathname}`, body });
      if (r.method === "POST" && r.url.pathname === "/repos/o/r/issues")
        // Labels are silently dropped without push access.
        return json({ id: 1, number: 7, title: body.title, labels: [] }, 201);
      if (r.method === "POST" && r.url.pathname === "/repos/o/r/issues/7/labels") {
        for (const name of body.labels as string[]) labels.push({ name });
        return json(labels);
      }
      if (r.method === "GET" && r.url.pathname === "/repos/o/r/issues") return json([]);
      return json({ message: "Not Found" }, 404);
    };
    const client = createApiClient(compose(), {
      transport,
      constants: { owner: "o", repo: "r" },
      retry: { baseDelayMs: 5, maxDelayMs: 10 },
      storage: new InMemoryStorageAdapter(),
    });
    await client.create("issues", { title: "Bug", labels: ["bug"] });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(requests.filter((r) => r.line.startsWith("POST"))).toEqual([
      { line: "POST /repos/o/r/issues", body: { title: "Bug", labels: ["bug"] } },
      { line: "POST /repos/o/r/issues/7/labels", body: { labels: ["bug"] } },
    ]);
  });
  it("leaves the create applied and the follow-up failed when GitHub answers 403", async () => {
    const lines: string[] = [];
    const transport = async (r: TransportRequest): Promise<TransportResponse> => {
      lines.push(`${r.method} ${r.url.pathname}`);
      if (r.method === "POST" && r.url.pathname === "/repos/o/r/issues")
        return json({ id: 1, number: 7, title: "Bug", labels: [] }, 201);
      if (r.method === "POST" && r.url.pathname === "/repos/o/r/issues/7/labels")
        return json({ message: "Must have admin rights to Repository." }, 403);
      if (r.method === "GET" && r.url.pathname === "/repos/o/r/issues") return json([]);
      return json({ message: "Not Found" }, 404);
    };
    const client = createApiClient(compose(), {
      transport,
      constants: { owner: "o", repo: "r" },
      retry: { baseDelayMs: 5, maxDelayMs: 10 },
      storage: new InMemoryStorageAdapter(),
    });
    await client.create("issues", { title: "Bug", labels: ["bug"] });
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([{ state: "failed", followUp: { field: "labels" } }]),
    );
    // The create is not sent again.
    expect(lines.filter((l) => l === "POST /repos/o/r/issues")).toHaveLength(1);
  });
});
