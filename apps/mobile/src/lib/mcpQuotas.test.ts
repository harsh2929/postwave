import { describe, expect, it } from "vitest";

import {
  MCP_QUOTAS_INVALID_ENTRY,
  MCP_QUOTAS_MALFORMED,
  MCP_QUOTAS_WRONG_WORKSPACE,
  mcpQuotaCostUnits,
  mcpQuotaReading,
  mcpQuotaResetAt,
  mcpQuotaServerStance,
  mcpQuotaSummary,
  normalizeMcpQuotas,
  safeMcpQuotaToolName,
} from "@/lib/mcpQuotas";

/**
 * Pins the four server facts at the top of lib/mcpQuotas.ts. Each `it` is a
 * place where the obvious render would promise something the server never
 * said: that a full bar blocks the next call, that a missing threshold means
 * "unlimited", or that a well-formed payload is this workspace's.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";

function wire(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    quotas: [
      {
        toolName: "subscribers_list",
        dailyLimit: 50,
        estimatedCostMicros: 0,
        usedToday: 12,
      },
      {
        toolName: "campaign_send",
        estimatedCostMicros: 2_500_000,
        usedToday: 3,
      },
    ],
    enforcementMode: "advisory_unverified",
    authoritative: false,
    releaseHold: "mcp_quota_enforcement_release_held",
    ...over,
  };
}

describe("normalizeMcpQuotas", () => {
  it("keeps the server's stance verbatim and never invents authority", () => {
    const parsed = normalizeMcpQuotas(wire(), TENANT);
    expect(parsed.error).toBeNull();
    expect(parsed.snapshot?.enforcementMode).toBe("advisory_unverified");
    expect(parsed.snapshot?.releaseHold).toBe(
      "mcp_quota_enforcement_release_held",
    );
    expect(parsed.snapshot?.authoritative).toBe(false);
    // A missing or non-boolean flag is NOT authority.
    expect(
      normalizeMcpQuotas(wire({ authoritative: "true" }), TENANT).snapshot
        ?.authoritative,
    ).toBe(false);
    expect(
      normalizeMcpQuotas(wire({ authoritative: undefined }), TENANT).snapshot
        ?.authoritative,
    ).toBe(false);
  });

  it("carries a missing dailyLimit as null, not as zero and not as unlimited", () => {
    const parsed = normalizeMcpQuotas(wire(), TENANT);
    expect(parsed.snapshot?.quotas[1]?.dailyLimit).toBeNull();
    expect(
      normalizeMcpQuotas(
        wire({
          quotas: [
            {
              toolName: "x_tool",
              dailyLimit: null,
              estimatedCostMicros: 0,
              usedToday: 0,
            },
          ],
        }),
        TENANT,
      ).snapshot?.quotas[0]?.dailyLimit,
    ).toBeNull();
  });

  it("refuses a response from a different workspace", () => {
    expect(normalizeMcpQuotas(wire(), "22222222-2222-4222-8222-222222222222")).toEqual({
      snapshot: null,
      error: MCP_QUOTAS_WRONG_WORKSPACE,
    });
    // No expectation → no check; the caller may not know its tenant yet.
    expect(normalizeMcpQuotas(wire(), null).error).toBeNull();
  });

  it("refuses the whole response on one bad row rather than dropping it", () => {
    const cases: unknown[] = [
      { toolName: "", dailyLimit: 1, estimatedCostMicros: 0, usedToday: 0 },
      { toolName: "1234567", dailyLimit: 1, estimatedCostMicros: 0, usedToday: 0 },
      {
        toolName: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
        dailyLimit: 1,
        estimatedCostMicros: 0,
        usedToday: 0,
      },
      { toolName: "ok_tool", dailyLimit: 0, estimatedCostMicros: 0, usedToday: 0 },
      { toolName: "ok_tool", dailyLimit: -5, estimatedCostMicros: 0, usedToday: 0 },
      { toolName: "ok_tool", dailyLimit: 1.5, estimatedCostMicros: 0, usedToday: 0 },
      { toolName: "ok_tool", dailyLimit: 5, estimatedCostMicros: 0, usedToday: -1 },
      { toolName: "ok_tool", dailyLimit: 5, estimatedCostMicros: "0", usedToday: 0 },
      "not an object",
    ];
    for (const bad of cases) {
      expect(normalizeMcpQuotas(wire({ quotas: [bad] }), TENANT)).toEqual({
        snapshot: null,
        error: MCP_QUOTAS_INVALID_ENTRY,
      });
    }
  });

  it("refuses a duplicated tool name", () => {
    const row = { toolName: "dup", dailyLimit: 5, estimatedCostMicros: 0, usedToday: 0 };
    expect(normalizeMcpQuotas(wire({ quotas: [row, { ...row }] }), TENANT).error).toBe(
      MCP_QUOTAS_INVALID_ENTRY,
    );
  });

  it("refuses a malformed envelope", () => {
    for (const bad of [null, [], "x", { quotas: [] }, { tenantId: TENANT }, { tenantId: "", quotas: [] }]) {
      expect(normalizeMcpQuotas(bad, TENANT)).toEqual({
        snapshot: null,
        error: MCP_QUOTAS_MALFORMED,
      });
    }
  });

  it("accepts an empty list — that is a real answer, not a malformed one", () => {
    const parsed = normalizeMcpQuotas(wire({ quotas: [] }), TENANT);
    expect(parsed.error).toBeNull();
    expect(parsed.snapshot?.quotas).toEqual([]);
  });
});

describe("safeMcpQuotaToolName", () => {
  it("mirrors the server's safeToolLabel", () => {
    expect(safeMcpQuotaToolName("subscribers_list")).toBe("subscribers_list");
    expect(safeMcpQuotaToolName("  campaign.send:v2  ")).toBe("campaign.send:v2");
    expect(safeMcpQuotaToolName("9lives")).toBe("");
    expect(safeMcpQuotaToolName("a".repeat(97))).toBe("");
    expect(safeMcpQuotaToolName("t1234")).toBe("");
    expect(safeMcpQuotaToolName(42)).toBe("");
  });
});

describe("mcpQuotaReading", () => {
  it("uses the desktop's 70/90 tone boundaries", () => {
    const at = (usedToday: number) =>
      mcpQuotaReading({ toolName: "t", dailyLimit: 100, estimatedCostMicros: 0, usedToday });
    expect(at(69).tone).toBe("success");
    expect(at(70).tone).toBe("warning");
    expect(at(89).tone).toBe("warning");
    expect(at(90).tone).toBe("danger");
    expect(at(150).tone).toBe("danger");
  });

  it("clamps the bar but not the percentage, and states an overage", () => {
    const reading = mcpQuotaReading({
      toolName: "t",
      dailyLimit: 40,
      estimatedCostMicros: 0,
      usedToday: 50,
    });
    expect(reading.fraction).toBe(1);
    expect(reading.utilization).toBe(125);
    expect(reading.remaining).toBe(0);
    expect(reading.overage).toBe(10);
    expect(reading.headline).toBe("50 used / 40 configured threshold");
    expect(reading.standing).toBe("125.0% · above or near threshold");
    expect(reading.distance).toBe(
      "10 observed calls above the configured threshold",
    );
  });

  it("says how far the threshold is, and that distance is not a promise", () => {
    const reading = mcpQuotaReading({
      toolName: "t",
      dailyLimit: 50,
      estimatedCostMicros: 0,
      usedToday: 12,
    });
    expect(reading.standing).toBe("24.0% · below configured threshold");
    expect(reading.distance).toBe(
      "38 calls until the configured threshold (not an enforcement promise)",
    );
  });

  it("renders no bar and no percentage for a row without a threshold", () => {
    const reading = mcpQuotaReading({
      toolName: "t",
      dailyLimit: null,
      estimatedCostMicros: 0,
      usedToday: 7,
    });
    expect(reading.fraction).toBeNull();
    expect(reading.utilization).toBeNull();
    expect(reading.tone).toBe("neutral");
    expect(reading.headline).toBe("7 used · no configured threshold row");
    expect(reading.standing).toBe("");
    expect(reading.distance).toBe("No daily threshold represented");
    expect(reading.distance).not.toMatch(/unlimited/i);
  });
});

describe("sentences", () => {
  it("resets at the next UTC midnight", () => {
    expect(mcpQuotaResetAt(Date.UTC(2026, 6, 25, 3, 0, 0))).toBe(
      "2026-07-26T00:00:00.000Z",
    );
    expect(mcpQuotaResetAt(Date.UTC(2026, 6, 25, 23, 59, 59))).toBe(
      "2026-07-26T00:00:00.000Z",
    );
  });

  it("converts micros to units and words the summary as the desktop does", () => {
    expect(mcpQuotaCostUnits(2_500_000)).toBe(2.5);
    expect(mcpQuotaSummary(2)).toBe(
      "2 configured per-tool quota observations. Best-effort usage is counted from 00:00 UTC; cost values are configured estimates per call and are not billing receipts.",
    );
  });

  it("names absent stance fields as absent instead of filling them in", () => {
    const parsed = normalizeMcpQuotas(wire(), TENANT);
    expect(mcpQuotaServerStance(parsed.snapshot!)).toBe(
      "enforcement advisory_unverified · not authoritative · hold mcp_quota_enforcement_release_held",
    );
    const bare = normalizeMcpQuotas(
      wire({ enforcementMode: undefined, releaseHold: undefined }),
      TENANT,
    );
    expect(mcpQuotaServerStance(bare.snapshot!)).toBe(
      "enforcement unstated · not authoritative · hold none stated",
    );
  });
});
