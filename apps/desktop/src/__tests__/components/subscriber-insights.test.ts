/**
 * subscriber-insights — pure logic behind the 2026-06-11 Subscribers
 * wiring (#9 email validation, #17 lifecycle rollup, #19 contact
 * rating, #22 sunset policies).
 *
 * High-stakes invariants:
 *   1. suggestEmailFix never "corrects" an unrecognized domain and
 *      never fires on an already-correct address (honest-UI: the hint
 *      is opt-in, so a wrong hint is worse than none).
 *   2. buildLifecycleView accounts for EVERY counted subscriber —
 *      stages missing from the catalog are appended, never dropped.
 *   3. validateSunsetPolicyInput mirrors the server bounds (30..730)
 *      so the form can't submit something the API will reject.
 *   4. summarizeSunsetRun reports server numbers verbatim — zero
 *      candidates reads as zero, never massaged.
 */

import { describe, expect, it } from "vitest";

import type {
  EmailValidationResult,
  SubscriberRatingView,
} from "../../lib/api-client";
import type { SunsetRunSummary } from "../../lib/api/sunset";
import {
  SUNSET_INACTIVE_DAYS_MAX,
  SUNSET_INACTIVE_DAYS_MIN,
  buildLifecycleView,
  describeSunsetCriteria,
  parseExcludedTags,
  ratingSignalRows,
  ratingSourceLabel,
  suggestEmailFix,
  summarizeSunsetRun,
  summarizeValidationResults,
  validateSunsetPolicyInput,
  verdictLabel,
} from "../../components/subscribers/subscriber-insights";

/* ---------- #9 suggestEmailFix -------------------------------------- */

