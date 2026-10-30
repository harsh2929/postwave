import { describe, expect, it } from "vitest";

import {
  postureStateExplanation,
  postureStateLabel,
  overduePhrase,
  remainingPhrase,
  eventVerb,
} from "@/lib/complianceLabels";
import {
  compliancePosture,
  daysUntil,
  postureHeadline,
  postureQualifier,
  programPosture,
  RENEWAL_DUE_SOON_DAYS,
} from "@/lib/compliancePosture";
import { normalizeCompliancePrograms } from "@/lib/compliancePrograms";

/** A fixed clock so every day-count assertion is exact. */
const NOW = Date.parse("2026-07-25T12:00:00Z");
const DAY = 86_400_000;

function iso(offsetDays: number): string {
  return new Date(NOW + offsetDays * DAY).toISOString();
}

function program(over: Record<string, unknown> = {}) {
  return {
    framework: "soc2",
    status: "attested",
    signedByEmail: "dana@example.com",
    signerName: "Acme Legal",
    documentPath: "s3://compliance/soc2-2026.pdf",
    documentSha256: "9f2c".repeat(16),
    notes: "",
    attestedAt: iso(-300),
    renewalAt: iso(60),
    updatedAt: iso(-300),
    ...over,
  };
}

function posture(rows: Record<string, unknown>[]) {
  return compliancePosture(
    normalizeCompliancePrograms({ programs: rows }),
    NOW,
  );
}

describe("daysUntil is conservative in both directions", () => {
  it("floors a future delta so a deadline is never rounded towards you", () => {
    // 8.5 days away must read as 8, not 9.
    expect(daysUntil(iso(8.5), NOW)).toBe(8);
  });

  it("floors a past delta so a lapse is never understated", () => {
    // 5.5 days overdue must read as 6 days overdue, not 5.
    expect(daysUntil(iso(-5.5), NOW)).toBe(-6);
  });

  it("answers null — never 0 — for an absent or unparseable date", () => {
    expect(daysUntil("", NOW)).toBeNull();
    expect(daysUntil("not a date", NOW)).toBeNull();
  });
});

describe("a missing renewal date is never an expiry", () => {
  it("is open_ended for a framework that has no renewal by nature", () => {
    // CAN-SPAM is a standing obligation: renewalCadenceMonths is null.
    const row = programPosture(
      normalizeCompliancePrograms({
        programs: [program({ framework: "can_spam", renewalAt: "" })],
      })[0]!,
      NOW,
    );
    expect(row.state).toBe("open_ended");
    expect(row.daysUntilRenewal).toBeNull();
  });

  it("is renewal_unset — a named gap — for one that normally expires", () => {
    const row = programPosture(
      normalizeCompliancePrograms({
        programs: [program({ framework: "soc2", renewalAt: "" })],
      })[0]!,
      NOW,
    );
    expect(row.state).toBe("renewal_unset");
    expect(postureStateExplanation(row)).toContain("every 12 months");
  });

  it("counts neither of them as due soon or lapsed", () => {
    const result = posture([
      program({ framework: "can_spam", renewalAt: "" }),
      program({ framework: "soc2", renewalAt: "" }),
    ]);
    expect(result.dueSoon).toBe(0);
    expect(result.lapsed).toBe(0);
    expect(result.attested).toBe(2);
  });
});

describe("the renewal window", () => {
  it("treats today as due, not lapsed", () => {
    const result = posture([program({ renewalAt: iso(0.2) })]);
    expect(result.dueSoon).toBe(1);
    expect(result.lapsed).toBe(0);
  });

  it("includes the boundary day and excludes the one after it", () => {
    expect(
      posture([program({ renewalAt: iso(RENEWAL_DUE_SOON_DAYS) })]).dueSoon,
    ).toBe(1);
    expect(
      posture([program({ renewalAt: iso(RENEWAL_DUE_SOON_DAYS + 1) })]).current,
    ).toBe(1);
  });

  it("still counts a lapsed attestation as attested, because the record does", () => {
    const result = posture([program({ renewalAt: iso(-9) })]);
    expect(result.lapsed).toBe(1);
    expect(result.attested).toBe(1);
  });
});

describe("HIPAA is excluded from every count", () => {
  const rows = [
    { framework: "hipaa", status: "unsupported", notes: "no BAA offered" },
    program({ framework: "soc2" }),
  ];

  it("keeps it out of the tracked denominator", () => {
    const result = posture(rows);
    expect(result.tracked).toBe(1);
    expect(result.unsupported).toBe(1);
    expect(postureHeadline(result)).toContain("1 tracked framework");
  });

  it("sorts it last however urgent everything else is", () => {
    const result = posture([
      { framework: "hipaa", status: "unsupported" },
      program({ framework: "soc2", renewalAt: iso(-3) }),
    ]);
    expect(result.rows.map((row) => row.program.framework)).toEqual([
      "soc2",
      "hipaa",
    ]);
  });

  it("names the exclusion in the qualifier rather than leaving it silent", () => {
    expect(postureQualifier(posture(rows))).toContain("HIPAA is excluded");
  });
});

