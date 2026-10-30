// Predictive-analytics helpers (KLV-07): CLV aggregation over the loaded
// profiles slice, top-N sorting by predicted value vs churn risk, the
// honest low-sample gate, and guarded next-order date formatting.

import { describe, expect, it } from "vitest";

import {
  aggregateCLV,
  fmtDate,
  isLowSufficiency,
  predictiveProfileLabel,
  sortProfiles,
} from "../../components/analytics/predictive-analytics";
import type { PredictivePrediction } from "../../lib/api-client";

function pred(over: Partial<PredictivePrediction>): PredictivePrediction {
  return {
    email: "a@example.com",
    historic_clv_cents: 1000,
    predicted_clv_cents: 2000,
    total_clv_cents: 3000,
    churn_risk: 0.2,
    predicted_order_count: 2,
    predicted_gender: "unknown",
    confidence: 0.8,
    data_sufficiency: "ok",
    ...over,
  };
}

describe("aggregateCLV", () => {
  it("sums historic, predicted, and total across the slice", () => {
    const t = aggregateCLV([
      pred({
        historic_clv_cents: 100,
        predicted_clv_cents: 200,
        total_clv_cents: 300,
      }),
      pred({
        historic_clv_cents: 50,
        predicted_clv_cents: 25,
        total_clv_cents: 75,
      }),
    ]);
    expect(t).toEqual({
      historicCents: 150,
      predictedCents: 225,
      totalCents: 375,
      count: 2,
    });
  });

  it("treats non-array / nullish input as an empty slice", () => {
    expect(aggregateCLV(null)).toEqual({
      historicCents: 0,
      predictedCents: 0,
      totalCents: 0,
      count: 0,
    });
    expect(aggregateCLV(undefined).count).toBe(0);
  });

  it("coerces malformed numeric fields to 0 (no NaN poisoning)", () => {
    const rows = [
      pred({ historic_clv_cents: 100 }),
      // Simulate a malformed wire row with non-numeric fields.
      {
        ...pred({}),
        historic_clv_cents: NaN,
        predicted_clv_cents: undefined as unknown as number,
      },
    ];
    const t = aggregateCLV(rows);
    expect(Number.isFinite(t.historicCents)).toBe(true);
    expect(t.historicCents).toBe(100);
    expect(Number.isFinite(t.predictedCents)).toBe(true);
  });
});

describe("sortProfiles", () => {
  const rows = [
    pred({ email: "low@x.com", predicted_clv_cents: 100, churn_risk: 0.9 }),
    pred({ email: "high@x.com", predicted_clv_cents: 900, churn_risk: 0.1 }),
    pred({ email: "mid@x.com", predicted_clv_cents: 500, churn_risk: 0.5 }),
  ];

  it("sorts by predicted value, highest first", () => {
    const out = sortProfiles(rows, "value");
    expect(out.map((r) => r.email)).toEqual([
      "high@x.com",
      "mid@x.com",
      "low@x.com",
    ]);
  });

  it("sorts by churn risk, highest first", () => {
    const out = sortProfiles(rows, "risk");
    expect(out.map((r) => r.email)).toEqual([
      "low@x.com",
      "mid@x.com",
      "high@x.com",
    ]);
  });

  it("does not mutate the input array", () => {
    const copy = rows.slice();
    sortProfiles(rows, "value");
    expect(rows).toEqual(copy);
  });

  it("returns [] for non-array input", () => {
    expect(sortProfiles(null, "value")).toEqual([]);
  });
});

describe("isLowSufficiency", () => {
  it("flags low / insufficient sufficiency strings", () => {
    expect(isLowSufficiency("low", 0.9)).toBe(true);
    expect(isLowSufficiency("insufficient", 0.9)).toBe(true);
    expect(isLowSufficiency("LOW", 0.9)).toBe(true);
  });

  it("flags genuinely weak confidence even when string is ok", () => {
    expect(isLowSufficiency("ok", 0.3)).toBe(true);
  });

  it("does not flag healthy confidence/sufficiency", () => {
    expect(isLowSufficiency("ok", 0.8)).toBe(false);
    expect(isLowSufficiency(undefined, undefined)).toBe(false);
    // Zero confidence is not treated as "low" (no signal, not weak signal).
    expect(isLowSufficiency("ok", 0)).toBe(false);
  });
});

describe("fmtDate", () => {
  it("formats a valid ISO date", () => {
    expect(fmtDate("2026-07-15T00:00:00Z")).not.toBe("—");
  });

  it("returns em-dash for absent or unparseable values", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate("")).toBe("—");
    expect(fmtDate("not-a-date")).toBe("—");
  });
});

describe("predictiveProfileLabel", () => {
  it("prefers a shortened opaque id and otherwise masks the email", () => {
    expect(
      predictiveProfileLabel(
        pred({ subscriber_id: "subscriber-123456789", email: "raw@test" }),
      ),
    ).toBe("Subscriber …23456789");
    expect(predictiveProfileLabel(pred({ email: "alice@example.test" }))).toBe(
      "a•••@example.test",
    );
  });
});