describe("suggestEmailFix", () => {
  it("fixes common gmail typos, preserving the local part", () => {
    expect(suggestEmailFix("jane.doe+tag@gmial.com")).toBe(
      "jane.doe+tag@gmail.com",
    );
    expect(suggestEmailFix("a@gamil.com")).toBe("a@gmail.com");
    expect(suggestEmailFix("a@gmail.co")).toBe("a@gmail.com");
  });

  it("fixes hotmail / yahoo / outlook / icloud typos", () => {
    expect(suggestEmailFix("x@hotmial.com")).toBe("x@hotmail.com");
    expect(suggestEmailFix("x@yaho.com")).toBe("x@yahoo.com");
    expect(suggestEmailFix("x@outlok.com")).toBe("x@outlook.com");
    expect(suggestEmailFix("x@iclod.com")).toBe("x@icloud.com");
  });

  it("fixes TLD typos only when the result is a known domain", () => {
    expect(suggestEmailFix("x@gmail.con")).toBe("x@gmail.com");
    expect(suggestEmailFix("x@yahoo.cmo")).toBe("x@yahoo.com");
    // example.con could be example.com — but we don't know that domain,
    // so no suggestion (never invent a correction).
    expect(suggestEmailFix("x@example.con")).toBeNull();
  });

  it("strips a trailing dot on a known domain", () => {
    expect(suggestEmailFix("x@gmail.com.")).toBe("x@gmail.com");
  });

  it("is case-insensitive on the domain", () => {
    expect(suggestEmailFix("x@GMIAL.COM")).toBe("x@gmail.com");
  });

  it("returns null for correct addresses", () => {
    expect(suggestEmailFix("jane@gmail.com")).toBeNull();
    expect(suggestEmailFix("ops@example.org")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(suggestEmailFix("")).toBeNull();
    expect(suggestEmailFix("no-at-sign")).toBeNull();
    expect(suggestEmailFix("@gmail.com")).toBeNull();
    expect(suggestEmailFix("x@")).toBeNull();
  });
});

/* ---------- #9 batch summary ----------------------------------------- */

function result(
  email: string,
  valid: boolean,
  verdict: string,
): EmailValidationResult {
  return {
    email,
    valid,
    verdict,
    has_mx: valid,
    disposable: verdict === "disposable",
    role_account: verdict === "role_account",
    reasons: valid ? [] : [verdict],
  };
}

describe("summarizeValidationResults", () => {
  it("counts valid / invalid and buckets by verdict", () => {
    const s = summarizeValidationResults([
      result("a@x.com", true, "ok"),
      result("b@x.com", true, "ok"),
      result("c@x.com", false, "no_mx"),
      result("d@x.com", false, "disposable"),
      result("e@x.com", false, "no_mx"),
    ]);
    expect(s.total).toBe(5);
    expect(s.valid).toBe(2);
    expect(s.invalid).toBe(3);
    expect(s.byVerdict).toEqual({ ok: 2, no_mx: 2, disposable: 1 });
  });

  it("handles an empty result set", () => {
    const s = summarizeValidationResults([]);
    expect(s).toEqual({ total: 0, valid: 0, invalid: 0, byVerdict: {} });
  });
});

describe("verdictLabel", () => {
  it("labels the known verdicts", () => {
    expect(verdictLabel("ok")).toBe("Deliverable");
    expect(verdictLabel("syntax_invalid")).toBe("Invalid syntax");
    expect(verdictLabel("no_mx")).toBe("No mail server (MX)");
    expect(verdictLabel("disposable")).toBe("Disposable domain");
    expect(verdictLabel("role_account")).toBe("Role account");
  });

  it("passes unknown verdicts through verbatim (never mislabels)", () => {
    expect(verdictLabel("greylisted")).toBe("greylisted");
  });
});

/* ---------- #17 lifecycle view --------------------------------------- */

describe("buildLifecycleView", () => {
  const stages = ["subscriber", "lead", "customer"];

  it("zero-fills catalog stages with no subscribers, in catalog order", () => {
    const v = buildLifecycleView([{ stage: "customer", count: 4 }], stages);
    expect(v.rows.map((r) => r.stage)).toEqual(stages);
    expect(v.rows.map((r) => r.count)).toEqual([0, 0, 4]);
    expect(v.total).toBe(4);
  });

  it("appends distribution stages missing from the catalog (never drops counts)", () => {
    const v = buildLifecycleView(
      [
        { stage: "lead", count: 2 },
        { stage: "vip_legacy", count: 3 },
      ],
      stages,
    );
    expect(v.rows.map((r) => r.stage)).toEqual([
      "subscriber",
      "lead",
      "customer",
      "vip_legacy",
    ]);
    expect(v.total).toBe(5);
    // Every counted subscriber is accounted for in the rows.
    expect(v.rows.reduce((s, r) => s + r.count, 0)).toBe(5);
  });

  it("computes percentages that sum to 100 (when total > 0)", () => {
    const v = buildLifecycleView(
      [
        { stage: "subscriber", count: 1 },
        { stage: "lead", count: 3 },
      ],
      stages,
    );
    const sum = v.rows.reduce((s, r) => s + r.pct, 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it("returns all-zero pct on an empty distribution (no NaN)", () => {
    const v = buildLifecycleView([], stages);
    expect(v.total).toBe(0);
    for (const r of v.rows) {
      expect(r.pct).toBe(0);
      expect(Number.isNaN(r.pct)).toBe(false);
    }
  });

  it("merges duplicate stage rows additively", () => {
    const v = buildLifecycleView(
      [
        { stage: "lead", count: 2 },
        { stage: "lead", count: 3 },
      ],
      stages,
    );
    expect(v.rows.find((r) => r.stage === "lead")?.count).toBe(5);
    expect(v.total).toBe(5);
  });
});

/* ---------- #19 rating signals ---------------------------------------- */

describe("ratingSignalRows", () => {
  it("renders the full breakdown for a heuristic rating", () => {
    const view: SubscriberRatingView = {
      subscriber_id: "s1",
      stars: 4,
      engagement_score: 72,
      engagement_score_at: "2026-06-01T00:00:00Z",
      source: "heuristic",
    };
    const rows = ratingSignalRows(view);
    expect(rows).toEqual([
      { label: "Stars", value: "4/5" },
      { label: "Engagement score", value: "72/100" },
      { label: "Score computed", value: "2026-06-01T00:00:00Z" },
      {
        label: "Source",
        value: "Heuristic — derived from the engagement score",
      },
    ]);
  });

  it("is honest about missing signals (no fabricated zeros)", () => {
    const rows = ratingSignalRows({
      subscriber_id: "s2",
      source: "manual",
    });
    expect(rows.find((r) => r.label === "Stars")?.value).toBe("Unrated");
    expect(rows.find((r) => r.label === "Engagement score")?.value).toBe(
      "No engagement signal yet",
    );
    // No computed-at row when the timestamp is absent.
    expect(rows.some((r) => r.label === "Score computed")).toBe(false);
  });

  it("passes unknown sources through verbatim", () => {
    expect(ratingSourceLabel("imported")).toBe("imported");
  });
});

/* ---------- #22 sunset ------------------------------------------------ */

describe("validateSunsetPolicyInput", () => {
  const ok = {
    name: "12-month sunset",
    inactiveDays: 365,
    action: "suppress",
  };

  it("accepts a valid input", () => {
    expect(validateSunsetPolicyInput(ok)).toEqual({});
  });

  it("requires a non-blank name", () => {
    expect(validateSunsetPolicyInput({ ...ok, name: "  " })["name"]).toBeTruthy();
  });

  it("enforces the server's 30..730 inactiveDays bounds", () => {
    expect(
      validateSunsetPolicyInput({
        ...ok,
        inactiveDays: SUNSET_INACTIVE_DAYS_MIN - 1,
      })["inactiveDays"],
    ).toBeTruthy();
    expect(
      validateSunsetPolicyInput({
        ...ok,
        inactiveDays: SUNSET_INACTIVE_DAYS_MAX + 1,
      })["inactiveDays"],
    ).toBeTruthy();
    expect(
      validateSunsetPolicyInput({
        ...ok,
        inactiveDays: SUNSET_INACTIVE_DAYS_MIN,
      }),
    ).toEqual({});
    expect(
      validateSunsetPolicyInput({
        ...ok,
        inactiveDays: SUNSET_INACTIVE_DAYS_MAX,
      }),
    ).toEqual({});
  });

  it("rejects fractional and NaN inactiveDays", () => {
    expect(
      validateSunsetPolicyInput({ ...ok, inactiveDays: 90.5 })["inactiveDays"],
    ).toBeTruthy();
    expect(
      validateSunsetPolicyInput({ ...ok, inactiveDays: Number.NaN })[
        "inactiveDays"
      ],
    ).toBeTruthy();
  });

  it("whitelists the action", () => {
    expect(
      validateSunsetPolicyInput({ ...ok, action: "delete" })["action"],
    ).toBeTruthy();
    for (const action of ["suppress", "tag", "winback"]) {
      expect(validateSunsetPolicyInput({ ...ok, action })).toEqual({});
    }
  });
});

describe("parseExcludedTags", () => {
  it("trims, drops empties, and dedupes", () => {
    expect(parseExcludedTags(" vip ,, paying , vip ")).toEqual([
      "vip",
      "paying",
    ]);
    expect(parseExcludedTags("")).toEqual([]);
  });
});

describe("describeSunsetCriteria", () => {
  it("describes the threshold + action + exclusions", () => {
    expect(
      describeSunsetCriteria({
        inactiveDays: 180,
        action: "tag",
        excludedTags: ["vip"],
      }),
    ).toBe("Inactive ≥ 180 days → Tag for review · excludes vip");
  });

  it("passes unknown actions through verbatim", () => {
    expect(
      describeSunsetCriteria({
        inactiveDays: 90,
        action: "archive",
        excludedTags: [],
      }),
    ).toBe("Inactive ≥ 90 days → archive");
  });
});

describe("summarizeSunsetRun", () => {
  const base: SunsetRunSummary = {
    policyId: "p1",
    startedAt: "2026-06-11T00:00:00Z",
    completedAt: "2026-06-11T00:00:01Z",
    candidatesSeen: 0,
    byAction: {},
  };

  it("reports zero candidates verbatim (stub-store honesty)", () => {
    expect(summarizeSunsetRun(base)).toBe("0 candidates seen");
  });

  it("formats per-action counts and errors", () => {
    expect(
      summarizeSunsetRun({
        ...base,
        candidatesSeen: 12,
        byAction: { suppress: 10, tag: 2 },
        errors: ["one bad row"],
      }),
    ).toBe("12 candidates seen · suppress: 10 · tag: 2 · 1 error");
  });

  it("singularizes one candidate", () => {
    expect(
      summarizeSunsetRun({ ...base, candidatesSeen: 1 }),
    ).toBe("1 candidate seen");
  });
});
