// Evidence-pack schedule helpers (roadmap R10): recipient parsing
// (split on comma/space/semicolon, case-insensitive de-dupe, invalid
// tokens surfaced verbatim) and pre-flight validation mirroring the
// server's invalid_schedule rules (cadence whitelist, 1..10 recipients).

import { describe, expect, it } from "vitest";

import {
  EVIDENCE_SCHEDULE_MAX_RECIPIENTS,
  parseRecipients,
  scheduleSummary,
  validateScheduleInput,
} from "../../components/audit/evidence-schedules-helpers";

describe("parseRecipients", () => {
  it("splits on commas, semicolons, and whitespace", () => {
    expect(
      parseRecipients("a@x.com, b@y.org;c@z.io\nd@w.net").emails,
    ).toEqual(["a@x.com", "b@y.org", "c@z.io", "d@w.net"]);
  });

  it("de-dupes case-insensitively but keeps the first spelling", () => {
    const r = parseRecipients("Audit@Corp.com audit@corp.com");
    expect(r.emails).toEqual(["Audit@Corp.com"]);
    expect(r.invalid).toEqual([]);
  });

  it("surfaces non-email tokens verbatim", () => {
    const r = parseRecipients("good@x.com not-an-email @nope");
    expect(r.emails).toEqual(["good@x.com"]);
    expect(r.invalid).toEqual(["not-an-email", "@nope"]);
  });

  it("returns empty sets for blank input", () => {
    expect(parseRecipients("  ")).toEqual({ emails: [], invalid: [] });
  });
});

describe("validateScheduleInput", () => {
  const ok = parseRecipients("a@x.com");

  it("accepts a valid weekly/monthly draft", () => {
    expect(validateScheduleInput("weekly", ok)).toBeNull();
    expect(validateScheduleInput("monthly", ok)).toBeNull();
  });

  it("rejects unknown cadences", () => {
    expect(validateScheduleInput("daily", ok)).toContain("weekly or monthly");
  });

  it("rejects invalid tokens before empty-recipient check", () => {
    const r = parseRecipients("nope");
    expect(validateScheduleInput("weekly", r)).toContain("nope");
  });

  it("requires at least one and at most 10 recipients", () => {
    expect(validateScheduleInput("weekly", parseRecipients(""))).toContain(
      "At least one",
    );
    const eleven = Array.from(
      { length: EVIDENCE_SCHEDULE_MAX_RECIPIENTS + 1 },
      (_, i) => `r${i}@x.com`,
    ).join(",");
    expect(validateScheduleInput("weekly", parseRecipients(eleven))).toContain(
      "At most 10",
    );
  });
});

describe("scheduleSummary", () => {
  it("labels cadence and pluralizes recipients", () => {
    expect(scheduleSummary("weekly", ["a@x.com"])).toBe("Weekly · 1 recipient");
    expect(scheduleSummary("monthly", ["a@x.com", "b@y.com"])).toBe(
      "Monthly · 2 recipients",
    );
  });

  it("passes unknown cadences through verbatim", () => {
    expect(scheduleSummary("hourly", [])).toBe("hourly · 0 recipients");
  });
});
