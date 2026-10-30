import { describe, expect, it } from "vitest";

import {
  INBOX_REALITY_TERMINAL_STATUSES,
  inboxRealityTestIsLive,
  inboxRealityTestSummary,
  parseInboxRealityTests,
} from "./inboxRealityTests";

describe("inboxRealityTestIsLive", () => {
  it("treats exactly the terminal statuses as finished", () => {
    // types.go:123-137 — awaiting_delivery and classifying are the live pair.
    expect([...INBOX_REALITY_TERMINAL_STATUSES]).toEqual([
      "complete",
      "expired",
      "cancelled",
    ]);
    for (const status of INBOX_REALITY_TERMINAL_STATUSES) {
      expect(inboxRealityTestIsLive(status)).toBe(false);
    }
    for (const status of ["awaiting_delivery", "classifying"]) {
      expect(inboxRealityTestIsLive(status)).toBe(true);
    }
  });

  it("treats an unknown status as live, keeping the cancel available", () => {
    // A test holding seed capacity under a status this client has not seen must
    // still be stoppable; hiding the brake is the worse error here.
    expect(inboxRealityTestIsLive("reticulating")).toBe(true);
  });
});

describe("inboxRealityTestSummary", () => {
  it("does not claim cancelling un-sends a delivered probe", () => {
    const summary = inboxRealityTestSummary({
      id: "t1",
      subject: "s",
      status: "awaiting_delivery",
      kind: "",
      createdAt: "",
    });
    expect(summary).toContain("cannot un-send");
    expect(summary).toContain("frees the seats");
  });

  it("gives each known status its own sentence", () => {
    const seen = [
      "awaiting_delivery",
      "classifying",
      "complete",
      "expired",
      "cancelled",
    ].map((status) =>
      inboxRealityTestSummary({
        id: "t",
        subject: "",
        status,
        kind: "",
        createdAt: "",
      }),
    );
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("echoes an unrecognised status rather than inventing one", () => {
    expect(
      inboxRealityTestSummary({
        id: "t",
        subject: "",
        status: "reticulating",
        kind: "",
        createdAt: "",
      }),
    ).toBe("reticulating");
  });
});

describe("parseInboxRealityTests", () => {
  it("reads both envelopes and the camelCase createdAt", () => {
    expect(
      parseInboxRealityTests({ items: [{ id: "t1", createdAt: "today" }] })[0]
        ?.createdAt,
    ).toBe("today");
    expect(
      parseInboxRealityTests({ tests: [{ id: "t1", created_at: "today" }] })[0]
        ?.createdAt,
    ).toBe("today");
    expect(parseInboxRealityTests(null)).toEqual([]);
  });

  it("drops rows with no id and names a subjectless test", () => {
    expect(parseInboxRealityTests([{ status: "complete" }])).toEqual([]);
    expect(parseInboxRealityTests([{ id: "t1" }])[0]?.subject).toBe("(no subject)");
  });
});
