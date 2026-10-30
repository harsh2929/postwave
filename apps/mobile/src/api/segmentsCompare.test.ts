/**
 * Compare reads at the transport seam, plus the pure selection policy that
 * keeps the sheet from firing requests the server is documented to 400.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSegmentOverlap, fetchSegmentPnlCompare } from "./segmentsCompare";
import { deleteSegment } from "./segmentsManage";
import {
  compareSelection,
  formatCents,
  parseSegmentPnlCompare,
} from "@/lib/segmentCompareRows";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("fetchSegmentOverlap", () => {
  it("parses the overlap body apps/api writes (overlap.go)", async () => {
    rawRequest.mockResolvedValue({
      data: {
        a: "s1",
        b: "s2",
        a_count: 120,
        b_count: 80,
        intersection: 30,
        jaccard: 0.176,
      },
      error: null,
    });
    const out = await fetchSegmentOverlap("s1", "s2");
    expect(out).toEqual({
      aCount: 120,
      bCount: 80,
      intersection: 30,
      jaccard: 0.176,
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/segments/overlap?a=s1&b=s2",
    );
  });

  it("surfaces a failed read instead of a zero overlap", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "same_segment", status: 400 },
    });
    await expect(fetchSegmentOverlap("s1", "s1")).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("fetchSegmentPnlCompare", () => {
  it("parses the compare items and keeps a missing net as null, not 0", async () => {
    rawRequest.mockResolvedValue({
      data: {
        window_days: 30,
        days: 30,
        items: [
          {
            segment_id: "s1",
            member_count: 500,
            revenue_cents: 123400,
            revenue_conversions: 12,
            currency: "USD",
            unsub_count: 3,
            complaint_count: 0,
            net_contribution_cents: 90000,
            window_days: 30,
          },
          {
            segment_id: "s2",
            member_count: 200,
            revenue_cents: 0,
            revenue_conversions: 0,
            currency: "",
            unsub_count: 1,
            complaint_count: 0,
            window_days: 30,
          },
        ],
      },
      error: null,
    });
    const rows = await fetchSegmentPnlCompare(["s1", "s2"], 30);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.netContributionCents).toBe(90000);
    // No cost config ⇒ null. Rendering this as $0.00 would be a false claim.
    expect(rows[1]?.netContributionCents).toBeNull();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/segments/pnl/compare?ids=s1%2Cs2&days=30",
    );
  });
});

describe("deleteSegment", () => {
  it("DELETEs the segment and surfaces failures", async () => {
    rawRequest.mockResolvedValue({ data: null, error: null });
    await deleteSegment("s/1");
    expect(rawRequest).toHaveBeenCalledWith("DELETE", "/api/v1/segments/s%2F1");
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(deleteSegment("s1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("compareSelection (server bounds: 2..5 ids, overlap is pairwise)", () => {
  it("gates compare below two and above five, overlap at exactly two", () => {
    expect(compareSelection(["a"])).toEqual({
      canAddMore: true,
      canCompare: false,
      canOverlap: false,
    });
    expect(compareSelection(["a", "b"])).toEqual({
      canAddMore: true,
      canCompare: true,
      canOverlap: true,
    });
    expect(compareSelection(["a", "b", "c", "d", "e"])).toMatchObject({
      canAddMore: false,
      canCompare: true,
      canOverlap: false,
    });
    expect(
      compareSelection(["a", "b", "c", "d", "e", "f"]).canCompare,
    ).toBe(false);
  });
});

describe("formatCents", () => {
  it("renders integer cents as currency units", () => {
    expect(formatCents(123400, "")).toBe("1234.00");
    expect(formatCents(123400, "USD")).toContain("1,234");
  });
});

describe("parseSegmentPnlCompare shape honesty", () => {
  it("returns [] for a malformed body rather than throwing mid-render", () => {
    expect(parseSegmentPnlCompare({ items: "nope" })).toEqual([]);
    expect(parseSegmentPnlCompare(null)).toEqual([]);
  });
});
