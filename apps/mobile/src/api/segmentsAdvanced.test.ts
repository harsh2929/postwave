/**
 * The segment evidence panels at the transport seam: exact server bodies
 * in, typed rows out; failures throw; the snapshot write POSTs the mint
 * path (and is press-driven at the call site — never prefetched).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSegmentSnapshot,
  fetchSegmentDefinitionHistory,
  fetchSegmentGrowthReport,
  fetchSegmentSnapshots,
  fetchSegmentUsage,
} from "./segmentsAdvanced";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("segment advanced reads", () => {
  it("parses snapshots (snapshots.go Snapshot projection)", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          {
            id: "snap-1",
            tenant_id: "t",
            segment_id: "s1",
            query_ast: {},
            count: 412,
            sample_size: 400,
            evaluator_version: "v3",
            evaluated_at: "2026-08-20T10:00:00Z",
            created_at: "2026-08-20T10:00:00Z",
          },
        ],
      },
      error: null,
    });
    const rows = await fetchSegmentSnapshots("s1");
    expect(rows).toEqual([
      {
        id: "snap-1",
        count: 412,
        sampleSize: 400,
        evaluatorVersion: "v3",
        evaluatedAt: "2026-08-20T10:00:00Z",
      },
    ]);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/segments/s1/snapshots",
    );
  });

  it("parses definition history (decay.go DefinitionHistoryEntry)", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          {
            audit_id: 991,
            at: "2026-08-19T08:00:00Z",
            actor_label: "ana@acme.com",
            action: "segment.update",
            before: {},
            after: {},
          },
        ],
      },
      error: null,
    });
    const rows = await fetchSegmentDefinitionHistory("s1");
    expect(rows).toEqual([
      {
        auditId: "991",
        at: "2026-08-19T08:00:00Z",
        actorLabel: "ana@acme.com",
        action: "segment.update",
      },
    ]);
  });

  it("parses usage ({items,count} — usage.go)", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          { kind: "campaign", id: "c1", name: "August promo", status: "sent" },
        ],
        count: 1,
      },
      error: null,
    });
    await expect(fetchSegmentUsage("s1")).resolves.toEqual([
      { kind: "campaign", id: "c1", name: "August promo", status: "sent" },
    ]);
  });

  it("parses the growth report and keeps the server's honesty note", async () => {
    rawRequest.mockResolvedValue({
      data: {
        segment_id: "s1",
        days: 30,
        series: [{ date: "2026-08-01", count: 100 }],
        anomalies: [{ date: "2026-08-14", anomaly_kind: "size_cliff" }],
        total_adds: 40,
        total_drops: 55,
        net_delta: -15,
        net_pct: -13.2,
        note: "sparse snapshot coverage",
      },
      error: null,
    });
    await expect(fetchSegmentGrowthReport("s1", 30)).resolves.toEqual({
      days: 30,
      totalAdds: 40,
      totalDrops: 55,
      netDelta: -15,
      netPct: -13.2,
      anomalyCount: 1,
      note: "sparse snapshot coverage",
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/segments/s1/growth/report?days=30",
    );
  });

  it.each([
    ["fetchSegmentSnapshots", () => fetchSegmentSnapshots("s1")],
    ["fetchSegmentUsage", () => fetchSegmentUsage("s1")],
    ["fetchSegmentDefinitionHistory", () => fetchSegmentDefinitionHistory("s1")],
  ])("surfaces a failed %s", async (_n, call) => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "boom", status: 500 },
    });
    await expect(call()).rejects.toMatchObject({ status: 500 });
  });
});

describe("createSegmentSnapshot", () => {
  it("POSTs the mint path and returns the created snapshot", async () => {
    rawRequest.mockResolvedValue({
      data: {
        id: "snap-2",
        segment_id: "s1",
        count: 9,
        sample_size: 9,
        evaluator_version: "v3",
        evaluated_at: "2026-08-27T10:00:00Z",
        created_at: "2026-08-27T10:00:00Z",
      },
      error: null,
    });
    const snap = await createSegmentSnapshot("s1");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/segments/s1/snapshot",
    );
    expect(snap).toMatchObject({ id: "snap-2", count: 9 });
  });

  it("surfaces a refused snapshot", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(createSegmentSnapshot("s1")).rejects.toMatchObject({
      status: 403,
    });
  });
});
