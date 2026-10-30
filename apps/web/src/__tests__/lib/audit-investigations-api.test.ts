// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-34..37: the investigation client hits the mounted routes
// (apps/api/internal/handlers/audit_investigations.go) with the bodies the
// handlers decode — approve `{notes}`, reject `{reason}` — refuses a blank
// rejection reason before any request leaves, chunks the evidence lookup at
// the server's 100-id ceiling, carries a stream token on the allowlisted
// stream path, and turns the agent's empty-message 503 into a sentence.

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  mintStreamToken: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});

vi.mock("@/lib/alerting-access-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerting-access-api")>()),
  mintStreamToken: mocks.mintStreamToken,
}));

import { ApiError } from "@/lib/api";
import {
  INVESTIGATION_AGENT_UNAVAILABLE,
  REJECTION_REASON_REQUIRED,
  approveAuditInvestigation,
  auditInvestigationStreamUrl,
  chunkEvidenceIds,
  describeInvestigationError,
  getAuditEventsByIds,
  getAuditInvestigation,
  listAuditInvestigations,
  rejectAuditInvestigation,
  rejectionReasonError,
} from "@/lib/audit-investigations-api";

const ONLINE_WRITE = { requireOnline: true, maxAttempts: 1 };

function investigation(patch: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    seed_audit_id: 42,
    findings: [],
    evidence_audit_ids: [],
    proposed_actions: [],
    mitre_techniques: [],
    confidence: 0.8,
    status: "draft",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    ...patch,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

afterEach(() => vi.clearAllMocks());

describe("listAuditInvestigations", () => {
  it("gets the mounted list route with the 50-row limit", async () => {
    mocks.apiGet.mockResolvedValue({ investigations: [investigation()] });
    const rows = await listAuditInvestigations();
    expect(mocks.apiGet).toHaveBeenCalledWith(
      "/api/v1/audit/investigations?limit=50",
      {},
    );
    expect(rows.map((row) => row.id)).toEqual(["inv-1"]);
  });

  it("passes a status filter and an abort signal through", async () => {
    mocks.apiGet.mockResolvedValue({ investigations: [] });
    const controller = new AbortController();
    await listAuditInvestigations(
      { status: "draft" },
      { signal: controller.signal },
    );
    expect(mocks.apiGet).toHaveBeenCalledWith(
      "/api/v1/audit/investigations?limit=50&status=draft",
      { signal: controller.signal },
    );
  });

  it("normalises Go's null slices so every list can be counted", async () => {
    mocks.apiGet.mockResolvedValue({
      investigations: [
        investigation({
          findings: null,
          proposed_actions: null,
          evidence_audit_ids: null,
          mitre_techniques: null,
        }),
      ],
    });
    const [row] = await listAuditInvestigations();
    expect(row?.findings).toEqual([]);
    expect(row?.proposed_actions).toEqual([]);
    expect(row?.evidence_audit_ids).toEqual([]);
    expect(row?.mitre_techniques).toEqual([]);
  });

  it("refuses a body that is not an investigation list", async () => {
    mocks.apiGet.mockResolvedValue({ items: [] });
    await expect(listAuditInvestigations()).rejects.toThrow(/invalid/u);
  });

  it("refuses an item with an unknown status rather than rendering it", async () => {
    mocks.apiGet.mockResolvedValue({
      investigations: [investigation({ status: "pending" })],
    });
    await expect(listAuditInvestigations()).rejects.toThrow(/invalid/u);
  });
});

describe("getAuditInvestigation", () => {
  it("encodes the id into the mounted detail route", async () => {
    mocks.apiGet.mockResolvedValue(investigation({ id: "inv/1" }));
    await getAuditInvestigation("inv/1");
    expect(mocks.apiGet).toHaveBeenCalledWith(
      "/api/v1/audit/investigations/inv%2F1",
      {},
    );
  });
});

describe("approveAuditInvestigation", () => {
  it("posts the whole-plan approval body to the admin route, online-only and single-attempt", async () => {
    mocks.apiPost.mockResolvedValue({
      id: "inv-1",
      status: "approved",
      execution_state: "not_executed",
      message: "Remediation plan approved for manual or external execution.",
    });
    const receipt = await approveAuditInvestigation("inv-1");
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/api/v1/audit/investigations/inv-1/approve",
      { notes: "" },
      ONLINE_WRITE,
    );
    expect(receipt.execution_state).toBe("not_executed");
  });

  it("trims optional notes into the body", async () => {
    mocks.apiPost.mockResolvedValue({ id: "inv-1", status: "approved" });
    await approveAuditInvestigation("inv-1", { notes: "  reviewed  " });
    expect(mocks.apiPost.mock.calls[0]?.[1]).toEqual({ notes: "reviewed" });
  });
});

