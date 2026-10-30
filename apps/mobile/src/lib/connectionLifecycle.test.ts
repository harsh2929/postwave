import { describe, expect, it } from "vitest";

import {
  CONNECTION_VERB_LABELS,
  connectionIsFailing,
  connectionIsPaused,
  connectionSummary,
  connectionVerbIsDestructive,
  connectionVerbs,
  parseConnectionRows,
  type ConnectionVerb,
} from "./connectionLifecycle";

// The two families' real verb sets.
const WRITEBACK: ConnectionVerb[] = ["run", "pause", "resume", "disconnect"];
const MARKETING: ConnectionVerb[] = ["sync", "backfill", "pause", "disconnect"];

describe("connectionVerbs", () => {
  it("offers the write-back set while healthy", () => {
    expect(connectionVerbs(WRITEBACK, "active")).toEqual([
      "run",
      "pause",
      "disconnect",
    ]);
  });

  it("swaps pause for resume when paused, never both", () => {
    const verbs = connectionVerbs(WRITEBACK, "paused");
    expect(verbs).toContain("resume");
    expect(verbs).not.toContain("pause");
  });

  it("hides run on a paused row that CAN be resumed", () => {
    // Running a row the operator deliberately paused is a surprise.
    expect(connectionVerbs(WRITEBACK, "paused")).not.toContain("run");
  });

  it("keeps the run verb on a paused row when the family has NO resume route", () => {
    // marketing-integrations has no resume endpoint. Hiding sync there would
    // leave a paused row with nothing to do at all.
    const verbs = connectionVerbs(MARKETING, "paused");
    expect(verbs).toContain("sync");
    expect(verbs).not.toContain("resume");
  });

  it("never invents a resume button for a family without the route", () => {
    for (const status of ["active", "paused", "error"]) {
      expect(connectionVerbs(MARKETING, status)).not.toContain("resume");
    }
  });

  it("always puts disconnect last", () => {
    for (const set of [WRITEBACK, MARKETING]) {
      for (const status of ["active", "paused", "error"]) {
        const verbs = connectionVerbs(set, status);
        expect(verbs[verbs.length - 1]).toBe("disconnect");
      }
    }
  });

  it("keeps retry available on a failing row, which is the point", () => {
    expect(connectionVerbs(WRITEBACK, "error")).toContain("run");
    expect(connectionVerbs(MARKETING, "error")).toContain("sync");
  });

  it("omits disconnect entirely when the family does not offer it", () => {
    expect(connectionVerbs(["run", "pause"], "active")).toEqual(["run", "pause"]);
  });

  it("labels every verb it can return", () => {
    for (const set of [WRITEBACK, MARKETING]) {
      for (const verb of connectionVerbs(set, "active")) {
        expect(CONNECTION_VERB_LABELS[verb]).toBeTruthy();
      }
    }
  });
});

describe("connectionVerbIsDestructive", () => {
  it("marks only disconnect", () => {
    expect(connectionVerbIsDestructive("disconnect")).toBe(true);
    for (const verb of ["run", "sync", "backfill", "pause", "resume"] as const) {
      expect(connectionVerbIsDestructive(verb)).toBe(false);
    }
  });
});

describe("connectionIsPaused / connectionIsFailing", () => {
  it("reads the states the UI colours", () => {
    expect(connectionIsPaused(" PAUSED ")).toBe(true);
    for (const status of ["error", "failed", "failing"]) {
      expect(connectionIsFailing(status)).toBe(true);
    }
    expect(connectionIsFailing("active")).toBe(false);
  });
});

describe("connectionSummary", () => {
  const row = (extra: Partial<Parameters<typeof connectionSummary>[0]> = {}) => ({
    id: "t1",
    name: "Shopify",
    status: "active",
    lastRunAt: "",
    errorMessage: "",
    ...extra,
  });

  it("shows the provider's own error", () => {
    expect(
      connectionSummary(row({ status: "error", errorMessage: "401 rejected" })),
    ).toContain("401 rejected");
  });

  it("still says failing with no message", () => {
    const summary = connectionSummary(row({ status: "error" }));
    expect(summary).toContain("Failing");
    expect(summary).not.toContain("undefined");
  });

  it("says nothing runs while paused", () => {
    expect(connectionSummary(row({ status: "paused" }))).toContain("Nothing runs");
  });

  it("reports the last run when healthy", () => {
    expect(connectionSummary(row({ lastRunAt: "an hour ago" }))).toContain(
      "an hour ago",
    );
    expect(connectionSummary(row())).toBe("Healthy.");
  });
});

describe("parseConnectionRows", () => {
  it("reads all three envelope shapes the two families use", () => {
    const one = [{ id: "t1", name: "Shopify", status: "active" }];
    expect(parseConnectionRows(one)).toHaveLength(1);
    expect(parseConnectionRows({ items: one })).toHaveLength(1);
    expect(parseConnectionRows({ targets: one })).toHaveLength(1);
    expect(parseConnectionRows({ integrations: one })).toHaveLength(1);
    expect(parseConnectionRows(null)).toEqual([]);
  });

  it("drops rows with no id, whose every control would throw", () => {
    expect(parseConnectionRows([{ name: "ghost" }])).toEqual([]);
  });

  it("accepts either field name for the last run and the error", () => {
    const [a] = parseConnectionRows([
      { id: "t1", last_sync_at: "yesterday", last_error: "boom" },
    ]);
    expect(a?.lastRunAt).toBe("yesterday");
    expect(a?.errorMessage).toBe("boom");
  });

  it("falls back to the provider for a nameless row", () => {
    expect(parseConnectionRows([{ id: "t1", provider: "klaviyo" }])[0]?.name).toBe(
      "klaviyo",
    );
  });
});
