import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createListTagOperationsMethods,
  type ListTagOperationsDependencies,
  type ListTagRequester,
  type ListTagRequestOptions,
} from "../../lib/api/list-tag-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: ListTagRequestOptions | undefined;
}

const METHOD_NAMES = [
  "listLists",
  "listsForSubscriber",
  "addSubscriberToList",
  "removeSubscriberFromList",
  "createList",
  "updateList",
  "deleteList",
  "getListHealth",
  "listTags",
  "createTag",
  "updateTag",
  "listTagGroups",
  "createTagGroup",
  "updateTagGroup",
  "deleteTagGroup",
  "deleteTag",
  "listTagHistory",
  "listTagTaxonomy",
  "mergeTags",
  "renameTagAcross",
  "listSubscribersWithTag",
  "suggestTags",
  "tagMembership",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);
const TAG_ID = "11111111-1111-4111-8111-111111111111";
const TAG_ETAG = `"tag:${TAG_ID}:v1"`;

function tagMutationResponse(
  name: string,
  options: { version?: number; serverVersion?: string } = {},
): ApiResult<unknown> {
  const version = options.version ?? 1;
  const etag = `"tag:${TAG_ID}:v${version}"`;
  return {
    data: {
      id: TAG_ID,
      name,
      color: "slate",
      description: "",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      pii: false,
      version,
      etag,
    },
    serverVersion: options.serverVersion ?? etag,
  };
}

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];

  const request: ListTagRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: ListTagRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };

  const dependencies: ListTagOperationsDependencies = { request };
  return {
    calls,
    methods: createListTagOperationsMethods(dependencies),
  };
}