describe("rejectAuditInvestigation", () => {
  it("names the blank-reason rule the dialog shows inline", () => {
    expect(rejectionReasonError("   ")).toBe(REJECTION_REASON_REQUIRED);
    expect(rejectionReasonError("false positive")).toBeNull();
  });

  it("refuses a blank reason before any request leaves", async () => {
    await expect(rejectAuditInvestigation("inv-1", "   ")).rejects.toThrow(
      REJECTION_REASON_REQUIRED,
    );
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("posts the trimmed reason to the admin route, online-only and single-attempt", async () => {
    mocks.apiPost.mockResolvedValue({ id: "inv-1", status: "rejected" });
    await rejectAuditInvestigation("inv-1", "  confirmed false positive  ");
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/api/v1/audit/investigations/inv-1/reject",
      { reason: "confirmed false positive" },
      ONLINE_WRITE,
    );
  });
});

describe("evidence lookup", () => {
  it("chunks a deduplicated id list at the server's 100-id ceiling", () => {
    const chunks = chunkEvidenceIds([...range(1, 150), 1, 2, 150]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 50]);
    expect(chunks[0]?.[0]).toBe(1);
    expect(chunks[0]?.[99]).toBe(100);
    expect(chunks[1]?.[49]).toBe(150);
  });

  it("gets the batch route with the ids comma-joined and returns the rows", async () => {
    mocks.apiGet.mockResolvedValue({
      items: [{ id: 2, action: "auth.login", at: "2026-09-01T10:00:00Z" }],
    });
    const rows = await getAuditEventsByIds([1, 2, 3]);
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(mocks.apiGet.mock.calls[0]?.[0] as string)).toBe(
      "/api/v1/audit/events?ids=1,2,3",
    );
    expect(rows.map((row) => row.id)).toEqual([2]);
  });

  it("sends nothing for an empty id list and refuses a batch over the ceiling", async () => {
    await expect(getAuditEventsByIds([])).resolves.toEqual([]);
    await expect(getAuditEventsByIds(range(1, 101))).rejects.toThrow(
      /at most 100/u,
    );
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });
});

describe("auditInvestigationStreamUrl", () => {
  it("carries a freshly minted stream token on the allowlisted stream path", async () => {
    mocks.mintStreamToken.mockResolvedValue({
      token: "pws_abc",
      expiresAt: "2026-09-01T10:01:00.000Z",
      ttlSeconds: 30,
    });
    await expect(auditInvestigationStreamUrl("inv-1")).resolves.toBe(
      "/api/v1/audit/investigations/inv-1/stream?stream_token=pws_abc",
    );
  });

  it("falls back to the cookie-authenticated path when no token can be minted", async () => {
    mocks.mintStreamToken.mockRejectedValue(new Error("forbidden"));
    await expect(auditInvestigationStreamUrl("inv-1")).resolves.toBe(
      "/api/v1/audit/investigations/inv-1/stream",
    );
  });
});

describe("describeInvestigationError", () => {
  it("renders the server's sentence when the agent refusal carries one", () => {
    const err = new ApiError(
      "investigation agent not configured",
      503,
      {
        error: {
          code: "agent_unavailable",
          message: "investigation agent not configured",
        },
      },
      { code: "agent_unavailable" },
    );
    expect(describeInvestigationError(err, "fallback")).toBe(
      "investigation agent not configured",
    );
  });

  it("explains the empty-message 503 the list and get handlers send", () => {
    const err = new ApiError(
      "GET /api/v1/audit/investigations?limit=50 failed: 503 Service Unavailable",
      503,
      { error: { code: "agent_unavailable", message: "" } },
      { code: "agent_unavailable" },
    );
    expect(describeInvestigationError(err, "fallback")).toBe(
      INVESTIGATION_AGENT_UNAVAILABLE,
    );
  });

  it("otherwise renders the error's own message", () => {
    expect(describeInvestigationError(new Error("boom"), "fallback")).toBe(
      "boom",
    );
    expect(describeInvestigationError("nope", "fallback")).toBe("fallback");
  });
});
