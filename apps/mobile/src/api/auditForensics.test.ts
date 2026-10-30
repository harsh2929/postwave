/**
 * The forensic endpoints at the transport boundary — asserted against exactly
 * what `rawRequest` resolves to (the `{data,error}` ENVELOPE), because that is
 * the seam the parser tests cannot see (the audienceDestinations lesson).
 *
 * Two behaviours here are contracts, not conveniences:
 *  - THE CHAIN ID IS PERCENT-ENCODED. Every real correlation id contains a
 *    literal slash (`host/b64-000001`); unencoded it routes to a different
 *    (nonexistent) path and the feature silently dies.
 *  - INCLUSION-PROOF 425 IS AN ANSWER ("not rooted yet"), never a throw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  auditChainPath,
  fetchAnomalyExplanation,
  fetchAuditChain,
  fetchInclusionProof,
  fetchSessionReplay,
  setAuditRetentionOverride,
  unmaskAuditEvent,
} from "./auditForensics";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
// The real module imports react-native transitively, which node vitest cannot
// parse — so `checkedApiResult` is re-stated here with the contract that
// matters to these tests: an envelope error becomes a rejecting promise
// carrying `.status` and `.code`.
vi.mock("@/api/request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
      data: unknown;
      error: { status: number; message: string; code?: string } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      throw Object.assign(new Error(result.error.message), {
        status: result.error.status,
        ...(result.error.code ? { code: result.error.code } : {}),
      });
    }
    return result;
  },
}));

beforeEach(() => rawRequest.mockReset());

describe("audit chain transport", () => {
  it("percent-encodes the request id — real ids carry a literal slash", () => {
    expect(auditChainPath("host/AbC-000123")).toBe(
      "/api/v1/audit/chain/host%2FAbC-000123",
    );
  });

  it("unwraps the envelope into parsed rows", async () => {
    rawRequest.mockResolvedValue({
      data: {
        requestId: "host/a-1",
        rows: [{ id: 4, action: "auth.login", at: "2026-08-27T00:00:00Z" }],
        truncated: false,
      },
      error: null,
    });
    const chain = await fetchAuditChain("host/a-1");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/audit/chain/host%2Fa-1",
    );
    expect(chain.rows).toHaveLength(1);
    expect(chain.rows[0]?.action).toBe("auth.login");
  });

  it("surfaces a failed lookup as a throw, never as an empty chain", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    await expect(fetchAuditChain("x")).rejects.toMatchObject({ status: 403 });
  });
});

describe("inclusion proof transport", () => {
  it("maps 425 no_checkpoint to the pending answer instead of throwing", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 425, code: "no_checkpoint", message: "not rooted" },
    });
    await expect(fetchInclusionProof(9)).resolves.toEqual({ kind: "pending" });
  });

  it("still throws every other failure with its status attached", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, code: "forbidden", message: "no" },
    });
    await expect(fetchInclusionProof(9)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("parses a proof from the envelope's data", async () => {
    rawRequest.mockResolvedValue({
      data: { leaf_id: 9, audit_path: ["a"], tree_size: 2, root_signature: "s" },
      error: null,
    });
    await expect(fetchInclusionProof(9)).resolves.toMatchObject({
      kind: "proof",
      leafId: 9,
      pathLength: 1,
      signed: true,
    });
  });
});

describe("anomaly + replay lookups", () => {
  it("hands the envelope BODY (not the envelope) to the parser", async () => {
    rawRequest.mockResolvedValue({
      data: { available: true, score: 0.7, bucket: "high", reasons: [] },
      error: null,
    });
    const why = await fetchAnomalyExplanation(12);
    expect(why.available).toBe(true);
    expect(why.bucket).toBe("high");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/audit/12/anomaly-score",
    );
  });

  it("reads the replay answer off the body", async () => {
    rawRequest.mockResolvedValue({
      data: { available: true, replay_url: "https://r.example/1", provider: "p" },
      error: null,
    });
    await expect(fetchSessionReplay(3)).resolves.toMatchObject({
      available: true,
      replayUrl: "https://r.example/1",
    });
  });
});

describe("the two writes", () => {
  it("unmask POSTs the trimmed reason and returns the revealed fields", async () => {
    rawRequest.mockResolvedValue({
      data: { metadata: { email: "a@b.c" }, unmaskedFields: ["email"] },
      error: null,
    });
    const result = await unmaskAuditEvent(5, "  Fraud case #4411  ");
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/audit/5/unmask", {
      reason: "Fraud case #4411",
    });
    expect(result.unmaskedFields).toEqual(["email"]);
  });

  it("retention override PATCHes only the fields it was given", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await setAuditRetentionOverride(5, { legalHold: true });
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/audit/5/retention-override",
      { legal_hold: true },
    );
    await setAuditRetentionOverride(5, { retentionOverrideDays: 365 });
    expect(rawRequest).toHaveBeenLastCalledWith(
      "PATCH",
      "/api/v1/audit/5/retention-override",
      { retention_override_days: 365 },
    );
  });

  it("a refused write rejects with the permission status attached", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "not permitted" },
    });
    await expect(unmaskAuditEvent(5, "Fraud case")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      setAuditRetentionOverride(5, { legalHold: true }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
