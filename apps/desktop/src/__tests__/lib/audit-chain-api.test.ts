// SPDX-License-Identifier: AGPL-3.0-only
//
// ECO-22 on desktop: the request-chain client hits the mounted route
// (apps/api/internal/handlers/audit_chain.go), encodes the request id so the
// SERVER recovers it, and passes the {requestId, rows, truncated} envelope
// through unchanged — including the empty chain, which the server answers 200,
// not as an error.
//
// The encoding assertions read their expected URLs from
// apps/api/internal/handlers/testdata/audit_chain_client_paths.json rather than
// from a string typed here. That file is not decoration: the Go test beside it
// (audit_chain_path_contract_test.go) serves each of those paths through a real
// chi router and asserts the production decode recovers the id. So a passing
// assertion here means "the server can read what this client sends", which a
// self-authored `expect(path).toBe("…%2F…")` cannot mean — a client asserting
// its own construction passes on exactly the bug that matters, because a
// mis-encoded id returns an EMPTY chain rather than an error and reads as
// "this request touched nothing".

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditCorrelationId,
  createAuditOperationsMethods,
  type AuditOperationsDependencies,
  type AuditOperationsRequestOptions,
  type AuditOperationsRequester,
} from "../../lib/api/audit-operations";
import type { ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: AuditOperationsRequestOptions | undefined;
}

interface ChainPathCase {
  name: string;
  requestId: string;
  path: string;
}

const CONTRACT_PATH = path.resolve(
  __dirname,
  "../../../../api/internal/handlers/testdata/audit_chain_client_paths.json",
);

const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
  route: string;
  cases: ChainPathCase[];
  unencodedMustNotRoute: ChainPathCase;
};

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queue = [...responses];
  const request: AuditOperationsRequester = async <T>(
    requestPath: string,
    init?: RequestInit,
    opts?: AuditOperationsRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path: requestPath, init, opts });
    return (queue.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies = {
    request,
    getApiUrl: () => "https://api.example.test",
    buildStreamUrl: async (streamPath: string) => `stream:${streamPath}`,
    createDownloadController: () => ({
      signal: new AbortController().signal,
      dispose: () => {},
    }),
    getApiKey: () => "raw-key",
    normalizeApiKey: () => "normalized-key",
    nativeAwareFetch: async () => new Response("{}"),
    apiUrl: (p: string) => `https://api.example.test${p}`,
    errorFromResponse: async () => ({
      kind: "http" as const,
      status: 500,
      message: "unused by the chain read",
    }),
    transportError: () => ({ kind: "network" as const, message: "x" }),
    llmRequestOptions: { timeoutMs: 60_000, maxAttempts: 1 },
  } satisfies AuditOperationsDependencies;
  return { calls, methods: createAuditOperationsMethods(dependencies) };
}

describe("getAuditChain builds a URL the server can decode", () => {
  it("has a non-vacuous shared contract to check against", () => {
    // A fixture that lost its cases would make every assertion below pass
    // without testing anything.
    expect(CONTRACT.route).toBe("/api/v1/audit/chain/{requestId}");
    expect(CONTRACT.cases.length).toBeGreaterThan(1);
    expect(CONTRACT.cases.some((c) => c.requestId.includes("/"))).toBe(true);
  });

  for (const testCase of CONTRACT.cases) {
    it(`sends the server-verified path — ${testCase.name}`, async () => {
      const { calls, methods } = createHarness();
      await methods.getAuditChain(testCase.requestId);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).toBe(testCase.path);
    });
  }

  it("never sends the raw slash the route cannot match", async () => {
    // The Go contract test proves this exact path 404s. If the client ever
    // emitted it the operator would see a failed lookup, not a chain.
    const { calls, methods } = createHarness();
    await methods.getAuditChain(CONTRACT.unencodedMustNotRoute.requestId);
    expect(calls[0]?.path).not.toBe(CONTRACT.unencodedMustNotRoute.path);
  });

  it("is a plain GET with no body", async () => {
    const { calls, methods } = createHarness();
    await methods.getAuditChain("req-abc");
    expect(calls[0]?.init).toBeUndefined();
  });

  it("forwards an abort signal so closing the view cancels the read", async () => {
    const { calls, methods } = createHarness();
    const controller = new AbortController();
    await methods.getAuditChain("req-abc", { signal: controller.signal });
    expect(calls[0]?.opts).toEqual({ signal: controller.signal });
  });
});

