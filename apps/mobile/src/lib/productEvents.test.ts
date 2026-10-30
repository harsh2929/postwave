import { describe, expect, it } from "vitest";

import {
  normalizeProductEventCatalog,
  normalizeProductEventSample,
  normalizeProductEventStats,
} from "@/lib/productEvents";

/**
 * These tests pin the boundary between "the workspace has no product events"
 * and "this app could not read the answer". Getting that wrong on a MONITOR is
 * the worst possible failure: a parser that swallows a shape drift reports
 * silence, and silence is exactly the signal the operator is looking for.
 */
const CATALOG = {
  items: [
    {
      eventName: "order.placed",
      count: 4821,
      uniqueSubscribers: 990,
      firstSeen: "2026-06-26T00:00:00Z",
      lastSeen: "2026-07-25T22:10:00Z",
      daily: [
        { date: "2026-07-19", count: 140 },
        { date: "2026-07-20", count: 0 },
      ],
    },
  ],
  totalDistinctEventNames: 14,
  periodDays: 30,
  dailySeriesPeriodDays: 7,
  eventBoundsScope: "period",
  timeZone: "UTC",
  asOf: "2026-07-26T00:00:00Z",
};

describe("normalizeProductEventCatalog", () => {
  it("carries every field the row policy depends on", () => {
    const catalog = normalizeProductEventCatalog(CATALOG);
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]?.lastSeen).toBe("2026-07-25T22:10:00Z");
    expect(catalog.items[0]?.daily).toEqual([
      { date: "2026-07-19", count: 140 },
      // A densified bucket of 0 is a MEASURED zero and must survive as one —
      // the server fills every day in the window (densifyUTCDailyBuckets).
      { date: "2026-07-20", count: 0 },
    ]);
    expect(catalog.eventBoundsScope).toBe("period");
    expect(catalog.asOf).toBe("2026-07-26T00:00:00Z");
  });

  it("THROWS rather than reporting an empty workspace for an unreadable shape", () => {
    // Both of these would render as "No events in this window" if they were
    // normalized to `{ items: [] }` — a claim about the workspace made on the
    // strength of a parser miss.
    expect(() => normalizeProductEventCatalog(null)).toThrow(/can't read/);
    expect(() => normalizeProductEventCatalog({ items: "nope" })).toThrow(
      /can't read/,
    );
  });

  it("drops a row with no event name instead of rendering a blank line", () => {
    const catalog = normalizeProductEventCatalog({
      ...CATALOG,
      items: [...CATALOG.items, { count: 3 }],
    });
    expect(catalog.items.map((row) => row.eventName)).toEqual(["order.placed"]);
  });

  it("floors the distinct-name total at the number of rows received", () => {
    // Otherwise the truncation note reads backwards: "showing the 1 busiest of
    // 0 event names".
    const catalog = normalizeProductEventCatalog({
      ...CATALOG,
      totalDistinctEventNames: 0,
    });
    expect(catalog.totalDistinctEventNames).toBe(1);
  });

  it("keeps an absent timestamp absent rather than inventing an epoch", () => {
    const catalog = normalizeProductEventCatalog({
      ...CATALOG,
      items: [{ ...CATALOG.items[0], lastSeen: null }],
    });
    expect(catalog.items[0]?.lastSeen).toBe("");
  });
});

describe("normalizeProductEventStats", () => {
  it("keeps a measured zero as a zero", () => {
    const stats = normalizeProductEventStats({
      periodDays: 7,
      totalEvents: 0,
      uniqueSubscribers: 0,
      uniqueEventNames: 0,
      daily: [{ date: "2026-07-20", count: 0 }],
      timeZone: "UTC",
      asOf: "2026-07-26T00:00:00Z",
    });
    // COUNT(*) over an empty window IS zero — this is the one place on the
    // surface where 0 is a fact rather than an absence.
    expect(stats.totalEvents).toBe(0);
    expect(stats.daily).toEqual([{ date: "2026-07-20", count: 0 }]);
  });

  it("throws when the daily series is missing", () => {
    expect(() => normalizeProductEventStats({ totalEvents: 5 })).toThrow(
      /can't read/,
    );
  });
});

describe("normalizeProductEventSample", () => {
  const ROW = {
    id: 90071992547409911,
    tenantId: "t-1",
    subscriberId: "sub-abc",
    eventName: "order.placed",
    properties: { total: 1299, currency: "EUR", order_id: "A-1" },
    occurredAt: "2026-07-25T22:10:00Z",
    receivedAt: "2026-07-25T22:10:02Z",
  };

  it("sorts property keys and preserves the untouched row for the clipboard", () => {
    const sample = normalizeProductEventSample({ items: [ROW] }, 20);
    expect(sample.items[0]?.propertyKeys).toEqual([
      "currency",
      "order_id",
      "total",
    ]);
    // The clipboard payload must be what the SERVER sent, not our reading of
    // it — it exists to be pasted beside whatever the integration claims.
    expect(JSON.parse(sample.items[0]?.raw ?? "{}")).toEqual(ROW);
    expect(sample.requested).toBe(20);
  });

  it("keeps a large int64 id as text so no digits are lost", () => {
    const sample = normalizeProductEventSample({ items: [ROW] }, 20);
    expect(typeof sample.items[0]?.id).toBe("string");
  });

  it("reports no properties as an empty key list, not as a missing row", () => {
    const sample = normalizeProductEventSample(
      { items: [{ ...ROW, properties: null }] },
      20,
    );
    expect(sample.items).toHaveLength(1);
    expect(sample.items[0]?.propertyKeys).toEqual([]);
  });

  it("throws on a payload with no items array", () => {
    expect(() => normalizeProductEventSample({ rows: [] }, 20)).toThrow(
      /can't read/,
    );
  });
});