describe("in_progress means no record, and never says 'in progress'", () => {
  const result = posture([{ framework: "gdpr", status: "in_progress" }]);

  it("is counted as noRecord, not as attested", () => {
    expect(result.noRecord).toBe(1);
    expect(result.attested).toBe(0);
  });

  it("is labelled and explained as an absent record", () => {
    const row = result.rows[0]!;
    expect(postureStateLabel(row.state)).toBe("No record");
    expect(postureStateExplanation(row)).toContain(
      "No attestation record came back",
    );
    expect(postureStateExplanation(row)).not.toContain("in progress");
  });
});

describe("urgency ordering", () => {
  it("puts lapsed first, then due soon, then everything that is fine", () => {
    const result = posture([
      program({ framework: "iso27001", renewalAt: iso(400) }),
      program({ framework: "ccpa", renewalAt: iso(10) }),
      program({ framework: "soc2", renewalAt: iso(-2) }),
      { framework: "gdpr", status: "in_progress" },
    ]);
    expect(result.rows.map((row) => row.program.framework)).toEqual([
      "soc2",
      "ccpa",
      "gdpr",
      "iso27001",
    ]);
  });

  it("puts the most overdue attestation above a less overdue one", () => {
    const result = posture([
      program({ framework: "ccpa", renewalAt: iso(-2) }),
      program({ framework: "soc2", renewalAt: iso(-40) }),
    ]);
    expect(result.rows[0]?.program.framework).toBe("soc2");
  });
});

describe("the headline names its denominator and states success positively", () => {
  it("leads with what has already lapsed", () => {
    const result = posture([
      program({ framework: "soc2", renewalAt: iso(-2) }),
      program({ framework: "ccpa", renewalAt: iso(5) }),
    ]);
    expect(postureHeadline(result)).toBe(
      "1 of 2 tracked frameworks is past its own renewal date.",
    );
  });

  it("falls through to what is about to lapse", () => {
    const result = posture([
      program({ framework: "soc2", renewalAt: iso(5) }),
      program({ framework: "ccpa", renewalAt: iso(500) }),
    ]);
    expect(postureHeadline(result)).toBe(
      "1 of 2 tracked frameworks renews within 30 days.",
    );
  });

  it("says 'no record came back' rather than accusing the workspace", () => {
    const result = posture([
      { framework: "soc2", status: "in_progress" },
      { framework: "ccpa", status: "in_progress" },
    ]);
    expect(postureHeadline(result)).toBe(
      "No attestation record came back for any of the 2 tracked frameworks.",
    );
  });

  it("states the all-clear positively rather than as a zero", () => {
    const result = posture([
      program({ framework: "soc2", renewalAt: iso(200) }),
      program({ framework: "ccpa", renewalAt: iso(300) }),
    ]);
    expect(postureHeadline(result)).toBe(
      "All 2 tracked frameworks have an attestation on file, and none renews within 30 days.",
    );
  });
});

describe("the qualifier names every category the headline skipped", () => {
  it("surfaces an attested framework with no renewal date on file", () => {
    const result = posture([
      program({ framework: "soc2", renewalAt: "" }),
      program({ framework: "ccpa", renewalAt: iso(500) }),
    ]);
    // The headline can only talk about lapsed/due/attested counts, so the one
    // framework with no expiry date would otherwise be invisible.
    expect(postureQualifier(result)).toContain("no renewal date on file");
  });

  it("surfaces a withdrawn attestation and an unmodelled status", () => {
    const result = posture([
      { framework: "soc2", status: "revoked" },
      { framework: "ccpa", status: "pending_review" },
    ]);
    const qualifier = postureQualifier(result);
    expect(qualifier).toContain("withdrawn");
    expect(qualifier).toContain("does not recognise");
    expect(result.unknown).toBe(1);
  });
});

describe("phrasing never prints a negative day count", () => {
  it("reads a lapse as elapsed time", () => {
    expect(overduePhrase(-6)).toBe("6 days ago");
    expect(overduePhrase(-1)).toBe("yesterday");
  });

  it("reads a deadline as remaining time", () => {
    expect(remainingPhrase(8)).toBe("in 8 days");
    expect(remainingPhrase(1)).toBe("tomorrow");
    expect(remainingPhrase(0)).toBe("today");
  });

  it("admits an absent date rather than inventing one", () => {
    expect(remainingPhrase(null)).toBe("on a date that was not recorded");
  });
});

describe("ledger verbs", () => {
  it("renders the CHECK constraint's four types plus an unknown one", () => {
    expect(eventVerb("attested")).toBe("Attested");
    expect(eventVerb("renewed")).toBe("Renewed");
    expect(eventVerb("revoked")).toBe("Withdrawn");
    // `amended` is in the constraint but no handler writes it.
    expect(eventVerb("amended")).toBe("Amended");
    expect(eventVerb("something_new")).toBe("Recorded");
  });
});
