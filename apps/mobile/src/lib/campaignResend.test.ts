import { describe, expect, it } from "vitest";

import {
  MIN_RESEND_HOURS,
  RESEND_SUBJECT_MAX,
  defaultResendSubject,
  earliestResendAt,
  resendPlan,
  resendTimingLabel,
  validateResendSubject,
} from "./campaignResend";

describe("defaultResendSubject", () => {
  it("prefixes the original", () => {
    expect(defaultResendSubject("Spring Sale")).toBe("Re: Spring Sale");
  });

  it("does not stack a second prefix", () => {
    expect(defaultResendSubject("Re: Spring Sale")).toBe("Re: Spring Sale");
    expect(defaultResendSubject("RE:Spring")).toBe("RE:Spring");
  });

  it("handles an empty original", () => {
    expect(defaultResendSubject("")).toBe("");
    expect(defaultResendSubject(null)).toBe("");
  });

  it("respects the subject ceiling", () => {
    expect(defaultResendSubject("s".repeat(400))).toHaveLength(
      RESEND_SUBJECT_MAX,
    );
  });
});

describe("validateResendSubject", () => {
  it("rejects an empty subject", () => {
    expect(validateResendSubject("  ", "Spring")).toBeTruthy();
  });

  it("rejects a subject identical to the original, case-insensitively", () => {
    expect(validateResendSubject("Spring Sale", "spring sale")).toContain(
      "different subject",
    );
    expect(validateResendSubject("  Spring Sale ", "Spring Sale")).toBeTruthy();
  });

  it("accepts a genuinely different subject", () => {
    expect(validateResendSubject("Re: Spring Sale", "Spring Sale")).toBeNull();
  });

  it("rejects an over-long subject", () => {
    expect(validateResendSubject("s".repeat(201), "orig")).toContain("too long");
  });

  it("accepts anything non-empty when the original is unknown", () => {
    expect(validateResendSubject("Anything", null)).toBeNull();
  });
});

describe("earliestResendAt / resendPlan", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");

  it("floors at 24 hours from now", () => {
    expect(earliestResendAt(now).toISOString()).toBe(
      "2026-07-26T12:00:00.000Z",
    );
  });

  it("RAISES a too-early pick to the floor rather than accepting it", () => {
    const plan = resendPlan({
      subject: " Re: Sale ",
      sendAt: new Date(now + 60 * 60 * 1000),
      now,
    });
    expect(plan.sendAt).toBe("2026-07-26T12:00:00.000Z");
    expect(plan.subject).toBe("Re: Sale");
  });

  it("keeps a later pick untouched", () => {
    const later = new Date(now + 72 * 60 * 60 * 1000);
    expect(resendPlan({ subject: "x", sendAt: later, now }).sendAt).toBe(
      later.toISOString(),
    );
  });

  it("passes null through for a deliberate send-now", () => {
    expect(resendPlan({ subject: "x", sendAt: null, now }).sendAt).toBeNull();
  });

  it("treats an invalid date as too-early and floors it", () => {
    expect(
      resendPlan({ subject: "x", sendAt: new Date("nope"), now }).sendAt,
    ).toBe("2026-07-26T12:00:00.000Z");
  });
});

describe("resendTimingLabel", () => {
  it("warns when there is no delay", () => {
    expect(resendTimingLabel(null)).toContain("not recommended");
  });

  it("states the delay otherwise", () => {
    expect(resendTimingLabel(new Date())).toContain(String(MIN_RESEND_HOURS));
  });
});
