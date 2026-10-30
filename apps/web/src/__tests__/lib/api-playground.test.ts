// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// API playground, below the page: the catalog normalizer and execution policy
// run against the REAL contract the server serves (apps/api/internal/apidocs/
// openapi.json), the request builder is held to "one exact, structurally safe
// request", and the transport is asserted at global fetch — method, URL,
// credentials, redirect policy, headers and body — plus the outcome classes
// the runner's retry fence depends on.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizePlaygroundCatalog,
  PlaygroundCatalogError,
  playgroundPolicyFor,
  playgroundRoleAllows,
  reviewedExecutionKeys,
  type PlaygroundOperation,
} from "@/lib/api-playground-catalog";
import {
  buildPlaygroundRequest,
  executePlaygroundRequest,
  initialPlaygroundDraft,
  loadPlaygroundCatalog,
  unsafePlaygroundPathValue,
  type PlaygroundDraft,
} from "@/lib/api-playground-transport";

const REAL_SPEC = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../api/internal/apidocs/openapi.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function spec(paths: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    openapi: "3.1.0",
    info: { title: "Fixture API", version: "9.9.9" },
    security: [{ bearerAuth: [] }],
    paths,
    ...extra,
  };
}

const json = { "application/json": { schema: { type: "object" } } };

function op(catalog: ReturnType<typeof normalizePlaygroundCatalog>, key: string): PlaygroundOperation {
  const found = catalog.operations.find((operation) => operation.key === key);
  if (!found) throw new Error(`missing ${key}`);
  return found;
}

