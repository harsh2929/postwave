import { describe, expect, it } from "vitest";

import {
  MIN_IMPRESSIONS_PER_ARM,
  formVariantVerdict,
  formVariantsErrorMessage,
  formVariantsSectionHidden,
  normalizeFormVariants,
} from "./formVariants";

const arm = (
  id: string,
  impressions: number,
  rate: number,
  status = "exploring",
) => ({
  id,
  label: id,
  status,
  impressions,
  submissions: Math.round(impressions * rate),
  conversionRate: rate,
  trafficPct: 50,
});

describe("normalizeFormVariants", () => {
  it("clamps the wire rate into 0..1 and floors the counts", () => {
    const rows = normalizeFormVariants([
      {
        id: "a",
        label: "  Big CTA  ",
        conversionRate: 1.7,
        impressions: 10.9,
        submissions: -3,
        trafficPct: 60,
        status: "promoted",
      },
    ]);
    expect(rows[0]).toEqual({
      id: "a",
      label: "Big CTA",
      status: "promoted",
      statusLabel: "Promoted",
      impressions: 10,
      submissions: 0,
      rate: 1,
      trafficPct: 60,
    });
  });

  it("names an unlabelled variant by position and flags unknown statuses", () => {
    const rows = normalizeFormVariants([
      { id: "a" },
      { id: "b", status: "retired" },
    ]);
    expect(rows[0]?.label).toBe("Variant 1");
    expect(rows[1]?.status).toBe("unknown");
    expect(rows[1]?.statusLabel).toBe("Unknown");
  });

  it("drops malformed rows and non-arrays", () => {
    expect(normalizeFormVariants(null)).toEqual([]);
    expect(
      normalizeFormVariants([null as never, { id: 4 as unknown as string }]),
    ).toEqual([]);
  });
});

describe("formVariantVerdict", () => {
  it("says there is nothing to compare with fewer than two arms", () => {
    expect(formVariantVerdict([], null).hint).toContain("No display variants");
    expect(
      formVariantVerdict(normalizeFormVariants([{ id: "a" }]), null).hint,
    ).toContain("nothing to compare");
  });

  it("refuses to call a winner below the server's sample floor, whatever z says", () => {
    // z = 9 would be wildly "significant" — on 10 impressions it means nothing,
    // which is exactly what form_variants.MinSampleForPromotion exists for.
    const rows = normalizeFormVariants([arm("a", 10, 1), arm("b", 10, 0)]);
    const verdict = formVariantVerdict(rows, { id: "p", zScore: 9 });
    expect(verdict.significant).toBe(false);
    expect(verdict.collecting).toBe(true);
    expect(verdict.hint).toContain(String(MIN_IMPRESSIONS_PER_ARM));
  });

  it("counts how many arms are short", () => {
    const rows = normalizeFormVariants([
      arm("a", 10, 0.2),
      arm("b", 10, 0.1),
      arm("c", 500, 0.1),
    ]);
    expect(formVariantVerdict(rows, null).hint).toContain("2 variants have");
    const oneShort = normalizeFormVariants([arm("a", 10, 0.2), arm("b", 500, 0.1)]);
    expect(formVariantVerdict(oneShort, null).hint).toContain(
      "one variant has",
    );
  });

  it("says 'not evaluated yet' when there is traffic but no z-score", () => {
    const rows = normalizeFormVariants([arm("a", 500, 0.2), arm("b", 500, 0.1)]);
    const verdict = formVariantVerdict(rows, null);
    expect(verdict.significant).toBe(false);
    expect(verdict.collecting).toBe(false);
    expect(verdict.hint).toContain("not been evaluated");
    expect(verdict.leaderId).toBe("a");
  });

  it("calls a leader inconclusive below the z cutoff", () => {
    const rows = normalizeFormVariants([arm("a", 500, 0.2), arm("b", 500, 0.19)]);
    const verdict = formVariantVerdict(rows, { id: "p", zScore: 1.1 });
    expect(verdict.significant).toBe(false);
    expect(verdict.hint).toContain("within noise");
  });

  it("calls a winner once both floors are cleared", () => {
    const rows = normalizeFormVariants([arm("a", 900, 0.3), arm("b", 900, 0.1)]);
    const verdict = formVariantVerdict(rows, {
      id: "p",
      zScore: -4.2,
      winnerVariantId: "a",
    });
    expect(verdict.significant).toBe(true);
    expect(verdict.leaderId).toBe("a");
    expect(verdict.hint).toContain("95% confident");
  });

  it("uses the absolute z-score — direction lives in winnerVariantId", () => {
    const rows = normalizeFormVariants([arm("a", 900, 0.3), arm("b", 900, 0.1)]);
    expect(
      formVariantVerdict(rows, { id: "p", zScore: -2.5 }).significant,
    ).toBe(true);
  });
});

describe("formVariantsErrorMessage", () => {
  it("names the reporting scope, which differs from the rest of the screen", () => {
    expect(formVariantsErrorMessage(403)).toContain("reporting access");
  });

  it("calls an unmounted route unavailable and otherwise falls back", () => {
    expect(formVariantsErrorMessage(501)).toContain("doesn't expose");
    expect(formVariantsErrorMessage(500, "boom")).toBe("boom");
    expect(formVariantsErrorMessage(0)).toBe("Couldn't load variant results.");
  });
});

describe("formVariantsSectionHidden", () => {
  const base = { errorStatus: 0, loading: false, rowCount: 0, actionable: false };

  it("hides on route-absent statuses for everyone, admins included", () => {
    for (const errorStatus of [404, 405, 501]) {
      expect(
        formVariantsSectionHidden({ ...base, errorStatus, actionable: true }),
      ).toBe(true);
    }
  });

  it("hides a settled empty read for read-only callers only", () => {
    expect(formVariantsSectionHidden(base)).toBe(true);
    // The actionable admin keeps the card — it hosts "Add variant".
    expect(formVariantsSectionHidden({ ...base, actionable: true })).toBe(false);
  });

  it("keeps the card while loading and when rows or real errors exist", () => {
    expect(formVariantsSectionHidden({ ...base, loading: true })).toBe(false);
    expect(formVariantsSectionHidden({ ...base, rowCount: 2 })).toBe(false);
    expect(formVariantsSectionHidden({ ...base, errorStatus: 500 })).toBe(false);
  });
});
