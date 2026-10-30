import { describe, expect, it } from "vitest";

import {
  idempotencyKeyLine,
  idempotencySummary,
  idempotencyTone,
  sortIdempotencyKeys,
  toIdempotencyKey,
  toIdempotencyStats,
  type IdempotencyKeyLike,
} from "./idempotencyKeys";

const NOW = Date.parse("2026-08-18T12:00:00Z");

function key(over: Partial<IdempotencyKeyLike> = {}): IdempotencyKeyLike {
  return {
    key: "order-4131",
    route: "POST /api/v1/emails",
    state: "completed",
    responseStatus: 200,
    createdAt: "2026-08-18T11:00:00Z",
    ...over,
  };
}

describe("idempotencySummary leads with pending", () => {
  it("says plainly when nothing is mid-flight", () => {
    const s = idempotencySummary({ total: 10, pending: 0, completed: 9, expired: 1 });
    expect(s).toContain("No requests are mid-flight");
  });

  it("leads with the pending count when there is one", () => {
    // A pending key is both the CAUSE of a duplicate (a retry cannot replay
    // what was never stored) and the symptom of a hung handler.
    const s = idempotencySummary({ total: 10, pending: 3, completed: 7, expired: 0 });
    expect(s).toMatch(/^3 requests started and never recorded a result/u);
  });

  it("singularises one", () => {
    expect(
      idempotencySummary({ total: 1, pending: 1, completed: 0, expired: 0 }),
    ).toContain("1 request started");
  });
});

describe("idempotencyTone", () => {
  it("warns only when something is mid-flight", () => {
    expect(idempotencyTone({ total: 5, pending: 0, completed: 5, expired: 0 })).toBe("success");
    expect(idempotencyTone({ total: 5, pending: 1, completed: 4, expired: 0 })).toBe("warning");
  });
});

describe("idempotencyKeyLine", () => {
  it("NEVER renders the key itself", () => {
    // A client-chosen key routinely embeds an order id, a customer reference
    // or an email — none of which belongs on a lock screen.
    const line = idempotencyKeyLine(key({ key: "customer-ada@example.com-4131" }), NOW);
    expect(line).not.toContain("ada@example.com");
    expect(line).not.toContain("customer-");
  });

  it("says a pending key has no result yet", () => {
    const line = idempotencyKeyLine(key({ state: "pending", responseStatus: undefined }), NOW);
    expect(line).toContain("still no result");
  });

  it("names the response status when there is one", () => {
    expect(idempotencyKeyLine(key({ responseStatus: 409 }), NOW)).toContain("answered 409");
  });

  it("does not invent a route or a time it does not have", () => {
    const line = idempotencyKeyLine(key({ route: "", createdAt: "" }), NOW);
    expect(line).toContain("unknown route");
    expect(line).toContain("start time unknown");
  });
});

describe("sortIdempotencyKeys", () => {
  it("puts mid-flight requests first", () => {
    const rows = [
      key({ key: "done", state: "completed" }),
      key({ key: "stuck", state: "pending" }),
    ];
    expect(sortIdempotencyKeys(rows).map((r) => r.key)).toEqual(["stuck", "done"]);
  });

  it("orders newest first within a group, and does not mutate its input", () => {
    const rows = [
      key({ key: "old", createdAt: "2026-08-01T00:00:00Z" }),
      key({ key: "new", createdAt: "2026-08-18T00:00:00Z" }),
    ];
    const before = rows.map((r) => r.key);
    expect(sortIdempotencyKeys(rows).map((r) => r.key)).toEqual(["new", "old"]);
    expect(rows.map((r) => r.key)).toEqual(before);
  });

  it("tolerates a non-array", () => {
    expect(sortIdempotencyKeys(undefined as never)).toEqual([]);
  });
});

describe("wire parsing", () => {
  it("never reads a missing state as completed", () => {
    // Rendering an unknown state as finished is the one claim this screen
    // must not make.
    const row = toIdempotencyKey({ key: "k", route: "r", created_at: "" });
    expect(row?.state).toBe("unknown");
  });

  it("rejects a row with no key", () => {
    expect(toIdempotencyKey({ route: "r" })).toBeNull();
    expect(toIdempotencyKey(null)).toBeNull();
  });

  it("reads stats without inventing numbers", () => {
    expect(toIdempotencyStats({ total: 3 })).toEqual({
      total: 3,
      pending: 0,
      completed: 0,
      expired: 0,
    });
    expect(toIdempotencyStats("nope")).toBeNull();
  });
});
