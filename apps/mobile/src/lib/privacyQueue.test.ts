import { describe, expect, it } from "vitest";

import {
  allowedActions,
  actionRequiresReason,
  daysUntilDue,
  dueLabel,
  dueState,
  matchesFilter,
  sortQueue,
  summarizeQueue,
  type PrivacyQueueRow,
} from "./privacyQueue";

const NOW = Date.parse("2026-07-26T12:00:00Z");

function row(patch: Partial<PrivacyQueueRow> = {}): PrivacyQueueRow {
  return {
    request_id: "prv_data-export_1",
    type: "data_export",
    status: "received",
    region: "GDPR",
    due_at: "2026-08-25T12:00:00Z",
    ...patch,
  };
}

describe("dueState", () => {
  it("calls a passed deadline overdue", () => {
    expect(dueState(row({ due_at: "2026-07-25T12:00:00Z" }), NOW)).toBe(
      "overdue",
    );
  });

  it("warns inside the three-day window", () => {
    expect(dueState(row({ due_at: "2026-07-28T00:00:00Z" }), NOW)).toBe(
      "due_soon",
    );
  });

  it("stops the clock for a finished request even when the date has passed", () => {
    expect(
      dueState(
        row({ status: "fulfilled", due_at: "2020-01-01T00:00:00Z" }),
        NOW,
      ),
    ).toBe("closed");
    expect(dueState(row({ status: "rejected" }), NOW)).toBe("closed");
  });

  it("reports a missing deadline as unknown, never as on track", () => {
    expect(dueState(row({ due_at: "" }), NOW)).toBe("unknown");
    expect(dueState(row({ due_at: "not-a-date" }), NOW)).toBe("unknown");
  });
});

describe("daysUntilDue / dueLabel", () => {
  it("returns null rather than 0 when there is no deadline", () => {
    expect(daysUntilDue(row({ due_at: "" }), NOW)).toBeNull();
    expect(dueLabel(row({ due_at: "" }), NOW)).toBe("No deadline recorded");
  });

  it("counts down and then counts up", () => {
    expect(dueLabel(row({ due_at: "2026-07-26T20:00:00Z" }), NOW)).toBe(
      "Due today",
    );
    expect(dueLabel(row({ due_at: "2026-07-27T13:00:00Z" }), NOW)).toBe(
      "Due in 1 day",
    );
    expect(dueLabel(row({ due_at: "2026-07-24T12:00:00Z" }), NOW)).toBe(
      "Overdue by 2 days",
    );
  });

  it("says the clock stopped for a closed request", () => {
    expect(dueLabel(row({ status: "fulfilled" }), NOW)).toBe("Clock stopped");
  });
});

describe("summarizeQueue", () => {
  it("counts overdue, due-soon and undated separately from on-track", () => {
    const summary = summarizeQueue(
      [
        row({ request_id: "a", due_at: "2026-07-01T00:00:00Z" }),
        row({ request_id: "b", due_at: "2026-07-27T00:00:00Z" }),
        row({ request_id: "c", due_at: "2026-12-01T00:00:00Z" }),
        row({ request_id: "d", due_at: "" }),
        row({ request_id: "e", status: "fulfilled" }),
        row({ request_id: "f", legal_hold: true }),
      ],
      NOW,
    );
    expect(summary).toEqual({
      total: 6,
      open: 5,
      overdue: 1,
      dueSoon: 1,
      onHold: 1,
      undated: 1,
    });
  });
});

describe("sortQueue", () => {
  it("puts the most overdue first and closed rows last", () => {
    const sorted = sortQueue(
      [
        row({ request_id: "closed", status: "fulfilled" }),
        row({ request_id: "future", due_at: "2026-12-01T00:00:00Z" }),
        row({ request_id: "late-a", due_at: "2026-07-20T00:00:00Z" }),
        row({ request_id: "late-b", due_at: "2026-07-01T00:00:00Z" }),
        row({ request_id: "undated", due_at: "" }),
      ],
      NOW,
    );
    expect(sorted.map((r) => r.request_id)).toEqual([
      "late-b",
      "late-a",
      "future",
      "undated",
      "closed",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [row({ request_id: "b" }), row({ request_id: "a" })];
    sortQueue(input, NOW);
    expect(input.map((r) => r.request_id)).toEqual(["b", "a"]);
  });
});

describe("matchesFilter", () => {
  it("'Needs action' is open AND (overdue | due soon | undated)", () => {
    expect(
      matchesFilter(row({ due_at: "2026-07-01T00:00:00Z" }), "urgent", NOW),
    ).toBe(true);
    expect(matchesFilter(row({ due_at: "" }), "urgent", NOW)).toBe(true);
    expect(
      matchesFilter(row({ due_at: "2026-12-01T00:00:00Z" }), "urgent", NOW),
    ).toBe(false);
    expect(
      matchesFilter(
        row({ status: "rejected", due_at: "2020-01-01T00:00:00Z" }),
        "urgent",
        NOW,
      ),
    ).toBe(false);
  });

  it("separates open, on-hold and closed", () => {
    expect(matchesFilter(row({ status: "verifying" }), "open", NOW)).toBe(true);
    expect(matchesFilter(row({ status: "cancelled" }), "open", NOW)).toBe(false);
    expect(matchesFilter(row({ legal_hold: true }), "on_hold", NOW)).toBe(true);
    expect(matchesFilter(row({ status: "fulfilled" }), "closed", NOW)).toBe(
      true,
    );
    expect(matchesFilter(row({ status: "fulfilled" }), "all", NOW)).toBe(true);
  });
});

describe("allowedActions mirrors the Go status guards", () => {
  it("offers verify + deny + hold on a live request", () => {
    expect(allowedActions(row())).toEqual(["verify", "deny", "hold"]);
  });

  it("never offers verify or deny on a fulfilled request", () => {
    expect(allowedActions(row({ status: "fulfilled" }))).toEqual(["hold"]);
  });

  it("offers appeal — and only appeal — after a rejection", () => {
    expect(allowedActions(row({ status: "rejected" }))).toEqual([
      "appeal",
      "hold",
    ]);
  });

  it("flips hold to clear_hold when a hold is already on", () => {
    expect(allowedActions(row({ legal_hold: true }))).toContain("clear_hold");
    expect(allowedActions(row({ legal_hold: true }))).not.toContain("hold");
  });

  it("is case- and whitespace-insensitive about the wire status", () => {
    expect(allowedActions(row({ status: " Fulfilled " }))).toEqual(["hold"]);
  });
});

describe("actionRequiresReason", () => {
  it("matches the handlers that 400 on a missing reason", () => {
    expect(actionRequiresReason("hold")).toBe(true);
    expect(actionRequiresReason("deny")).toBe(true);
    expect(actionRequiresReason("appeal")).toBe(true);
    expect(actionRequiresReason("verify")).toBe(false);
    expect(actionRequiresReason("clear_hold")).toBe(false);
  });
});
