import { describe, expect, it } from "vitest";

import {
  deliveriesSummaryLine,
  mergeDeliveryPages,
  normalizeOutboundDelivery,
  parseOutboundDeliveryPage,
  replayUnavailableReason,
  terminalFailureRollup,
} from "./outboundDeliveryPage";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-02T12:00:00Z");

/** A row shaped exactly as outbound_webhooks.go `Delivery` marshals one. */
function wire(overrides: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    webhook_id: "w-1",
    event_type: "campaign.sent",
    attempt_count: 5,
    status: "exhausted",
    last_status_code: 503,
    last_error: "upstream reset",
    created_at: new Date(NOW - 3 * HOUR_MS).toISOString(),
    ...overrides,
  };
}

describe("parseOutboundDeliveryPage", () => {
  it("reads the {deliveries, next_cursor} envelope the handler writes", () => {
    const page = parseOutboundDeliveryPage({
      deliveries: [wire()],
      next_cursor: "eyJ0IjoxfQ",
    });
    expect(page.deliveries.map((d) => d.id)).toEqual(["d-1"]);
    expect(page.nextCursor).toBe("eyJ0IjoxfQ");
  });

  it("treats an empty next_cursor as the last page", () => {
    expect(parseOutboundDeliveryPage({ deliveries: [], next_cursor: "" }).nextCursor).toBe("");
    expect(parseOutboundDeliveryPage({ deliveries: [] }).nextCursor).toBe("");
  });

  it("accepts a bare array (the global feed's older shape)", () => {
    const page = parseOutboundDeliveryPage([wire(), wire({ id: "d-2" })]);
    expect(page.deliveries).toHaveLength(2);
    expect(page.nextCursor).toBe("");
  });

  it("turns a truthy non-array into an EMPTY page rather than a crash", () => {
    // An HTML fallback page or a drifted envelope: `?? []` would have passed
    // the object straight into the FlatList.
    expect(parseOutboundDeliveryPage("<!doctype html>").deliveries).toEqual([]);
    expect(parseOutboundDeliveryPage({ items: [wire()] }).deliveries).toEqual([]);
    expect(parseOutboundDeliveryPage({ deliveries: { d: 1 } }).deliveries).toEqual([]);
    expect(parseOutboundDeliveryPage(null).deliveries).toEqual([]);
    expect(parseOutboundDeliveryPage(undefined).nextCursor).toBe("");
  });

  it("drops rows without an id and keeps the rest", () => {
    const page = parseOutboundDeliveryPage({
      deliveries: [wire({ id: "" }), 42, null, wire({ id: "keep" })],
    });
    expect(page.deliveries.map((d) => d.id)).toEqual(["keep"]);
  });
});

describe("normalizeOutboundDelivery", () => {
  it("omits every omitempty field the server dropped instead of inventing one", () => {
    const row = normalizeOutboundDelivery({
      id: "bare",
      webhook_id: "w",
      event_type: "subscriber.created",
      attempt_count: 1,
      status: "delivered",
      created_at: "2026-09-01T00:00:00Z",
    });
    expect(row).toEqual({
      id: "bare",
      webhook_id: "w",
      event_type: "subscriber.created",
      attempt_count: 1,
      status: "delivered",
      created_at: "2026-09-01T00:00:00Z",
    });
    expect(row && "last_status_code" in row).toBe(false);
  });

  it("carries a status code only when it is a number", () => {
    expect(normalizeOutboundDelivery(wire({ last_status_code: "503" }))?.last_status_code).toBeUndefined();
    expect(normalizeOutboundDelivery(wire())?.last_status_code).toBe(503);
  });

  it("defaults an absent event type and status rather than rendering blanks", () => {
    const row = normalizeOutboundDelivery({ id: "x" });
    expect(row?.event_type).toBe("unknown");
    expect(row?.status).toBe("pending");
    expect(row?.attempt_count).toBe(0);
  });
});

describe("mergeDeliveryPages", () => {
  it("flattens pages in order and drops an id already shown", () => {
    const merged = mergeDeliveryPages([
      { deliveries: [wire({ id: "a" }), wire({ id: "b" })], nextCursor: "c" },
      { deliveries: [wire({ id: "b" }), wire({ id: "c" })], nextCursor: "" },
    ]);
    expect(merged.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("survives a page whose deliveries is not an array", () => {
    expect(
      mergeDeliveryPages([{ deliveries: "nope" as never, nextCursor: "" }]),
    ).toEqual([]);
  });
});

describe("terminalFailureRollup", () => {
  it("renders desktop's sentence for exhausted rows inside the loaded 24h window", () => {
    expect(
      terminalFailureRollup(
        [
          wire({ id: "a", status: "exhausted" }),
          wire({ id: "b", status: "delivered" }),
          wire({ id: "c", status: "exhausted", created_at: new Date(NOW - 30 * HOUR_MS).toISOString() }),
          wire({ id: "d", status: "pending" }),
        ].map((r) => normalizeOutboundDelivery(r)!),
        NOW,
      ),
    ).toBe("1 terminal failure in the loaded trailing 24-hour window.");
  });

  it("pluralises, and is null — not '0' — when there are none", () => {
    const rows = [wire({ id: "a" }), wire({ id: "b" })].map(
      (r) => normalizeOutboundDelivery(r)!,
    );
    expect(terminalFailureRollup(rows, NOW)).toBe(
      "2 terminal failures in the loaded trailing 24-hour window.",
    );
    expect(terminalFailureRollup([], NOW)).toBeNull();
    expect(
      terminalFailureRollup(
        [normalizeOutboundDelivery(wire({ status: "delivered" }))!],
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a row whose created_at does not parse", () => {
    expect(
      terminalFailureRollup(
        [normalizeOutboundDelivery(wire({ created_at: "" }))!],
        NOW,
      ),
    ).toBeNull();
  });
});

describe("replayUnavailableReason", () => {
  it("uses desktop's sentence for an inactive destination and nothing otherwise", () => {
    expect(replayUnavailableReason({ active: false })).toBe(
      "Activate this destination before replaying deliveries.",
    );
    expect(replayUnavailableReason({ active: true })).toBeNull();
  });
});

describe("deliveriesSummaryLine", () => {
  it("says recorded-nothing at zero, counts otherwise, and flags older pages", () => {
    expect(deliveriesSummaryLine(0, false)).toBe("No deliveries recorded");
    expect(deliveriesSummaryLine(1, false)).toBe("1 delivery shown");
    expect(deliveriesSummaryLine(50, true)).toBe("50 deliveries shown · older exist");
  });
});