describe("getAuditChain envelope", () => {
  it("passes rows through in the ascending order the server sent", async () => {
    const { methods } = createHarness([
      {
        data: {
          requestId: "req-abc",
          rows: [
            {
              id: 1,
              action: "campaign.updated",
              resourceType: "campaign",
              at: "2026-08-04T10:00:00.000Z",
            },
            {
              id: 2,
              action: "approval.decided",
              resourceType: "approval",
              at: "2026-08-04T10:00:00.120Z",
            },
          ],
          truncated: false,
        },
      },
    ]);

    const res = await methods.getAuditChain("req-abc");
    expect(res.error).toBeUndefined();
    expect(res.data?.rows.map((r) => r.action)).toEqual([
      "campaign.updated",
      "approval.decided",
    ]);
  });

  it("returns an empty chain as data, not an error", async () => {
    // A request id that audited nothing is answered 200 with rows: []. Turning
    // that into an error branch would tell the operator the lookup broke.
    const { methods } = createHarness([
      { data: { requestId: "req-nothing", rows: [], truncated: false } },
    ]);

    const res = await methods.getAuditChain("req-nothing");
    expect(res.error).toBeUndefined();
    expect(res.data?.rows).toEqual([]);
  });

  it("surfaces the server's cap flag rather than making callers count to 500", async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      action: `campaign.updated.${index + 1}`,
      resourceType: "campaign",
      at: "2026-08-04T10:00:00.000Z",
    }));
    const { methods } = createHarness([
      { data: { requestId: "r", rows, truncated: true } },
    ]);
    expect((await methods.getAuditChain("r")).data?.truncated).toBe(true);
  });

  it("leaves a transport failure as an error envelope", async () => {
    const failure = {
      error: { kind: "http" as const, status: 500, message: "audit down" },
    };
    const { methods } = createHarness([failure]);
    await expect(methods.getAuditChain("r")).resolves.toEqual(failure);
  });

  it("fails closed on mismatched, out-of-order, impossible, and oversized evidence", async () => {
    const validRow = (id: number) => ({
      id,
      action: `campaign.updated.${id}`,
      resourceType: "campaign",
      at: "2026-08-04T10:00:00Z",
    });
    const { methods } = createHarness([
      { data: { requestId: "different", rows: [], truncated: false } },
      {
        data: {
          requestId: "req-abc",
          rows: [
            {
              id: 2,
              action: "second",
              resourceType: "campaign",
              at: "2026-08-04T10:00:00Z",
            },
            {
              id: 1,
              action: "first",
              resourceType: "campaign",
              at: "2026-08-04T09:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      {
        data: {
          requestId: "req-abc",
          rows: [
            {
              id: 1,
              action: "campaign.updated",
              resourceType: "campaign",
              at: "2026-02-30T00:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      {
        data: {
          requestId: "req-abc",
          rows: Array.from({ length: 501 }, (_, index) => validRow(index + 1)),
          truncated: true,
        },
      },
    ]);

    for (let index = 0; index < 4; index += 1) {
      await expect(methods.getAuditChain("req-abc")).resolves.toMatchObject({
        error: { kind: "parse", code: "invalid_audit_payload" },
      });
    }
  });

  it("rejects invalid request IDs before transport", async () => {
    const { calls, methods } = createHarness();
    await expect(methods.getAuditChain("-")).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
    await expect(methods.getAuditChain("x".repeat(257))).resolves.toMatchObject(
      {
        error: { kind: "parse", code: "invalid_audit_payload" },
      },
    );
    await expect(methods.getAuditChain(" req ")).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
    expect(calls).toEqual([]);
  });
});

describe("auditCorrelationId", () => {
  it("reads the id emit.go stamps under metadata.context", () => {
    expect(
      auditCorrelationId({
        metadata: { context: { correlation_id: "web-01/AbC-7" }, after: {} },
      }),
    ).toBe("web-01/AbC-7");
  });

  it("is null for a row written outside any request", () => {
    // Workers and queue consumers write no correlation id; offering the
    // affordance there would open an empty view every time.
    expect(
      auditCorrelationId({ metadata: { after: { pruned: 4 } } }),
    ).toBeNull();
    expect(auditCorrelationId({ metadata: { context: {} } })).toBeNull();
    expect(auditCorrelationId({ metadata: {} })).toBeNull();
    expect(auditCorrelationId({ metadata: null })).toBeNull();
    expect(auditCorrelationId({})).toBeNull();
  });

  it("is null for the placeholder id the endpoint refuses", () => {
    // audit_chain.go rejects "-" with a validation error; presenting a chain
    // link for it would guarantee a failed request.
    expect(
      auditCorrelationId({ metadata: { context: { correlation_id: "-" } } }),
    ).toBeNull();
    expect(
      auditCorrelationId({ metadata: { context: { correlation_id: "   " } } }),
    ).toBeNull();
  });

  it("is null when the stored value is not a string", () => {
    expect(
      auditCorrelationId({ metadata: { context: { correlation_id: 42 } } }),
    ).toBeNull();
    expect(auditCorrelationId({ metadata: { context: null } })).toBeNull();
  });

  it("trims so the URL matches the stored id", () => {
    expect(
      auditCorrelationId({
        metadata: { context: { correlation_id: " req-1 " } },
      }),
    ).toBe("req-1");
  });
});
