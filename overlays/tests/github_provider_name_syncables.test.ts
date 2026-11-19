// @wc-ignore-file
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeCollections,
  prepareDocument,
  readPlatform,
  resolveAuthenticatedPrincipal,
  type OpenApiDocument,
  type QuerySelection,
  type Transport,
} from "../../syncables/src/browser.js";

// A provider-ID rename changes catalog routing/bookkeeping only. Compose the
// actual new profile with the existing generic helper; no live account is read.
const root = fileURLToPath(new URL("../../", import.meta.url));
const catalogPath = resolve(root, "overlays/catalog/2026-11-19-github.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
  platforms: { name: string; selection: QuerySelection }[];
};
const provider = catalog.platforms.find((entry) => entry.name === "github")!;
const document = prepareDocument(
  JSON.parse(
    execFileSync(
      "python3",
      ["overlays/tests/compose_gitlab_platform.py", provider.name],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ONBOARDING_CATALOG_PATH: catalogPath },
      },
    ),
  ) as OpenApiDocument,
);
const json = (value: unknown, headers: Record<string, string> = {}) => ({
  status: 200,
  headers,
  body: JSON.stringify(value),
});

describe("canonical GitHub provider through the catalog", () => {
  it("discovers unchanged principal and collections from the exact github ID", async () => {
    expect(provider.name).toBe("github");
    expect(
      catalog.platforms.some((entry) => entry.name === "github-issues"),
    ).toBe(false);
    expect(document.info.title).toBe("GitHub");
    expect(
      describeCollections(document).map((collection) => collection.name),
    ).toEqual([
      "githubOrganizations",
      "githubRepositories",
      "organizationRepositories",
      "repositoryIssues",
      "issueComments",
    ]);
    const requests: string[] = [];
    const transport: Transport = async (request) => {
      requests.push(`${request.method} ${request.url.pathname}`);
      return json({ id: 7, name: "Example user" });
    };
    const principal = await resolveAuthenticatedPrincipal(document, {
      transport,
    });
    expect(principal).toMatchObject({
      namespace: "https://github.com",
      subject: 7,
    });
    expect(requests).toEqual(["GET /user"]);
  });

  it("pages and projects both row kinds using github as provider bookkeeping", async () => {
    const requests: string[] = [];
    const next =
      "https://api.github.com/repositories/42/issues?state=all&per_page=100&page=2";
    const transport: Transport = async (request) => {
      requests.push(request.url.href);
      expect(request.method).toBe("GET");
      expect(request.url.pathname).toBe("/repositories/42/issues");
      expect(request.url.searchParams.get("state")).toBe("all");
      return request.url.searchParams.has("page")
        ? json([
            {
              id: 102,
              number: 2,
              title: "Pull request sentinel",
              pull_request: {
                url: "https://api.github.com/repos/example/project/pulls/2",
              },
            },
          ])
        : json([{ id: 101, number: 1, title: "Issue sentinel" }], {
            Link: `<${next}>; rel="next"`,
          });
    };
    const result = await readPlatform(document, {
      platform: provider.name,
      collectionNames: ["repositoryIssues"],
      constants: { repository_id: "42" },
      selection: provider.selection,
      transport,
    });
    expect(result.platform).toBe("github");
    expect(result.errors).toEqual([]);
    expect(result.records.map((record) => record.id)).toEqual(["1", "2"]);
    expect(result.records[1]!.values["pull-request"]).toEqual({
      url: "https://api.github.com/repos/example/project/pulls/2",
    });
    expect(requests).toEqual([
      "https://api.github.com/repositories/42/issues?state=all&per_page=100",
      next,
    ]);
  });
});
