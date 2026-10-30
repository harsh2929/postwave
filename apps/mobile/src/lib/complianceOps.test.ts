import { describe, expect, it } from "vitest";

import {
  DSAR_RESPONSE_DAYS,
  maintenanceBanner,
  sarAgeDays,
  sarDaysRemaining,
  sarIsOpen,
  sarQueueSummary,
  sarQueueUrgency,
  sarUrgency,
  windowIsOpen,
  windowIsUpcoming,
  type MaintenanceWindowLike,
  type SarRequestLike,
} from "./complianceOps";

const NOW = Date.parse("2026-08-18T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function sar(over: Partial<SarRequestLike> = {}): SarRequestLike {
  return {
    id: "s1",
    kind: "access",
    status: "pending",
    requested_at: daysAgo(3),
    ...over,
  };
}

describe("sarIsOpen", () => {
  it("is open while pending", () => {
    expect(sarIsOpen(sar())).toBe(true);
  });

  it("is closed once ready", () => {
    expect(sarIsOpen(sar({ status: "ready", ready_at: daysAgo(1) }))).toBe(false);
    expect(sarIsOpen(sar({ status: "complete" }))).toBe(false);
  });

  it("keeps a FAILED request open — it broke, it was not fulfilled", () => {
    // Treating a failure as closed would hide exactly the case most likely to
    // run out the statutory clock.
    expect(sarIsOpen(sar({ status: "failed" }))).toBe(true);
    expect(sarIsOpen(sar({ status: "error" }))).toBe(true);
  });

  it("is case-insensitive about status", () => {
    expect(sarIsOpen(sar({ status: "READY", ready_at: daysAgo(1) }))).toBe(false);
  });
});

describe("the statutory clock", () => {
  it("counts whole days since arrival", () => {
    expect(sarAgeDays(sar({ requested_at: daysAgo(21) }), NOW)).toBe(21);
  });

  it("never goes negative on a future-dated request", () => {
    const future = new Date(NOW + 86_400_000).toISOString();
    expect(sarAgeDays(sar({ requested_at: future }), NOW)).toBe(0);
  });

  it("treats an unparseable timestamp as age zero rather than crashing", () => {
    expect(sarAgeDays(sar({ requested_at: "nope" }), NOW)).toBe(0);
  });

  it("counts down to the deadline", () => {
    expect(sarDaysRemaining(sar({ requested_at: daysAgo(10) }), NOW)).toBe(
      DSAR_RESPONSE_DAYS - 10,
    );
  });

  it("warns a week out, not a day out", () => {
    // A DSAR takes real work; a warning with 24 hours left is a record of
    // having missed it, not an actionable alert.
    expect(sarUrgency(sar({ requested_at: daysAgo(22) }), NOW)).toBe("ok");
    expect(sarUrgency(sar({ requested_at: daysAgo(23) }), NOW)).toBe("due_soon");
    expect(sarUrgency(sar({ requested_at: daysAgo(31) }), NOW)).toBe("overdue");
  });

  it("is due_soon, not overdue, exactly on the deadline day", () => {
    expect(sarUrgency(sar({ requested_at: daysAgo(30) }), NOW)).toBe("due_soon");
  });
});

describe("sarQueueSummary", () => {
  it("is null when nothing is open — no banner rather than an empty one", () => {
    expect(sarQueueSummary([], NOW)).toBeNull();
    expect(
      sarQueueSummary([sar({ status: "ready", ready_at: daysAgo(1) })], NOW),
    ).toBeNull();
  });

  it("names the count AND the oldest", () => {
    // The count alone cannot separate "three arrived this morning" from "one
    // has been sitting for 29 days".
    const s = sarQueueSummary(
      [
        sar({ id: "a", requested_at: daysAgo(1) }),
        sar({ id: "b", requested_at: daysAgo(29) }),
        sar({ id: "c", requested_at: daysAgo(2) }),
      ],
      NOW,
    );
    expect(s).toContain("3 open subject requests");
    expect(s).toContain("29 days old");
    expect(s).toContain("1 days before");
  });

  it("says PAST the deadline rather than printing a negative countdown", () => {
    const s = sarQueueSummary([sar({ requested_at: daysAgo(35) })], NOW);
    expect(s).toContain("PAST the 30-day deadline");
    expect(s).not.toMatch(/-\d+ days before/u);
  });

  it("singularises one request", () => {
    expect(sarQueueSummary([sar()], NOW)).toContain("1 open subject request —");
  });

  it("ignores closed requests when picking the oldest", () => {
    const s = sarQueueSummary(
      [
        sar({ id: "old-but-done", requested_at: daysAgo(90), status: "ready", ready_at: daysAgo(80) }),
        sar({ id: "open", requested_at: daysAgo(4) }),
      ],
      NOW,
    );
    expect(s).toContain("4 days old");
  });
});

