// SPDX-License-Identifier: AGPL-3.0-only
//
// ECO-22: the audit-chain client hits the mounted route
// (apps/api/internal/handlers/audit_chain.go), encodes the request id, and
// passes the {requestId, rows, truncated} envelope through unchanged —
// including the empty chain, which the server returns as 200, not an error.
//
// `correlationIdOf` is the link that was missing entirely: audit rows have
// carried metadata.context.correlation_id since emit.go stamped it, and no
// client read it.

import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: apiGet } };
});

import {
  correlationIdOf,
  getAuditChain,
  isTraceableRequestId,
} from "@/lib/audit-api";

afterEach(() => vi.clearAllMocks());

describe("getAuditChain", () => {
  it("gets the mounted chain route for the request id", async () => {
    apiGet.mockResolvedValue({ requestId: "req-abc", rows: [], truncated: false });
    await getAuditChain("req-abc");
    expect(apiGet).toHaveBeenCalledWith("/api/v1/audit/chain/req-abc", {});
  });

  it("encodes a chi request id so its host segment stays one path segment", async () => {
    // chi mints ids shaped `host/random-N`; an unencoded slash would split into
    // an extra path segment and miss the route entirely.
    apiGet.mockResolvedValue({ requestId: "web-01/AbC-7", rows: [], truncated: false });
    await getAuditChain("web-01/AbC-7");
    expect(apiGet).toHaveBeenCalledWith(
      "/api/v1/audit/chain/web-01%2FAbC-7",
      {},
    );
  });

  it("forwards an abort signal", async () => {
    apiGet.mockResolvedValue({ requestId: "r", rows: [], truncated: false });
    const controller = new AbortController();
    await getAuditChain("r", { signal: controller.signal });
    expect(apiGet).toHaveBeenCalledWith("/api/v1/audit/chain/r", {
      signal: controller.signal,
    });
  });

  it("passes the envelope through in the ascending order the server sent", async () => {
    apiGet.mockResolvedValue({
      requestId: "req-abc",
      rows: [
        { id: 1, action: "campaign.updated", resourceType: "campaign", at: "2026-08-04T10:00:00.000Z" },
        { id: 2, action: "approval.decided", resourceType: "approval", at: "2026-08-04T10:00:00.120Z" },
      ],
      truncated: false,
    });
    const chain = await getAuditChain("req-abc");
    expect(chain.requestId).toBe("req-abc");
    expect(chain.rows.map((r) => r.action)).toEqual([
      "campaign.updated",
      "approval.decided",
    ]);
    expect(chain.truncated).toBe(false);
  });

  it("returns an empty chain as data, not an error", async () => {
    // A request id that audited nothing is answered 200 with rows: []. The
    // client must not turn that into a rejection.
    apiGet.mockResolvedValue({
      requestId: "req-nothing",
      rows: [],
      truncated: false,
    });
    const chain = await getAuditChain("req-nothing");
    expect(chain.rows).toEqual([]);
  });

  it("surfaces the server's cap flag rather than making callers count to 500", async () => {
    apiGet.mockResolvedValue({ requestId: "r", rows: [], truncated: true });
    expect((await getAuditChain("r")).truncated).toBe(true);
  });
});

describe("correlationIdOf", () => {
  it("reads the id emit.go stamps under metadata.context", () => {
    expect(
      correlationIdOf({
        metadata: { context: { correlation_id: "web-01/AbC-7" }, after: {} },
      }),
    ).toBe("web-01/AbC-7");
  });

  it("is null for a row written outside any request", () => {
    // Workers and queue consumers write no correlation id; offering the
    // affordance there would open an empty screen every time.
    expect(correlationIdOf({ metadata: { after: { pruned: 4 } } })).toBeNull();
    expect(correlationIdOf({ metadata: { context: {} } })).toBeNull();
    expect(correlationIdOf({ metadata: {} })).toBeNull();
    expect(correlationIdOf({ metadata: undefined })).toBeNull();
  });

  it("is null for the placeholder id the endpoint refuses", () => {
    // audit_chain.go rejects "-" with a validation error; presenting a chain
    // link for it would guarantee a failed request.
    expect(
      correlationIdOf({ metadata: { context: { correlation_id: "-" } } }),
    ).toBeNull();
    expect(
      correlationIdOf({ metadata: { context: { correlation_id: "   " } } }),
    ).toBeNull();
  });

  it("is null when the stored value is not a string", () => {
    expect(
      correlationIdOf({ metadata: { context: { correlation_id: 42 } } }),
    ).toBeNull();
    expect(
      correlationIdOf({ metadata: { context: null } }),
    ).toBeNull();
  });

  it("trims surrounding whitespace so the URL matches the stored id", () => {
    expect(
      correlationIdOf({ metadata: { context: { correlation_id: " req-1 " } } }),
    ).toBe("req-1");
  });
});

describe("isTraceableRequestId", () => {
  // The two values the server answers with a 422. Refusing them before the
  // dialog opens matters more than it looks: an empty chain renders as "this
  // request touched nothing", so sending a value that can only fail turns a
  // refusal into a confident wrong answer.
  it("refuses the empty string and whitespace", () => {
    expect(isTraceableRequestId("")).toBe(false);
    expect(isTraceableRequestId("   ")).toBe(false);
  });

  it("refuses the '-' sentinel audit.Emit writes for 'no correlation'", () => {
    expect(isTraceableRequestId("-")).toBe(false);
    expect(isTraceableRequestId("  -  ")).toBe(false);
  });

  it("accepts a real chi request id, slash and all", () => {
    expect(isTraceableRequestId("postwave-api-7c9f/lF3kQ2xTvB-000042")).toBe(true);
  });

  it("accepts an id that merely contains a dash", () => {
    // Guarding on `includes("-")` rather than equality would reject every real
    // id, since chi's format ends in "-000042".
    expect(isTraceableRequestId("web-01/AbC-7")).toBe(true);
  });
});