describe("list and tag operations API extraction contracts", () => {
  it("retains the exact ordered 23-method inventory without eager work", () => {
    const { calls, methods } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
  });

  it("preserves list CRUD, subscriber membership, defaults, and health queries", async () => {
    const { calls, methods } = createHarness();
    const update = { name: "Customers / 2026", tags: ["customer"] };

    await methods.listLists();
    await methods.listsForSubscriber("sub/one");
    await methods.addSubscriberToList("list/one", "sub/one");
    await methods.removeSubscriberFromList("list/one", "sub/one");
    await methods.createList({ name: "Customers" });
    await methods.updateList("list/one", update);
    await methods.deleteList("list/one");
    await methods.getListHealth({ tag: "high value", windowDays: 14 });

    expect(calls).toEqual([
      { path: "/api/v1/lists", init: undefined, opts: undefined },
      {
        path: "/api/v1/lists/for-subscriber/sub%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/lists/list%2Fone/subscribers",
        init: {
          method: "POST",
          body: JSON.stringify({ subscriber_ids: ["sub/one"] }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/lists/list%2Fone/subscribers/sub%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/lists",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "Customers",
            type: "private",
            optin: "single",
            tags: [],
            description: "",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/lists/list%2Fone",
        init: { method: "PATCH", body: JSON.stringify(update) },
        opts: undefined,
      },
      {
        path: "/api/v1/lists/list%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/list-health?tag=high+value&window_days=14",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves supported tag and tag-group CRUD wire shapes", async () => {
    const { calls, methods } = createHarness();
    const tagPatch = {
      name: "Priority",
      color: "#ffffff",
      description: undefined,
      pii: true,
      group_id: "group/one",
    };
    const groupUpdate = { name: "Lifecycle", sort_order: 3 };

    await methods.listTags({
      includeArchived: true,
      groupId: "group/one",
    });
    await methods.createTag({ name: "VIP" });
    await methods.updateTag(TAG_ID, tagPatch, TAG_ETAG);
    await methods.listTagGroups();
    await methods.createTagGroup({ name: "Audience" });
    await methods.updateTagGroup("group/one", groupUpdate);
    await methods.deleteTagGroup("group/one");
    await methods.deleteTag("tag/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/tags?include_archived=true&group_id=group%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/tags",
        init: {
          method: "POST",
          body: JSON.stringify({ name: "VIP" }),
        },
        opts: undefined,
      },
      {
        path: `/api/v1/tags/${TAG_ID}`,
        init: {
          method: "PATCH",
          body: JSON.stringify({
            name: "Priority",
            color: "#ffffff",
            group_id: "group/one",
            pii: true,
          }),
          headers: { "If-Match": TAG_ETAG },
        },
        opts: undefined,
      },
      { path: "/api/v1/tag-groups", init: undefined, opts: undefined },
      {
        path: "/api/v1/tag-groups",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "Audience",
            color: "",
            sort_order: 0,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/tag-groups/group%2Fone",
        init: { method: "PATCH", body: JSON.stringify(groupUpdate) },
        opts: undefined,
      },
      {
        path: "/api/v1/tag-groups/group%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/tags/tag%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves omission for every single-field tag patch", async () => {
    const { calls, methods } = createHarness();

    await methods.updateTag(TAG_ID, { color: "teal" }, TAG_ETAG);
    await methods.updateTag(
      TAG_ID,
      { description: "Lifecycle customer" },
      TAG_ETAG,
    );
    await methods.updateTag(TAG_ID, { description: "" }, TAG_ETAG);
    await methods.updateTag(TAG_ID, { name: "customer" }, TAG_ETAG);
    await methods.updateTag(
      TAG_ID,
      {
        pii: true,
        group_id: "not-yet-supported",
      },
      TAG_ETAG,
    );

    expect(
      calls.map((call) => JSON.parse(String(call.init?.body)) as unknown),
    ).toEqual([
      { color: "teal" },
      { description: "Lifecycle customer" },
      { description: "" },
      { name: "customer" },
      { pii: true, group_id: "not-yet-supported" },
    ]);
  });

  it("sends supported governance fields in versioned create bodies", async () => {
    const { calls, methods } = createHarness();

    await methods.createTag({
      name: "VIP",
      color: "rose",
      description: "High-value subscriber",
      pii: true,
      group_id: "group-1",
    });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "VIP",
      color: "rose",
      description: "High-value subscriber",
      pii: true,
      group_id: "group-1",
    });
  });

  it("accepts only complete tag mutation bodies with matching strong response ETags", async () => {
    const { methods } = createHarness([
      tagMutationResponse("VIP"),
      tagMutationResponse("Priority", { version: 2 }),
      tagMutationResponse("Priority", {
        version: 3,
        serverVersion: `"tag:${TAG_ID}:v2"`,
      }),
      {
        data: {
          id: TAG_ID,
          name: "VIP",
          version: 1,
          etag: TAG_ETAG,
        },
        serverVersion: TAG_ETAG,
      },
    ]);

    await expect(methods.createTag({ name: "VIP" })).resolves.toMatchObject({
      data: { id: TAG_ID, name: "VIP", etag: TAG_ETAG },
      serverVersion: TAG_ETAG,
    });
    await expect(
      methods.updateTag(TAG_ID, { name: "Priority" }, TAG_ETAG),
    ).resolves.toMatchObject({
      data: { id: TAG_ID, name: "Priority", version: 2 },
    });

    const mismatched = (await methods.updateTag(
      TAG_ID,
      { color: "teal" },
      TAG_ETAG,
    )) as ApiErr;
    expect(mismatched.error.code).toBe("invalid_subscriber_response_contract");

    const incomplete = (await methods.createTag({ name: "VIP" })) as ApiErr;
    expect(incomplete.error.code).toBe("invalid_subscriber_response_contract");
  });

  it("blocks PATCH locally when the exact resource ETag is absent or mismatched", async () => {
    const { calls, methods } = createHarness();

    for (const etag of ["", "*", `"tag:${TAG_ID}:v0"`, 'W/"tag:other:v1"']) {
      const rejected = (await methods.updateTag(
        TAG_ID,
        { color: "teal" },
        etag,
      )) as ApiErr;
      expect(rejected.error.code).toBe("invalid_subscriber_response_contract");
    }
    expect(calls).toEqual([]);
  });

  it("preserves tag history and taxonomy listing queries", async () => {
    const { calls, methods } = createHarness();

    await methods.listTagHistory("tag/one", {
      cursor: "2026-07-16T08:00:00Z",
      limit: 25,
    });
    await methods.listTagTaxonomy();

    expect(calls).toEqual([
      {
        path: "/api/v1/tags/tag%2Fone/history?cursor=2026-07-16T08%3A00%3A00Z&limit=25",
        init: undefined,
        opts: undefined,
      },
      { path: "/api/v1/tag-taxonomy", init: undefined, opts: undefined },
    ]);
  });

  it("preserves taxonomy merge, rename, subscriber, suggestion, and membership transports", async () => {
    const { calls, methods } = createHarness();
    const merge = { from: "prospect", into: "customer" };
    const rename = { from: "vip-old", to: "vip" };

    await methods.mergeTags(merge);
    await methods.renameTagAcross(rename);
    await methods.listSubscribersWithTag("high value", 75);
    await methods.suggestTags("pri/vip", 12);
    await methods.tagMembership("tag/one", 45);

    expect(calls).toEqual([
      {
        path: "/api/v1/tag-taxonomy/merge",
        init: { method: "POST", body: JSON.stringify(merge) },
        opts: undefined,
      },
      {
        path: "/api/v1/tag-taxonomy/rename",
        init: { method: "POST", body: JSON.stringify(rename) },
        opts: undefined,
      },
      {
        path: "/api/v1/tag-taxonomy/subscribers?tag=high+value&limit=75",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/tag-taxonomy/suggest?q=pri%2Fvip&limit=12",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/tag-taxonomy/tag%2Fone/membership?days=45",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("retains default-query behavior and passes request errors through unchanged", async () => {
    const expectedError = {
      error: { kind: "http" as const, status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness([expectedError]);

    await expect(methods.getListHealth()).resolves.toBe(expectedError);
    await methods.listTags();
    await methods.listTagHistory("tag/one");
    await methods.listSubscribersWithTag("vip");
    await methods.suggestTags("");
    await methods.tagMembership("tag/one");

    expect(calls.map(({ path }) => path)).toEqual([
      "/api/v1/list-health",
      "/api/v1/tags",
      "/api/v1/tags/tag%2Fone/history",
      "/api/v1/tag-taxonomy/subscribers?tag=vip&limit=50",
      "/api/v1/tag-taxonomy/suggest?q=&limit=10",
      "/api/v1/tag-taxonomy/tag%2Fone/membership?days=30",
    ]);
  });

  it("rejects mismatched subscriber and list identities at the membership boundary", async () => {
    const { methods } = createHarness([
      {
        data: {
          subscriber_id: "subscriber-other",
          items: [{ id: "list-1", name: "Newsletter" }],
          count: 1,
        },
      },
      {
        data: {
          subscriber_id: "subscriber-other",
          list_id: "list-1",
          added: 1,
          skipped: 0,
        },
      },
      {
        data: {
          subscriber_id: "subscriber-1",
          list_id: "list-other",
          ok: true,
        },
      },
    ]);

    const results = [
      await methods.listsForSubscriber("subscriber-1"),
      await methods.addSubscriberToList("list-1", "subscriber-1"),
      await methods.removeSubscriberFromList("list-1", "subscriber-1"),
    ];
    for (const result of results) {
      const rejected = result as ApiErr;
      expect(rejected.error.code).toBe("subscriber_response_identity_mismatch");
      expect(rejected.error.kind).toBe("parse");
      expect(rejected.retryability).toBe("manual");
    }
  });

  it("rejects duplicate list resource identities before subscribers consume them", async () => {
    const { methods } = createHarness([
      {
        data: {
          data: {
            results: [
              { id: "list-1", name: "Newsletter" },
              { id: "LIST-1", name: "Duplicate identity" },
            ],
          },
        },
      },
    ]);

    const rejected = (await methods.listLists()) as ApiErr;
    expect(rejected.error.code).toBe("invalid_subscriber_response_contract");
    expect(rejected.error.kind).toBe("parse");
    expect(rejected.retryability).toBe("manual");
  });
});
