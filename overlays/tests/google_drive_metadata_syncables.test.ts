import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  prepareDocument,
  readCollections,
  type Transport,
} from "../../syncables/src/browser.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const catalog = "overlays/catalog/2026-11-18-storage-metadata.json";

describe("Google Drive metadata catalog", () => {
  it.each([false, true])(
    "reads the declared cursor and honors incompleteSearch=%s",
    async (incomplete) => {
      const document = prepareDocument(
        JSON.parse(
          execFileSync(
            "python3",
            ["overlays/tests/compose_gitlab_platform.py", "google-drive"],
            {
              cwd: repo,
              encoding: "utf8",
              maxBuffer: 32 * 1024 * 1024,
              env: { ...process.env, ONBOARDING_CATALOG_PATH: catalog },
            },
          ),
        ),
      );
      const cursors: (string | null)[] = [];
      const transport: Transport = async ({ url }) => {
        expect(url.pathname).toBe("/drive/v3/files");
        expect(url.searchParams.get("fields")).toContain("incompleteSearch");
        const cursor = url.searchParams.get("pageToken");
        cursors.push(cursor);
        const next = cursor === "next";
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            files: [{ id: next ? "second" : "first" }],
            ...(next
              ? { incompleteSearch: incomplete }
              : { nextPageToken: "next" }),
          }),
        };
      };

      const result = await readCollections(document, { transport });
      expect(result.errors).toEqual([]);
      expect(cursors).toEqual([null, "next"]);
      const [files] = result.collections;
      expect(files?.items.map((item) => item.id)).toEqual(["first", "second"]);
      expect(files?.complete).toBe(!incomplete);
      if (incomplete)
        expect(files?.notComplete).toContain(
          "server marked the result incomplete",
        );
    },
  );
});