function draft(overrides: Partial<PlaygroundDraft> = {}): PlaygroundDraft {
  return {
    path: {},
    query: {},
    headers: {},
    body: "",
    idempotencyKey: "0190f5c2-7b1a-7c3d-8e4f-5a6b7c8d9e0f",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("catalog normalizer + policy against the live contract", () => {
  const catalog = normalizePlaygroundCatalog(REAL_SPEC);
  const policies = catalog.operations.map((operation) => ({
    operation,
    policy: playgroundPolicyFor(operation),
  }));

  it("keeps every operation, once, keyed by method and template", () => {
    const keys = catalog.operations.map((operation) => operation.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(1_500);
    expect(keys).toContain("GET /api/v1/openapi.json");
  });

  // Desktop's reviewed allowlist (api-playground-policy.ts REVIEWED_EXECUTION),
  // written out here rather than read from the module under test.
  const DESKTOP_REVIEWED: Record<string, "read" | "effectful" | "destructive"> = {
    "GET /api/v1/accounts": "read",
    "GET /api/v1/api-keys/me": "read",
    "GET /api/v1/campaigns": "read",
    "GET /api/v1/campaigns/{id}": "read",
    "GET /api/v1/segments": "read",
    "GET /api/v1/segments/{id}": "read",
    "GET /api/v1/subscribers": "read",
    "GET /api/v1/subscribers/{id}": "read",
    "GET /api/v1/tags": "read",
    "GET /api/v1/tags/{id}/history": "read",
    "POST /api/v1/tags": "effectful",
    "PATCH /api/v1/tags/{id}": "effectful",
    "DELETE /api/v1/tags/{id}": "destructive",
  };

  it("reviews exactly desktop's 13 operations, with desktop's effect classes", () => {
    expect(reviewedExecutionKeys()).toEqual(Object.keys(DESKTOP_REVIEWED).sort());
    for (const [key, effect] of Object.entries(DESKTOP_REVIEWED)) {
      expect(playgroundPolicyFor(op(catalog, key)).effect).toBe(effect);
    }
  });

  it("executes only reviewed operations whose live fingerprint matches — 12 of the 13 on a session", () => {
    const executable = policies
      .filter(({ policy }) => policy.executable)
      .map(({ operation }) => operation.key)
      .sort();
    // GET /api/v1/api-keys/me is reviewed but declares an API-key-only auth
    // method; the web runner holds only the dashboard session.
    expect(executable).toEqual(
      Object.keys(DESKTOP_REVIEWED)
        .filter((key) => key !== "GET /api/v1/api-keys/me")
        .sort(),
    );
    expect(playgroundPolicyFor(op(catalog, "GET /api/v1/api-keys/me")).reason).toBe(
      "This route accepts only an API key; the web runner sends your dashboard session and never holds a key.",
    );
  });

  it("keeps a write desktop never reviewed reference-only, with the reason", () => {
    const policy = playgroundPolicyFor(op(catalog, "POST /api/v1/campaigns"));
    expect(policy.executable).toBe(false);
    expect(policy.reason).toBe(
      "Not reviewed for live execution — reference only. Web runs only the operations desktop has reviewed.",
    );
  });

  it("turns a reviewed operation reference-only when its contract drifts, but not for cosmetic edits", () => {
    const drifted = structuredClone(REAL_SPEC) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const tags = drifted.paths["/api/v1/tags"]!;
    tags.get!.parameters = [
      ...((tags.get!.parameters as unknown[]) ?? []),
      { name: "force", in: "query", schema: { type: "boolean" } },
    ];
    tags.post!.summary = "Create a tenant tag (reworded)";
    const driftedCatalog = normalizePlaygroundCatalog(drifted);
    const list = playgroundPolicyFor(op(driftedCatalog, "GET /api/v1/tags"));
    expect(list.executable).toBe(false);
    expect(list.reason).toBe(
      "Reviewed runner contract changed; independent re-review is required before it runs again.",
    );
    expect(playgroundPolicyFor(op(driftedCatalog, "POST /api/v1/tags")).executable).toBe(true);
  });

  it("withholds every release-held operation and names the hold", () => {
    const held = policies.filter(({ operation }) => operation.releaseHold);
    expect(held.length).toBeGreaterThan(0);
    for (const { operation, policy } of held) {
      expect(policy.executable).toBe(false);
      expect(policy.reason).toBe(`Release hold: ${operation.releaseHold}`);
    }
  });

  it("never runs an API-key-only route with the session", () => {
    const keyOnly = policies.filter(
      ({ operation }) => operation.requiredAuthMethod === "api_key",
    );
    expect(keyOnly.length).toBeGreaterThan(0);
    expect(keyOnly.every(({ policy }) => !policy.executable)).toBe(true);
  });
});

describe("catalog normalizer fails closed", () => {
  it("rejects a non-3.1 document", () => {
    expect(() => normalizePlaygroundCatalog({ openapi: "3.0.3", paths: {} })).toThrow(
      PlaygroundCatalogError,
    );
  });

  it("rejects an unresolved operation instead of dropping it", () => {
    expect(() =>
      normalizePlaygroundCatalog(
        spec({ "/api/v1/tags": { get: { $ref: "#/components/missing" } } }),
      ),
    ).toThrow(/unresolved/);
  });
});

describe("execution policy", () => {
  const catalog = normalizePlaygroundCatalog(
    spec({
      "/api/v1/tags": {
        get: { summary: "List", responses: { "200": { content: json } } },
        post: {
          "x-required-role": "editor",
          requestBody: { required: true, content: json },
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
          responses: { "201": { content: json } },
        },
      },
      "/api/v1/tags/{id}": {
        delete: {
          "x-required-scopes": ["admin"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": {} },
        },
      },
      "/api/v1/reviews/{id}": {
        post: {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "X-Postwave-Review-Secret", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { content: json } },
        },
      },
      "/api/v1/export.csv": { get: { responses: { "200": { content: { "text/csv": {} } } } } },
      "/api/v1/keys-only": {
        get: { "x-required-auth-method": "api_key", responses: { "200": { content: json } } },
      },
      "/api/v1/login": { post: { security: [], responses: { "200": { content: json } } } },
      "/api/v1/portal": {
        get: { security: [{ portalCookie: [] }], responses: { "200": { content: json } } },
      },
    }),
  );

  it("derives the minimum role from x-required-role, then scopes, then the method", () => {
    expect(playgroundPolicyFor(op(catalog, "GET /api/v1/tags")).requiredRole).toBe("viewer");
    expect(playgroundPolicyFor(op(catalog, "POST /api/v1/tags")).requiredRole).toBe("editor");
    expect(playgroundPolicyFor(op(catalog, "DELETE /api/v1/tags/{id}")).requiredRole).toBe("admin");
    expect(playgroundRoleAllows("viewer", "editor")).toBe(false);
    expect(playgroundRoleAllows("editor", "editor")).toBe(true);
    expect(playgroundRoleAllows("owner", "admin")).toBe(true);
    expect(playgroundRoleAllows(null, "viewer")).toBe(false);
  });

  it("names why an operation is reference-only", () => {
    expect(playgroundPolicyFor(op(catalog, "POST /api/v1/reviews/{id}")).reason).toBe(
      "Requires the X-Postwave-Review-Secret header, which the web runner does not let you set.",
    );
    expect(playgroundPolicyFor(op(catalog, "GET /api/v1/export.csv")).reason).toBe(
      "Downloads and binary responses are reference-only.",
    );
    expect(playgroundPolicyFor(op(catalog, "GET /api/v1/keys-only")).reason).toMatch(/only an API key/);
    expect(playgroundPolicyFor(op(catalog, "POST /api/v1/login")).reason).toMatch(/Public capability/);
    expect(playgroundPolicyFor(op(catalog, "GET /api/v1/portal")).reason).toMatch(/portalCookie/);
    expect(playgroundPolicyFor(op(catalog, "POST /api/v1/tags")).idempotency).toBe("optional");
  });
});

describe("request builder", () => {
  const catalog = normalizePlaygroundCatalog(
    spec({
      "/api/v1/tags/{id}": {
        patch: {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "dry_run", in: "query", schema: { type: "string", enum: ["true", "false"] } },
            { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["name"], properties: { name: { type: "string", example: "VIP" } } },
              },
            },
          },
          responses: { "200": { content: json } },
        },
      },
    }),
  );
  const patch = op(catalog, "PATCH /api/v1/tags/{id}");
  const policy = playgroundPolicyFor(patch);

  it("builds one exact request from the template, declared query, headers and JSON body", () => {
    const built = buildPlaygroundRequest(
      patch,
      policy,
      draft({
        path: { id: "tag 7" },
        query: { dry_run: "true" },
        headers: { "If-Match": 'W/"3"' },
        body: '{"name":"VIP"}',
      }),
    );
    expect(built.issues).toEqual([]);
    expect(built.plan).toEqual({
      method: "PATCH",
      url: "/api/v1/tags/tag%207?dry_run=true",
      headers: {
        "If-Match": 'W/"3"',
        "Idempotency-Key": "0190f5c2-7b1a-7c3d-8e4f-5a6b7c8d9e0f",
        "Content-Type": "application/json",
      },
      body: '{"name":"VIP"}',
    });
  });

  it("seeds the body from the schema example", () => {
    expect(JSON.parse(initialPlaygroundDraft(patch).body)).toEqual({ name: "VIP" });
  });

  it("refuses traversal, missing required inputs, off-enum values and invalid JSON", () => {
    for (const value of ["..", "a/b", "%2e%2e", "%252e%252e", "a\\b"]) {
      expect(unsafePlaygroundPathValue(value)).not.toBeNull();
    }
    const built = buildPlaygroundRequest(
      patch,
      policy,
      draft({ path: { id: ".." }, query: { dry_run: "maybe" }, body: "{nope" }),
    );
    expect(built.issues.map((issue) => `${issue.field}:${issue.name}`)).toEqual([
      "path:id",
      "query:dry_run",
      "header:If-Match",
      "body:body",
    ]);
    expect(built.plan.url).toBe("/api/v1/tags/{id}?dry_run=maybe");
  });
});

