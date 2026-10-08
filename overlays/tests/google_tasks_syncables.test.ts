import { describe, expect, it, vi } from "vitest";
import {
  describePlatform,
  readPlatform,
  type Transport,
} from "../../syncables/src/browser.js";
import type { OpenApiDocument } from "../../syncables/src/openapi/types.js";

const reply = (body: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// This is the read subset emitted by the Google Tasks overlays. The Python
// composition test checks that the overlays declare the same paths, paging
// envelope, and parent reference against the pinned OAD.
const googleTasks = {
  openapi: "3.0.0",
  info: { title: "Google Tasks API", version: "v1" },
  servers: [{ url: "https://tasks.googleapis.com/" }],
  components: {
    schemas: {
      TaskList: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" } },
        required: ["id"],
      },
      Task: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          parent: { type: "string" },
        },
        required: ["id"],
      },
    },
    crudResources: {
      taskList: {
        schema: { $ref: "#/components/schemas/TaskList" },
        identity: {
          urlTemplate: "/tasks/v1/users/@me/lists/{tasklist}",
          bindings: { tasklist: { field: "id" } },
        },
        collections: {
          taskLists: { urlTemplate: "/tasks/v1/users/@me/lists" },
        },
      },
      task: {
        schema: { $ref: "#/components/schemas/Task" },
        identity: {
          urlTemplate: "/tasks/v1/lists/{tasklist}/tasks/{task}",
          bindings: { task: { field: "id" } },
        },
        collections: {
          tasks: { urlTemplate: "/tasks/v1/lists/{tasklist}/tasks" },
        },
      },
    },
    paginationSchemes: {
      forwardPages: {
        type: "pageToken",
        request: { queryParameters: { pageToken: { role: "cursor" } } },
        response: { bodyFields: { nextPageToken: { role: "nextCursor" } } },
      },
    },
  },
  paths: {
    "/tasks/v1/users/@me/lists": {
      get: {
        parameters: [
          { name: "maxResults", in: "query", schema: { type: "integer" } },
          { name: "pageToken", in: "query", schema: { type: "string" } },
        ],
        "x-pagination": [
          {
            scheme: "forwardPages",
            overrides: {
              request: {
                queryParameters: { maxResults: { role: "pageSize" } },
              },
              response: { envelope: { itemsField: "items" } },
            },
          },
        ],
      },
    },
    "/tasks/v1/lists/{tasklist}/tasks": {
      get: {
        parameters: [
          {
            name: "tasklist",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "maxResults", in: "query", schema: { type: "integer" } },
          { name: "pageToken", in: "query", schema: { type: "string" } },
        ],
        "x-pagination": [
          {
            scheme: "forwardPages",
            overrides: {
              request: {
                queryParameters: { maxResults: { role: "pageSize" } },
              },
              response: { envelope: { itemsField: "items" } },
            },
          },
        ],
      },
    },
  },
} as unknown as OpenApiDocument;

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
