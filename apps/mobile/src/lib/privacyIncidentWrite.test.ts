/**
 * The pure half of the incident writes: validation that mirrors the server
 * field-for-field, the idempotency-key lifecycle, and the expected-from rule.
 * Every bound here is the server's bound (incidents.go), so a drifted constant
 * is a request the server will refuse — or worse, one it will accept that the
 * client claimed it would not send.
 */
import { describe, expect, it } from "vitest";

import {
  containsUnsafeNarrativeControl,
  declareKeyAfterFailure,
  INCIDENT_REASON_MAX_RUNES,
  INCIDENT_SEVERITY_OPTIONS,
  INCIDENT_SUMMARY_MAX_RUNES,
  incidentReasonIssue,
  incidentSummaryIssue,
  transitionExpectedFrom,
  transitionNeedsFreshRead,
} from "@/lib/privacyIncidentWrite";

describe("severity options", () => {
  it("mirrors the server enum and leads with the ungraded default", () => {
    expect(INCIDENT_SEVERITY_OPTIONS.map((o) => o.value)).toEqual([
      "investigating",
      "low",
      "medium",
      "high",
      "critical",
    ]);
  });
});

describe("narrative validation mirrors incidents.go", () => {
  it("requires a non-blank summary and reason", () => {
    expect(incidentSummaryIssue("   ")).toBe("A summary is required.");
    expect(incidentReasonIssue("")).toBe("A reason is required.");
    expect(incidentSummaryIssue("Vendor exposed an export")).toBeNull();
    expect(incidentReasonIssue("Key rotated; access revoked")).toBeNull();
  });

  it("enforces the server's rune ceilings, counting code points", () => {
    expect(INCIDENT_SUMMARY_MAX_RUNES).toBe(4000);
    expect(INCIDENT_REASON_MAX_RUNES).toBe(2000);
    // 2000 astral characters are 4000 UTF-16 units but exactly at the rune
    // cap — a .length check would wrongly refuse this.
    expect(incidentReasonIssue("𝒜".repeat(2000))).toBeNull();
    expect(incidentReasonIssue("a".repeat(2001))).toContain("at most 2,000");
    expect(incidentSummaryIssue("a".repeat(4001))).toContain("at most 4,000");
  });

  it("rejects NUL and bidirectional formatting characters", () => {
    for (const bad of ["\u0000", "\u202e", "\u2066", "\u200f", "\u061c"]) {
      expect(containsUnsafeNarrativeControl(`ok${bad}ok`)).toBe(true);
      expect(incidentReasonIssue(`ok${bad}ok`)).toContain(
        "control or direction-formatting",
      );
    }
    expect(containsUnsafeNarrativeControl("plain text — ok")).toBe(false);
  });
});

describe("declare idempotency-key lifecycle", () => {
  it("reuses the key when the outcome is ambiguous", () => {
    expect(declareKeyAfterFailure({ status: 0 })).toBe("reuse");
    expect(declareKeyAfterFailure({ status: 500 })).toBe("reuse");
    expect(declareKeyAfterFailure({ status: 503 })).toBe("reuse");
    expect(declareKeyAfterFailure({ status: 429 })).toBe("reuse");
    expect(declareKeyAfterFailure({ status: undefined })).toBe("reuse");
  });

  it("rotates the key after a definite rejection", () => {
    expect(declareKeyAfterFailure({ status: 400 })).toBe("rotate");
    expect(declareKeyAfterFailure({ status: 403 })).toBe("rotate");
    expect(declareKeyAfterFailure({ status: 409 })).toBe("rotate");
  });
});

describe("expected_from", () => {
  it("prefers the verified detail over the list row and never invents", () => {
    expect(transitionExpectedFrom("contained", "open")).toBe("contained");
    expect(transitionExpectedFrom(null, "open")).toBe("open");
    expect(transitionExpectedFrom(null, null)).toBeNull();
    expect(transitionExpectedFrom(undefined, undefined)).toBeNull();
  });

  it("names exactly the conflict codes that demand a fresh read", () => {
    expect(transitionNeedsFreshRead("stale_incident_state")).toBe(true);
    expect(transitionNeedsFreshRead("transition_conflict")).toBe(true);
    expect(transitionNeedsFreshRead("no_op")).toBe(true);
    expect(transitionNeedsFreshRead("invalid_transition")).toBe(true);
    expect(transitionNeedsFreshRead("missing_reason")).toBe(false);
    expect(transitionNeedsFreshRead(undefined)).toBe(false);
  });
});
