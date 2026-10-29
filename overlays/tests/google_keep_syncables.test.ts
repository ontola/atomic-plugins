// @wc-ignore-file
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describePlatform,
  prepareDocument,
  readPlatform,
  replaceBlock,
  replaceOf,
  unkeyedListsOf,
} from "../../syncables/src/browser.js";
import type { Transport } from "../../syncables/src/read/transport.js";

// Python's companion test compares this generated file to the real pinned
// catalog composition, so these consumer cases need no network or Python.
const document = prepareDocument(
  JSON.parse(
    readFileSync(
      new URL(
        "../../syncables/examples/daemon/google-keep.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const reply = (body: unknown, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("Google Keep catalog through Syncables", () => {
  it("reads past short and empty pages using Google's resource names", async () => {
    expect(describePlatform(document).collections).toEqual(["notes"]);
    expect(describePlatform(document).parameters).toEqual([]);
    const tokens: (string | null)[] = [];
    const pages = [
      {
        notes: [{ name: "notes/invented-a", title: "Fictional first note" }],
        nextPageToken: "invented-2",
      },
      { nextPageToken: "invented-3" },
      { notes: [{ name: "notes/invented-b", title: "Fictional second note" }] },
    ];
    const transport: Transport = async ({ method, url }) => {
      expect(method).toBe("GET");
      expect(url.origin + url.pathname).toBe(
        "https://keep.googleapis.com/v1/notes",
      );
      tokens.push(url.searchParams.get("pageToken"));
      return reply(pages[tokens.length - 1]);
    };
    const result = await readPlatform(document, {
      platform: "google-keep",
      constants: {},
      transport,
    });
    expect(result.errors).toEqual([]);
    expect(tokens).toEqual([null, "invented-2", "invented-3"]);
    expect(result.records.map((r) => r.id)).toEqual([
      "notes/invented-a",
      "notes/invented-b",
    ]);
  });

  it("accepts an empty account and refuses malformed or aborted pages", async () => {
    for (const [body, status, failed] of [
      [{}, 200, false],
      [{ notes: null }, 200, true],
      [{ error: { status: "ABORTED" } }, 409, true],
    ] as const) {
      const result = readPlatform(document, {
        platform: "google-keep",
        constants: {},
        transport: async () => reply(body, status),
      });
      if (failed) {
        await expect(result).rejects.toThrow("Read incomplete");
      } else {
        expect((await result).records).toEqual([]);
      }
    }
  });

  it("exposes replacement blocks and unkeyed checklist metadata to consumers", () => {
    const replacement = replaceOf(document, "note");
    expect(replacement).toHaveProperty("blockedBy");
    if (!replacement || "refused" in replacement)
      throw new Error("Missing valid replace declaration");
    expect(replaceBlock(replacement, { attachments: [{}] })).toHaveProperty(
      "field",
      "attachments",
    );
    expect(
      replaceBlock(replacement, {
        permissions: [{ role: "OWNER" }, { role: "WRITER" }],
      }),
    ).toHaveProperty("field", "permissions");
    expect(unkeyedListsOf(document, "note")).toHaveProperty(
      "body.list.listItems",
      {
        match: ["text.text", "checked"],
        children: "childListItems",
      },
    );
  });
});
