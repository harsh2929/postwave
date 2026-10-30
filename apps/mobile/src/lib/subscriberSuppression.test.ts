import { describe, expect, it } from "vitest";

import {
  matchSuppressionForEmail,
  suppressionSpokenSummary,
} from "./subscriberSuppression";

describe("matchSuppressionForEmail", () => {
  const row = {
    id: "sup-1",
    email: "Ada@Example.com",
    reason: "hard_bounce",
    created_at: "2026-07-01T10:00:00Z",
  };

  it("matches case-insensitively and normalises the address", () => {
    expect(matchSuppressionForEmail([row], "ADA@example.COM")).toEqual({
      id: "sup-1",
      email: "ada@example.com",
      reason: "hard_bounce",
      createdAt: "2026-07-01T10:00:00Z",
    });
  });

  it("refuses to claim a suppression for a DIFFERENT address", () => {
    // A gateway build that ignores `email=` returns the unfiltered first
    // page. Trusting it would paint a danger banner on a deliverable
    // contact — the one failure mode this guard exists for.
    expect(matchSuppressionForEmail([row], "grace@example.com")).toBeNull();
  });

  it("is null for an empty page, missing input, or junk rows", () => {
    expect(matchSuppressionForEmail([], "ada@example.com")).toBeNull();
    expect(matchSuppressionForEmail(undefined, "ada@example.com")).toBeNull();
    expect(matchSuppressionForEmail([row], "")).toBeNull();
    expect(matchSuppressionForEmail([row], undefined)).toBeNull();
    expect(matchSuppressionForEmail([null, 7, "x"], "ada@example.com")).toBeNull();
  });

  it("tolerates a row with no reason or timestamp", () => {
    expect(
      matchSuppressionForEmail([{ email: "ada@example.com" }], "ada@example.com"),
    ).toEqual({
      id: "ada@example.com",
      email: "ada@example.com",
      reason: "",
      createdAt: "",
    });
  });

  it("scans past non-matching rows to find the right one", () => {
    expect(
      matchSuppressionForEmail(
        [{ email: "grace@example.com" }, row],
        "ada@example.com",
      )?.id,
    ).toBe("sup-1");
  });
});

describe("suppressionSpokenSummary", () => {
  it("speaks reason and date", () => {
    expect(suppressionSpokenSummary("Hard bounce", "3 days ago")).toBe(
      "Suppressed. Reason: Hard bounce. Added 3 days ago.",
    );
  });

  it("says the date is unknown rather than inventing one", () => {
    expect(suppressionSpokenSummary("Hard bounce", "")).toBe(
      "Suppressed. Reason: Hard bounce. Date unknown.",
    );
  });

  it("falls back to 'unknown' for a blank reason", () => {
    expect(suppressionSpokenSummary("", "today")).toBe(
      "Suppressed. Reason: unknown. Added today.",
    );
  });
});
