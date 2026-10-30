import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(async () => ({ items: [], total: 0 }) as unknown),
}));
vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ client: { request: mocks.request } }),
}));

// eslint-disable-next-line import/first
import {
  dismissSegmentDecayEvent,
  fetchSegmentDecayEvents,
  parseDecayEvent,
  parseDecayEvents,
} from "./segmentDecay";

/** One row exactly as apps/api/internal/segments/decay.go marshals it. */
const WIRE = {
  id: "ev-1",
  tenant_id: "t1",
  segment_id: "seg-1",
  snapshot_date: "2026-08-20",
  anomaly_kind: "size_cliff",
  prior_count: 12480,
  new_count: 1204,
  leaver_count: 11300,
  entrant_count: 24,
  narration: "The clause on last_order_at now excludes most of the audience.",
  created_at: "2026-08-20T03:00:00Z",
};

describe("parseDecayEvent", () => {
  it("reads the wire shape the Go handler emits", () => {
    expect(parseDecayEvent(WIRE)).toEqual({
      id: "ev-1",
      segmentId: "seg-1",
      snapshotDate: "2026-08-20",
      anomalyKind: "size_cliff",
      priorCount: 12480,
      newCount: 1204,
      leaverCount: 11300,
      entrantCount: 24,
      narration:
        "The clause on last_order_at now excludes most of the audience.",
      dismissedAt: null,
      createdAt: "2026-08-20T03:00:00Z",
    });
  });

  it("treats an omitted count as unknown, never as zero", () => {
    // `omitempty` is not on the count fields today, but a card that says
    // "0 members" about a number it never received is a lie the radar cannot
    // afford — this is the audience-size alert.
    const parsed = parseDecayEvent({ id: "ev-2", anomaly_kind: "zero_match" });
    expect(parsed?.priorCount).toBeNull();
    expect(parsed?.newCount).toBeNull();
    expect(parsed?.narration).toBe("");
  });

  it("rejects a row with no id", () => {
    expect(parseDecayEvent({ anomaly_kind: "size_cliff" })).toBeNull();
    expect(parseDecayEvent(null)).toBeNull();
    expect(parseDecayEvent([WIRE])).toBeNull();
  });
});

describe("parseDecayEvents", () => {
  it("reads the {items} envelope the handler writes", () => {
    expect(parseDecayEvents({ items: [WIRE], total: 1 })).toHaveLength(1);
  });

  it("also reads a bare array, so an envelope change can't blank the card", () => {
    expect(parseDecayEvents([WIRE])).toHaveLength(1);
  });

  it("returns nothing for a shape it does not recognise", () => {
    expect(parseDecayEvents(undefined)).toEqual([]);
    expect(parseDecayEvents({ data: [WIRE] })).toEqual([]);
  });
});

describe("decay transport", () => {
  it("asks only for undismissed events when the card asks it to", async () => {
    mocks.request.mockResolvedValueOnce({ items: [WIRE], total: 1 });
    await fetchSegmentDecayEvents("seg 1", { undismissed: true, limit: 5 });
    expect(mocks.request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/segments/seg%201/decay-events?limit=5&undismissed=true",
    );
  });

  it("posts the dismiss with both ids encoded", async () => {
    mocks.request.mockResolvedValueOnce({ dismissed: true });
    await dismissSegmentDecayEvent("seg/1", "ev 1");
    expect(mocks.request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/segments/seg%2F1/decay-events/ev%201/dismiss",
    );
  });
});
