/**
 * campaigns-row-actions — pure logic behind the Campaigns list row
 * actions (#10 resend-unopened, #11 clone).
 *
 * High-stakes invariants (all mirror apps/api/internal/resend_unopened):
 *   1. Eligibility matches the page's Sent semantics — "sent" OR
 *      "running" — so the Resend button appears exactly where the
 *      backend can actually materialize a non-opener audience.
 *   2. The default subject "Re: <original>" must always pass the
 *      server's case-insensitive duplicate_subject check.
 *   3. validateResendSubject mirrors the handler: subject required,
 *      and must differ from the original after trim + case-fold.
 *   4. MIN_RESEND_HOURS matches the Go MinHoursBetweenSends constant
 *      (24) — the modal copy quotes it.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_RESEND_HOURS,
  defaultResendSubject,
  isResendEligible,
  validateResendSubject,
} from "../pages/campaigns-row-actions";

describe("isResendEligible", () => {
  it("allows sent and running campaigns (case-insensitive)", () => {
    expect(isResendEligible("sent")).toBe(true);
    expect(isResendEligible("running")).toBe(true);
    expect(isResendEligible("Sent")).toBe(true);
  });

  it("rejects drafts, scheduled, failed, and unknown statuses", () => {
    expect(isResendEligible("draft")).toBe(false);
    expect(isResendEligible("scheduled")).toBe(false);
    expect(isResendEligible("failed")).toBe(false);
    expect(isResendEligible(undefined)).toBe(false);
    expect(isResendEligible("")).toBe(false);
  });
});

describe("defaultResendSubject", () => {
  it("prefixes the original with Re:", () => {
    expect(defaultResendSubject("Spring sale")).toBe("Re: Spring sale");
    expect(defaultResendSubject("  padded  ")).toBe("Re: padded");
  });

  it("returns empty when there is no original subject", () => {
    expect(defaultResendSubject(undefined)).toBe("");
    expect(defaultResendSubject("   ")).toBe("");
  });

  it("always passes the duplicate-subject validation it feeds into", () => {
    for (const original of ["Spring sale", "RE: hi", "x"]) {
      expect(
        validateResendSubject(defaultResendSubject(original), original),
      ).toBeNull();
    }
  });
});

describe("validateResendSubject", () => {
  it("requires a non-empty subject (server: missing_subject)", () => {
    expect(validateResendSubject("", "Original")).toBeTruthy();
    expect(validateResendSubject("   ", "Original")).toBeTruthy();
  });

  it("rejects subjects equal to the original, case-insensitively", () => {
    expect(validateResendSubject("Original", "Original")).toBeTruthy();
    expect(validateResendSubject("  original ", "ORIGINAL")).toBeTruthy();
  });

  it("accepts any genuinely different subject", () => {
    expect(validateResendSubject("Re: Original", "Original")).toBeNull();
    expect(validateResendSubject("Fresh take", "Original")).toBeNull();
  });

  it("accepts anything non-empty when the original subject is unknown", () => {
    expect(validateResendSubject("New subject", undefined)).toBeNull();
    expect(validateResendSubject("New subject", "")).toBeNull();
  });
});

describe("MIN_RESEND_HOURS", () => {
  it("matches resend_unopened.MinHoursBetweenSends", () => {
    expect(MIN_RESEND_HOURS).toBe(24);
  });
});
