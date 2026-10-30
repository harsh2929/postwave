import { describe, expect, it } from "vitest";

import { outboxDlqSummary, parseOutboxDlq } from "./outboxDlq";

describe("parseOutboxDlq", () => {
  it("reads both envelope shapes", () => {
    const rows = [{ id: "e1", topic: "campaign.sent", attempts: 5 }];
    expect(parseOutboxDlq(rows)).toHaveLength(1);
    expect(parseOutboxDlq({ items: rows })).toHaveLength(1);
    expect(parseOutboxDlq({ entries: rows })).toHaveLength(1);
    expect(parseOutboxDlq(null)).toEqual([]);
  });

  it("drops an entry with no id, which could not be replayed", () => {
    expect(parseOutboxDlq([{ topic: "x" }])).toEqual([]);
  });

  it("accepts either field name for topic, attempts, error and time", () => {
    const [entry] = parseOutboxDlq([
      {
        id: "e1",
        event_type: "webhook.delivery",
        attempt_count: 3,
        error: "502 from endpoint",
        created_at: "yesterday",
      },
    ]);
    expect(entry?.topic).toBe("webhook.delivery");
    expect(entry?.attempts).toBe(3);
    expect(entry?.lastError).toBe("502 from endpoint");
    expect(entry?.failedAt).toBe("yesterday");
  });

  it("never renders a negative or fractional attempt count", () => {
    expect(parseOutboxDlq([{ id: "e1", attempts: -3 }])[0]?.attempts).toBe(0);
    expect(parseOutboxDlq([{ id: "e1", attempts: 2.7 }])[0]?.attempts).toBe(2);
    expect(parseOutboxDlq([{ id: "e1", attempts: "many" }])[0]?.attempts).toBe(0);
  });

  it("falls back to `unknown` rather than an empty topic", () => {
    expect(parseOutboxDlq([{ id: "e1" }])[0]?.topic).toBe("unknown");
  });
});

describe("outboxDlqSummary", () => {
  it("refuses to call an empty DLQ a healthy system", () => {
    // The DLQ being empty proves only that nothing has exhausted its retries.
    const summary = outboxDlqSummary([]);
    expect(summary).toContain("not the same as everything having landed");
  });

  it("says these are side effects a request already reported as done", () => {
    const summary = outboxDlqSummary([
      { id: "e1", topic: "t", attempts: 5, lastError: "", failedAt: "" },
      { id: "e2", topic: "t", attempts: 9, lastError: "", failedAt: "" },
    ]);
    expect(summary).toContain("2 side effects");
    expect(summary).toContain("9 attempts");
    expect(summary).toContain("already reported as done");
  });

  it("uses singular for one entry and one attempt", () => {
    const summary = outboxDlqSummary([
      { id: "e1", topic: "t", attempts: 1, lastError: "", failedAt: "" },
    ]);
    expect(summary).toContain("1 side effect ");
    expect(summary).toContain("1 attempt.");
  });
});