describe("sarQueueUrgency", () => {
  it("is null with nothing open", () => {
    expect(sarQueueUrgency([], NOW)).toBeNull();
  });

  it("reports the WORST in the queue, not the first", () => {
    const rows = [
      sar({ id: "fresh", requested_at: daysAgo(1) }),
      sar({ id: "late", requested_at: daysAgo(40) }),
    ];
    expect(sarQueueUrgency(rows, NOW)).toBe("overdue");
  });

  it("prefers due_soon over ok", () => {
    const rows = [
      sar({ id: "fresh", requested_at: daysAgo(1) }),
      sar({ id: "soon", requested_at: daysAgo(25) }),
    ];
    expect(sarQueueUrgency(rows, NOW)).toBe("due_soon");
  });
});

describe("maintenance windows", () => {
  function win(
    over: Partial<MaintenanceWindowLike> = {},
  ): MaintenanceWindowLike {
    return {
      id: "w1",
      title: "Database upgrade",
      components: ["sending"],
      starts_at: new Date(NOW - 3_600_000).toISOString(),
      ends_at: new Date(NOW + 3_600_000).toISOString(),
      status: "scheduled",
      ...over,
    };
  }

  it("is open between its bounds", () => {
    expect(windowIsOpen(win(), NOW)).toBe(true);
  });

  it("is closed at exactly its end, not still open", () => {
    expect(
      windowIsOpen(win({ ends_at: new Date(NOW).toISOString() }), NOW),
    ).toBe(false);
  });

  it("is open at exactly its start", () => {
    expect(
      windowIsOpen(win({ starts_at: new Date(NOW).toISOString() }), NOW),
    ).toBe(true);
  });

  it("is never open once cancelled or completed", () => {
    expect(windowIsOpen(win({ status: "cancelled" }), NOW)).toBe(false);
    expect(windowIsOpen(win({ status: "completed" }), NOW)).toBe(false);
  });

  it("keeps a malformed row out of the banner rather than asserting something false", () => {
    expect(windowIsOpen(win({ starts_at: "nope" }), NOW)).toBe(false);
    expect(windowIsOpen(win({ ends_at: "nope" }), NOW)).toBe(false);
  });

  it("recognises an upcoming window inside the horizon only", () => {
    const soon = win({
      starts_at: new Date(NOW + 3_600_000).toISOString(),
      ends_at: new Date(NOW + 7_200_000).toISOString(),
    });
    const later = win({
      starts_at: new Date(NOW + 5 * 86_400_000).toISOString(),
      ends_at: new Date(NOW + 6 * 86_400_000).toISOString(),
    });
    expect(windowIsUpcoming(soon, NOW)).toBe(true);
    expect(windowIsUpcoming(later, NOW)).toBe(false);
  });

  it("puts an OPEN window above an upcoming one", () => {
    // "Maintenance is happening now" is the answer to "why is nothing
    // sending" — burying it under a schedule notice defeats the banner.
    const banner = maintenanceBanner(
      [
        win({
          id: "soon",
          title: "Later work",
          starts_at: new Date(NOW + 3_600_000).toISOString(),
          ends_at: new Date(NOW + 7_200_000).toISOString(),
        }),
        win({ id: "now", title: "Database upgrade" }),
      ],
      NOW,
    );
    expect(banner).toContain("Maintenance in progress: Database upgrade");
  });

  it("names the affected components when there are any", () => {
    expect(maintenanceBanner([win({ components: ["sending", "api"] })], NOW)).toContain(
      "Affects sending, api.",
    );
  });

  it("omits the scope clause rather than rendering an empty one", () => {
    const banner = maintenanceBanner([win({ components: [] })], NOW);
    expect(banner).toBe("Maintenance in progress: Database upgrade.");
  });

  it("is null when nothing is open or imminent", () => {
    expect(maintenanceBanner([], NOW)).toBeNull();
    expect(maintenanceBanner([win({ status: "cancelled" })], NOW)).toBeNull();
  });
});

describe("a bad shape must not crash the screen it sits on", () => {
  // These two functions are the boundary between wire data and the first two
  // screens an operator opens. A thrown error here takes the whole dashboard
  // or compliance screen down; a missing banner costs one line of information.
  const junk = [undefined, null, {}, "", 0] as unknown[];

  it("maintenanceBanner returns null for any non-array input", () => {
    for (const bad of junk) {
      expect(maintenanceBanner(bad as never, NOW)).toBeNull();
    }
  });

  it("sarQueueSummary returns null for any non-array input", () => {
    for (const bad of junk) {
      expect(sarQueueSummary(bad as never, NOW)).toBeNull();
    }
  });

  it("sarQueueUrgency returns null for any non-array input", () => {
    for (const bad of junk) {
      expect(sarQueueUrgency(bad as never, NOW)).toBeNull();
    }
  });
});
