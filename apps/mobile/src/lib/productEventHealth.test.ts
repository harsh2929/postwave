import { describe, expect, it } from "vitest";

import {
  catalogHeadline,
  catalogNotes,
  classifyProductEvent,
  filterProductEvents,
  firstSeenLabel,
  orderProductEvents,
  silentEventCount,
} from "@/lib/productEventHealth";
import type {
  ProductEventCatalog,
  ProductEventCatalogRow,
} from "@/lib/productEvents";

const AS_OF = "2026-07-26T12:00:00Z";

function row(over: Partial<ProductEventCatalogRow> = {}): ProductEventCatalogRow {
  return {
    eventName: "order.placed",
    count: 100,
    uniqueSubscribers: 20,
    firstSeen: "2026-06-26T00:00:00Z",
    lastSeen: "2026-07-26T11:00:00Z",
    daily: [],
    ...over,
  };
}

describe("classifyProductEvent", () => {
  it("measures the age against the SERVER snapshot, not the device clock", () => {
    // If this used Date.now() the verdict would drift every time the test ran,
    // and — the real failure — a payload cached in a tunnel would age on the
    // shelf and report a live event as silent.
    const verdict = classifyProductEvent("2026-07-26T11:00:00Z", AS_OF);
    expect(verdict.freshness).toBe("live");
    expect(verdict.ageMs).toBe(60 * 60 * 1000);
  });

  it("calls a 3-day gap quiet and a 12-day gap silent, in words", () => {
    expect(classifyProductEvent("2026-07-23T12:00:00Z", AS_OF)).toMatchObject({
      freshness: "quiet",
      label: "Quiet",
      description: "No events for 3 days.",
    });
    const silent = classifyProductEvent("2026-07-14T12:00:00Z", AS_OF);
    expect(silent.freshness).toBe("silent");
    // The gap, never a diagnosis: nothing in the API records the expected
    // cadence, so "stopped" would be a guess dressed as a fact.
    expect(silent.description).toContain("No events for 12 days");
    expect(silent.description).not.toContain("broken");
  });

  it("is `unknown`, never `live`, when the timestamp is unreadable", () => {
    expect(classifyProductEvent("", AS_OF).freshness).toBe("unknown");
    expect(classifyProductEvent("not-a-date", AS_OF).freshness).toBe("unknown");
    expect(classifyProductEvent("2026-07-26T11:00:00Z", "").freshness).toBe(
      "unknown",
    );
    expect(classifyProductEvent("", AS_OF).ageMs).toBeNull();
  });

  it("clamps an ingest-skew future timestamp to zero instead of 'in 3 minutes'", () => {
    const verdict = classifyProductEvent("2026-07-26T12:03:00Z", AS_OF);
    expect(verdict.ageMs).toBe(0);
    expect(verdict.freshness).toBe("live");
  });

  it("puts the boundary at exactly 24 hours and exactly 7 days", () => {
    expect(
      classifyProductEvent("2026-07-25T12:00:00Z", AS_OF).freshness,
    ).toBe("quiet");
    expect(
      classifyProductEvent("2026-07-19T12:00:00Z", AS_OF).freshness,
    ).toBe("silent");
  });
});