describe("transport", () => {
  // Reviewed operations from the real contract: their effect classes are the
  // reviewed ones the ambiguity rule reads.
  const catalog = normalizePlaygroundCatalog(REAL_SPEC);
  const list = op(catalog, "GET /api/v1/tags");
  const create = op(catalog, "POST /api/v1/tags");

  it("sends one same-origin, credentialed, non-redirecting request with the plan's exact body", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"id":1}', {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json", "x-request-id": "req-1" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await executePlaygroundRequest(
      { method: "POST", url: "/api/v1/tags", headers: { "Content-Type": "application/json" }, body: '{"name":"VIP"}' },
      playgroundPolicyFor(create),
      new AbortController().signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/tags");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"name":"VIP"}');
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-postwave-client")).toBe("web");
    expect(headers.get("authorization")).toBeNull();
    expect(response).toMatchObject({
      status: 201,
      outcome: "http",
      ambiguous: false,
      body: '{"id":1}',
      requestId: "req-1",
    });
  });

  it("carries the server's own sentence on a 503 hold and marks a write's 5xx ambiguous", async () => {
    const sentence = "Referral operations are release-held for this workspace.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "release_held", message: sentence } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const write = await executePlaygroundRequest(
      { method: "POST", url: "/api/v1/tags", headers: {}, body: "" },
      playgroundPolicyFor(create),
      new AbortController().signal,
    );
    expect(write.serverMessage).toBe(sentence);
    expect(write.ambiguous).toBe(true);
    const read = await executePlaygroundRequest(
      { method: "GET", url: "/api/v1/tags", headers: {}, body: "" },
      playgroundPolicyFor(list),
      new AbortController().signal,
    );
    expect(read.ambiguous).toBe(false);
  });

  it("reports a cancelled write as aborted and ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const abort = new AbortController();
    const pending = executePlaygroundRequest(
      { method: "POST", url: "/api/v1/tags", headers: {}, body: "" },
      playgroundPolicyFor(create),
      abort.signal,
    );
    abort.abort("operator-cancelled");
    await expect(pending).resolves.toMatchObject({
      status: 0,
      outcome: "aborted",
      statusText: "Cancelled",
      ambiguous: true,
    });
  });

  it("loads the contract from GET /api/v1/openapi.json and fails closed on malformed JSON", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(spec({ "/api/v1/tags": { get: { responses: {} } } })), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const loaded = await loadPlaygroundCatalog();
    expect(loaded.operations.map((operation) => operation.key)).toEqual(["GET /api/v1/tags"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/openapi\.json$/);
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("include");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{truncated", { status: 200 })));
    await expect(loadPlaygroundCatalog()).rejects.toThrow("The API contract is not valid JSON.");
  });
});
