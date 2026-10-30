import { describe, expect, it } from "vitest";

import {
  dmarcPolicyAdvice,
  domainsOf,
  matchesDisposition,
  passRate,
  policyLabel,
  policyTone,
  reportAge,
  reportDateRange,
  summarise,
  type DmarcRowLike,
} from "./dmarcView";

function row(overrides: Partial<DmarcRowLike> = {}): DmarcRowLike {
  return {
    domain: "example.com",
    orgName: "google.com",
    policyP: "reject",
    policyPct: "100",
    dateBegin: "2026-07-20T00:00:00Z",
    dateEnd: "2026-07-21T00:00:00Z",
    passCount: 100,
    failCount: 0,
    receivedAt: "2026-07-21T06:00:00Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-21T12:00:00Z");

describe("reportAge", () => {
  it("measures against the CALLER's clock, so the label can tick", () => {
    const early = reportAge("2026-07-21T11:30:00Z", NOW);
    const later = reportAge("2026-07-21T11:30:00Z", NOW + 3 * 3600_000);
    expect(early).not.toBe(later);
  });

  it("returns null for missing or unparseable input", () => {
    expect(reportAge(null, NOW)).toBeNull();
    expect(reportAge("not-a-date", NOW)).toBeNull();
  });
});

describe("reportDateRange", () => {
  it("never renders Invalid Date", () => {
    expect(reportDateRange("nope", "nope")).toBe("—");
  });

  it("keeps the year on the end when the ends differ", () => {
    const out = reportDateRange("2025-12-31T00:00:00Z", "2026-01-01T00:00:00Z");
    expect(out).toContain("→");
    expect(out).toMatch(/2026/);
  });
});

describe("policyLabel", () => {
  it("keeps a sampling rate below 100, because it changes the meaning", () => {
    expect(policyLabel({ policyP: "reject", policyPct: "25" })).toBe(
      "p=Reject 25%",
    );
  });

  it("omits the rate at full sampling and returns null with no policy", () => {
    expect(policyLabel({ policyP: "quarantine", policyPct: "100" })).toBe(
      "p=Quarantine",
    );
    expect(policyLabel({ policyP: "", policyPct: "" })).toBeNull();
  });

  it("tones reject as good and none as neutral", () => {
    expect(policyTone({ policyP: "reject" })).toBe("success");
    expect(policyTone({ policyP: "quarantine" })).toBe("warning");
    expect(policyTone({ policyP: "none" })).toBe("neutral");
  });
});

describe("passRate", () => {
  it("never says 100% pass while failures exist", () => {
    const out = passRate(999_993, 7);
    expect(out.display).toBe(99);
    expect(out.tone).toBe("warning");
  });

  it("reports a clean set as 100% and success", () => {
    const out = passRate(100, 0);
    expect(out.label).toBe("100% pass");
    expect(out.tone).toBe("success");
  });

  it("treats an empty report as no data, not as 0% pass", () => {
    const out = passRate(0, 0);
    expect(out.label).toBe("No data");
    expect(out.tone).toBe("neutral");
  });

  it("tones a badly failing report as danger", () => {
    expect(passRate(50, 50).tone).toBe("danger");
  });
});

describe("matchesDisposition", () => {
  it("keeps a zero-data row out of BOTH passing and failing", () => {
    const empty = { passCount: 0, failCount: 0 };
    expect(matchesDisposition(empty, "passing")).toBe(false);
    expect(matchesDisposition(empty, "failing")).toBe(false);
    expect(matchesDisposition(empty, "all")).toBe(true);
  });

  it("routes healthy and failing rows correctly", () => {
    expect(matchesDisposition({ passCount: 10, failCount: 0 }, "passing")).toBe(
      true,
    );
    expect(matchesDisposition({ passCount: 10, failCount: 1 }, "failing")).toBe(
      true,
    );
  });
});

describe("summarise", () => {
  it("states the window instead of an arbitrary row count", () => {
    const out = summarise([row(), row({ passCount: 5, failCount: 2 })], {
      windowLabel: "30 days",
      now: NOW,
    });
    expect(out.caption).toContain("2 reports in the last 30 days");
    expect(out.passing).toBe(105);
    expect(out.failing).toBe(2);
  });

  it("finds the newest receivedAt even when rows are unordered", () => {
    const out = summarise(
      [
        row({ receivedAt: "2026-07-19T00:00:00Z" }),
        row({ receivedAt: "2026-07-21T11:00:00Z" }),
        row({ receivedAt: "" }),
      ],
      { windowLabel: "7 days", now: NOW },
    );
    expect(out.lastReceived).not.toBeNull();
    expect(out.caption).toContain("newest");
  });

  it("says '1 report' for a single row", () => {
    expect(
      summarise([row()], { windowLabel: "7 days", now: NOW }).caption,
    ).toContain("1 report in the last");
  });
});

describe("domainsOf", () => {
  it("de-duplicates and sorts", () => {
    expect(
      domainsOf([
        row({ domain: "b.com" }),
        row({ domain: "a.com" }),
        row({ domain: "b.com" }),
        row({ domain: "  " }),
      ]),
    ).toEqual(["a.com", "b.com"]);
  });
});

describe("dmarcPolicyAdvice", () => {
  it("advises per observed policy and always carries the boundary", () => {
    for (const [policy, label] of [
      ["none", "p=none · monitoring"],
      ["QUARANTINE", "p=quarantine"],
      [" reject ", "p=reject"],
    ] as const) {
      const advice = dmarcPolicyAdvice(policy, "example.com");
      expect(advice.label).toBe(label);
      expect(advice.boundary).toMatch(/Observation only/);
      expect(advice.boundary).toMatch(/not a live DNS lookup/);
    }
  });

  it("treats a missing policy as an evidence gap, not a DNS conclusion", () => {
    const advice = dmarcPolicyAdvice("", "example.com");
    expect(advice.label).toBe("No policy observed in window");
    expect(advice.context).toMatch(/evidence gap/);
  });

  it("names an unrecognized value instead of guessing a policy", () => {
    expect(dmarcPolicyAdvice("unknown", "example.com").label).toBe(
      "Policy value not recognized",
    );
  });

  it("asks for a single domain when the scope is tenant-wide", () => {
    expect(dmarcPolicyAdvice("", "").label).toBe("Multiple-domain scope");
  });
});
