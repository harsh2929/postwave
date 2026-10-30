import { describe, expect, it } from "vitest";

import {
  cadenceSentence,
  centsToMajor,
  churnBand,
  isThinEvidence,
  nextOrderProjection,
  nextOrderSentence,
  normalizeChurnDrivers,
  normalizeOrderCadence,
  normalizePrediction,
  predictionSpokenSummary,
  sufficiencyNote,
} from "./subscriberPrediction";

const money = (n: number) => `$${n.toFixed(2)}`;

describe("normalizePrediction — absence is not zero", () => {
  it("returns null when the worker never scored this address", () => {
    expect(normalizePrediction(undefined)).toBeNull();
    expect(normalizePrediction(null)).toBeNull();
  });

  it("returns null for an empty object rather than an all-zero card", () => {
    expect(normalizePrediction({})).toBeNull();
  });

  it("does not invent zeros for a payload that carries only churn", () => {
    const out = normalizePrediction({ churn_risk: 0.7 });
    expect(out).not.toBeNull();
    expect(out?.value).toBeNull();
    expect(out?.churnRisk).toBe(0.7);
    expect(out?.confidence).toBeNull();
  });

  it("treats the three CLV figures as ONE fact", () => {
    // A payload missing predicted_clv_cents cannot render a trustworthy
    // money row, so `value` goes null instead of showing historic alone.
    const out = normalizePrediction({
      historic_clv_cents: 12_345,
      total_clv_cents: 20_000,
      churn_risk: 0.1,
    });
    expect(out?.value).toBeNull();
    expect(out?.churnRisk).toBe(0.1);
  });

  it("converts cents to major units", () => {
    const out = normalizePrediction({
      historic_clv_cents: 12_345,
      predicted_clv_cents: 7_655,
      total_clv_cents: 20_000,
    });
    expect(out?.value).toEqual({
      historic: 123.45,
      predicted: 76.55,
      total: 200,
    });
  });

  it("keeps a genuine zero CLV distinct from a missing one", () => {
    const out = normalizePrediction({
      historic_clv_cents: 0,
      predicted_clv_cents: 0,
      total_clv_cents: 0,
      data_sufficiency: "sufficient",
    });
    expect(out?.value).toEqual({ historic: 0, predicted: 0, total: 0 });
  });

  it("ignores an unrecognised data_sufficiency band", () => {
    expect(
      normalizePrediction({ churn_risk: 0.2, data_sufficiency: "meh" })
        ?.sufficiency,
    ).toBeNull();
  });
});

describe("centsToMajor", () => {
  it("rejects non-finite input", () => {
    expect(centsToMajor("500")).toBeNull();
    expect(centsToMajor(Number.NaN)).toBeNull();
    expect(centsToMajor(undefined)).toBeNull();
  });
});

describe("normalizeChurnDrivers", () => {
  it("drops rows with no human label", () => {
    expect(
      normalizeChurnDrivers([
        { key: "recency_days", value: "182" },
        { key: "recency_days", label: "No opens in 6 months", value: "182" },
      ]),
    ).toEqual([
      {
        key: "recency_days",
        label: "No opens in 6 months",
        value: "182",
        impact: "unknown",
      },
    ]);
  });

  it("narrows the impact band and falls back to unknown", () => {
    const out = normalizeChurnDrivers([
      { key: "a", label: "A", impact: "HIGH" },
      { key: "b", label: "B", impact: "critical" },
    ]);
    expect(out.map((d) => d.impact)).toEqual(["high", "unknown"]);
  });

  it("returns an empty array for a non-array", () => {
    expect(normalizeChurnDrivers("high")).toEqual([]);
    expect(normalizeChurnDrivers(undefined)).toEqual([]);
  });
});

describe("churnBand", () => {
  it("is null when there is no risk to band", () => {
    expect(churnBand(null)).toBeNull();
  });

  it("bands at the desktop thresholds", () => {
    expect(churnBand(0)?.key).toBe("low");
    expect(churnBand(0.32)?.key).toBe("low");
    expect(churnBand(0.33)?.key).toBe("elevated");
    expect(churnBand(0.65)?.key).toBe("elevated");
    expect(churnBand(0.66)?.key).toBe("high");
    expect(churnBand(1)?.key).toBe("high");
  });

  it("always carries a spoken label beside the tone", () => {
    for (const risk of [0, 0.5, 0.9]) {
      const band = churnBand(risk);
      expect(band?.label).toBeTruthy();
      expect(band?.tone).toBeTruthy();
    }
  });
});

describe("sufficiencyNote", () => {
  it("says nothing when the model had enough history", () => {
    expect(sufficiencyNote("sufficient")).toBeNull();
  });

  it("caveats a thin run", () => {
    expect(sufficiencyNote("limited")).toMatch(/directional/i);
    expect(sufficiencyNote("insufficient")).toMatch(/not enough history/i);
  });

  it("stays silent on an unknown band rather than inventing a caveat", () => {
    expect(sufficiencyNote(null)).toBeNull();
  });

  it("isThinEvidence agrees with the note", () => {
    expect(isThinEvidence("insufficient")).toBe(true);
    expect(isThinEvidence("limited")).toBe(true);
    expect(isThinEvidence("sufficient")).toBe(false);
    expect(isThinEvidence(null)).toBe(false);
  });
});