describe("orderProductEvents", () => {
  const ROWS = [
    row({ eventName: "live.small", count: 5, lastSeen: "2026-07-26T11:00:00Z" }),
    row({ eventName: "live.big", count: 900, lastSeen: "2026-07-26T10:00:00Z" }),
    row({ eventName: "silent.small", count: 7, lastSeen: "2026-07-01T00:00:00Z" }),
    row({ eventName: "silent.big", count: 400, lastSeen: "2026-07-02T00:00:00Z" }),
    row({ eventName: "quiet.one", count: 60, lastSeen: "2026-07-23T00:00:00Z" }),
    row({ eventName: "unknown.one", count: 3, lastSeen: "" }),
  ];

  it("leads with the biggest SILENT event, not the biggest event", () => {
    // The whole reason this surface exists. A volume-sorted catalogue buries
    // the stopped event underneath everything still working.
    expect(
      orderProductEvents(ROWS, AS_OF, "attention").map((r) => r.eventName),
    ).toEqual([
      "silent.big",
      "silent.small",
      "unknown.one",
      "quiet.one",
      "live.big",
      "live.small",
    ]);
  });

  it("offers a plain volume order that ignores freshness entirely", () => {
    expect(
      orderProductEvents(ROWS, AS_OF, "volume").map((r) => r.eventName),
    ).toEqual([
      "live.big",
      "silent.big",
      "quiet.one",
      "silent.small",
      "live.small",
      "unknown.one",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const input = [...ROWS];
    orderProductEvents(input, AS_OF, "attention");
    expect(input.map((r) => r.eventName)).toEqual(ROWS.map((r) => r.eventName));
  });
});

describe("silentEventCount + catalogHeadline", () => {
  const ROWS = [
    row({ eventName: "a", lastSeen: "2026-07-26T11:00:00Z" }),
    row({ eventName: "b", lastSeen: "2026-07-01T00:00:00Z" }),
    row({ eventName: "c", lastSeen: "2026-07-02T00:00:00Z" }),
  ];

  it("counts only the silent rows", () => {
    expect(silentEventCount(ROWS, AS_OF)).toBe(2);
  });

  it("always states the denominator", () => {
    // "2 silent" alone reads as an absolute; the denominator is the point of a
    // catalogue that only covers a window.
    expect(catalogHeadline(ROWS, AS_OF)).toBe(
      "2 of 3 events have sent nothing for a week or more.",
    );
    expect(catalogHeadline([ROWS[0] as ProductEventCatalogRow], AS_OF)).toBe(
      "Every one of 1 event has arrived in the last 7 days.",
    );
  });

  it("agrees with itself on the singular", () => {
    const one = [
      row({ eventName: "a", lastSeen: "2026-07-26T11:00:00Z" }),
      row({ eventName: "b", lastSeen: "2026-07-01T00:00:00Z" }),
    ];
    expect(catalogHeadline(one, AS_OF)).toBe(
      "1 of 2 events has sent nothing for a week or more.",
    );
  });

  it("says nothing at all about an empty list", () => {
    // An empty catalogue is an EmptyState's job, not a headline's.
    expect(catalogHeadline([], AS_OF)).toBe("");
  });
});

describe("catalogNotes", () => {
  function catalog(over: Partial<ProductEventCatalog> = {}): ProductEventCatalog {
    return {
      items: [row()],
      totalDistinctEventNames: 1,
      periodDays: 30,
      dailySeriesPeriodDays: 7,
      eventBoundsScope: "period",
      timeZone: "UTC",
      asOf: AS_OF,
      ...over,
    };
  }

  it("says out loud that an older stopped event is ABSENT, not zero", () => {
    // The single most important sentence on this surface: the catalogue is a
    // GROUP BY inside the window, so an event that died before it has no row.
    expect(catalogNotes(catalog())[0]).toBe(
      "Only events seen in the last 30 days appear here. One that stopped before that is missing from this list, not zero — widen the window to find it.",
    );
  });

  it("discloses the 200-row cap when the server reported more names", () => {
    const notes = catalogNotes(
      catalog({ items: [row()], totalDistinctEventNames: 312 }),
    );
    expect(notes).toContain(
      "Showing the 1 busiest of 312 event names. The rest are on the web admin.",
    );
  });

  it("stays quiet about truncation when nothing was truncated", () => {
    expect(catalogNotes(catalog()).join(" ")).not.toContain("busiest of");
  });

  it("discloses the two different windows inside one row", () => {
    expect(catalogNotes(catalog())).toContain(
      "Each row's totals cover 30 days; its trend line always covers the last 7 days.",
    );
  });

  it("drops the two-window note when the windows happen to agree", () => {
    const notes = catalogNotes(catalog({ periodDays: 7 }));
    expect(notes.join(" ")).not.toContain("trend line always covers");
  });

  it("explains period-scoped bounds only when the server says they are", () => {
    expect(catalogNotes(catalog()).join(" ")).toContain(
      "First and last seen are bounded by this window",
    );
    expect(
      catalogNotes(catalog({ eventBoundsScope: "lifetime" })).join(" "),
    ).not.toContain("bounded by this window");
  });
});

describe("firstSeenLabel + filterProductEvents", () => {
  it("only claims a lifetime bound when the server did not scope it", () => {
    expect(firstSeenLabel("period")).toBe("First in window");
    expect(firstSeenLabel("lifetime")).toBe("First seen");
  });

  it("matches case-insensitively anywhere in the name", () => {
    const rows = [row({ eventName: "order.placed" }), row({ eventName: "cart.abandoned" })];
    expect(filterProductEvents(rows, "ORDER").map((r) => r.eventName)).toEqual([
      "order.placed",
    ]);
    expect(filterProductEvents(rows, "  ").map((r) => r.eventName)).toEqual([
      "order.placed",
      "cart.abandoned",
    ]);
  });
});