describe("nextOrderProjection", () => {
  const now = Date.parse("2026-07-25T12:00:00Z");

  it("is null for an absent or unparseable instant", () => {
    expect(nextOrderProjection(undefined, now)).toBeNull();
    expect(nextOrderProjection("", now)).toBeNull();
    expect(nextOrderProjection("not-a-date", now)).toBeNull();
  });

  it("counts whole days forward", () => {
    const out = nextOrderProjection("2026-08-01T12:00:00Z", now);
    expect(out?.days).toBe(7);
    expect(out?.overdue).toBe(false);
  });

  it("marks a passed window overdue", () => {
    const out = nextOrderProjection("2026-07-20T12:00:00Z", now);
    expect(out?.days).toBe(-5);
    expect(out?.overdue).toBe(true);
  });
});

describe("normalizeOrderCadence", () => {
  it("rejects a zero or negative cadence as an unpopulated trait", () => {
    expect(normalizeOrderCadence({ average_days_between_orders: 0 })).toBeNull();
    expect(
      normalizeOrderCadence({ average_days_between_orders: -3 }),
    ).toBeNull();
  });

  it("keeps a real cadence and its computed-at stamp", () => {
    expect(
      normalizeOrderCadence({
        average_days_between_orders: 42.5,
        last_computed_at: "2026-07-01T00:00:00Z",
      }),
    ).toEqual({ averageDays: 42.5, lastComputedAt: "2026-07-01T00:00:00Z" });
  });

  it("is null for a non-object", () => {
    expect(normalizeOrderCadence(null)).toBeNull();
    expect(normalizeOrderCadence(42)).toBeNull();
  });
});

describe("nextOrderSentence", () => {
  const now = Date.parse("2026-07-25T12:00:00Z");
  const fmt = (iso: string) => iso.slice(0, 10);

  it("says TODAY rather than 'in 0 days'", () => {
    const p = nextOrderProjection("2026-07-25T20:00:00Z", now)!;
    expect(nextOrderSentence(p, fmt)).toBe(
      "Next order expected today — 2026-07-25",
    );
  });

  it("uses the singular for one day, in both directions", () => {
    const ahead = nextOrderProjection("2026-07-26T12:00:00Z", now)!;
    expect(nextOrderSentence(ahead, fmt)).toContain("in 1 day —");
    const behind = nextOrderProjection("2026-07-24T12:00:00Z", now)!;
    expect(nextOrderSentence(behind, fmt)).toContain("1 day ago");
  });

  it("prints an overdue window as a positive magnitude, not a minus", () => {
    const p = nextOrderProjection("2026-07-15T12:00:00Z", now)!;
    const sentence = nextOrderSentence(p, fmt);
    expect(sentence).toContain("10 days ago");
    expect(sentence).not.toContain("-10");
  });
});

describe("cadenceSentence", () => {
  it("rounds to whole days and pluralises", () => {
    expect(cadenceSentence({ averageDays: 30.4, lastComputedAt: null }, () => ""))
      .toBe("Orders roughly every 30 days");
    expect(cadenceSentence({ averageDays: 1.2, lastComputedAt: null }, () => ""))
      .toBe("Orders roughly every 1 day");
  });

  it("appends the measurement date only when there is one", () => {
    expect(
      cadenceSentence(
        { averageDays: 14, lastComputedAt: "2026-07-01T00:00:00Z" },
        (iso) => iso.slice(0, 10),
      ),
    ).toBe("Orders roughly every 14 days · measured 2026-07-01");
  });
});

describe("predictionSpokenSummary", () => {
  it("speaks only the facts that are present", () => {
    const p = normalizePrediction({ churn_risk: 0.8 });
    expect(p).not.toBeNull();
    const spoken = predictionSpokenSummary(p!, money);
    expect(spoken).toContain("High risk");
    expect(spoken).toContain("80 percent");
    expect(spoken).not.toContain("lifetime value");
  });

  it("leads with the headline figure when money is present", () => {
    const p = normalizePrediction({
      historic_clv_cents: 10_000,
      predicted_clv_cents: 5_000,
      total_clv_cents: 15_000,
      churn_risk: 0.1,
      confidence: 0.9,
      data_sufficiency: "sufficient",
    });
    const spoken = predictionSpokenSummary(p!, money);
    expect(spoken).toContain("Total predicted lifetime value $150.00");
    expect(spoken).toContain("$100.00 realised so far");
    expect(spoken).toContain("model confidence 90 percent");
    // A sufficient run earns no caveat.
    expect(spoken).not.toMatch(/directional|not enough history/i);
  });

  it("carries the thin-evidence caveat into the spoken sentence", () => {
    const p = normalizePrediction({
      historic_clv_cents: 100,
      predicted_clv_cents: 100,
      total_clv_cents: 200,
      data_sufficiency: "insufficient",
    });
    expect(predictionSpokenSummary(p!, money)).toMatch(/not enough history/i);
  });
});
