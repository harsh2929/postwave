import { describe, expect, it } from "vitest";

import {
  funnelBarSpoken,
  funnelBars,
  funnelBaseCount,
  funnelUnavailableReason,
  funnelWindowLabel,
  parseSubscriberFunnel,
} from "@/lib/subscriberFunnel";

/**
 * Shaped exactly like the handler's `SubscriberFunnel`
 * (apps/api/internal/analytics/analytics.go:1643). Rates are 0..100 because
 * `pct()` multiplies by 100 — the single most dangerous detail in this
 * contract.
 */
const PAYLOAD = {
  bucket: "month",
  cohort_by: "created_at_month",
  steps: [
    { stage: "signup", label: "Signed Up", count: 1000, conversion_rate: 100 },
    {
      stage: "first_purchase",
      label: "First Purchase",
      count: 250,
      conversion_rate: 25,
    },
    {
      stage: "repeat_purchase",
      label: "Repeat Purchase",
      count: 100,
      conversion_rate: 40,
    },
  ],
  cohorts: [
    { cohort_label: "2026-07", signup_count: 400 },
    { cohort_label: "2026-06", signup_count: 600 },
  ],
};

describe("parseSubscriberFunnel", () => {
  it("reads the handler's envelope", () => {
    const funnel = parseSubscriberFunnel(PAYLOAD);
    expect(funnel.steps.map((s) => s.stage)).toEqual([
      "signup",
      "first_purchase",
      "repeat_purchase",
    ]);
    expect(funnel.steps[1]?.count).toBe(250);
    expect(funnel.steps[1]?.conversionPct).toBe(25);
    expect(funnel.cohortCount).toBe(2);
  });

  it("keeps a missing count as null rather than zero", () => {
    const funnel = parseSubscriberFunnel({
      steps: [{ stage: "signup", label: "Signed Up" }],
    });
    expect(funnel.steps[0]?.count).toBeNull();
    expect(funnel.steps[0]?.conversionPct).toBeNull();
  });

  it("clamps an impossible conversion instead of printing 180%", () => {
    const funnel = parseSubscriberFunnel({
      steps: [{ stage: "x", label: "X", count: 1, conversion_rate: 180 }],
    });
    expect(funnel.steps[0]?.conversionPct).toBe(100);
  });

  it("drops a stage with no id and survives a garbage payload", () => {
    expect(
      parseSubscriberFunnel({ steps: [{ label: "orphan" }] }).steps,
    ).toEqual([]);
    expect(parseSubscriberFunnel(null).steps).toEqual([]);
    expect(parseSubscriberFunnel("nope").cohortCount).toBe(0);
    expect(parseSubscriberFunnel({ steps: 7 }).steps).toEqual([]);
  });
});

describe("funnelBars", () => {
  it("sizes every bar against SIGNUP, not against the previous stage", () => {
    const bars = funnelBars(parseSubscriberFunnel(PAYLOAD));
    expect(bars.map((b) => Math.round(b.widthPct))).toEqual([100, 25, 10]);
    // The last step's own conversion is 40% of the stage above it; drawing it
    // at 40% width would be four times its true share of signups.
    expect(bars[2]?.conversionPct).toBe(40);
  });

  it("draws no bar at all for an unreported count", () => {
    const bars = funnelBars(
      parseSubscriberFunnel({
        steps: [
          { stage: "signup", label: "Signed Up", count: 10 },
          { stage: "first_purchase", label: "First Purchase" },
        ],
      }),
    );
    expect(bars[1]?.count).toBeNull();
    expect(bars[1]?.widthPct).toBe(0);
  });

  it("cannot divide by a zero or absent base", () => {
    const zeroBase = funnelBars(
      parseSubscriberFunnel({
        steps: [
          { stage: "signup", label: "Signed Up", count: 0 },
          { stage: "first_purchase", label: "First Purchase", count: 0 },
        ],
      }),
    );
    expect(zeroBase.every((b) => Number.isFinite(b.widthPct))).toBe(true);
    expect(zeroBase.map((b) => b.widthPct)).toEqual([0, 0]);
  });
});

describe("funnelBaseCount", () => {
  it("prefers the signup stage over position", () => {
    const funnel = parseSubscriberFunnel({
      steps: [
        { stage: "first_purchase", label: "First Purchase", count: 4 },
        { stage: "signup", label: "Signed Up", count: 99 },
      ],
    });
    expect(funnelBaseCount(funnel)).toBe(99);
  });
});

describe("funnelUnavailableReason", () => {
  it("permits a funnel with real conversions", () => {
    expect(funnelUnavailableReason(parseSubscriberFunnel(PAYLOAD))).toBeNull();
  });

  it("refuses to draw a store-less workspace as a total collapse", () => {
    const reason = funnelUnavailableReason(
      parseSubscriberFunnel({
        steps: [
          { stage: "signup", label: "Signed Up", count: 4200, conversion_rate: 100 },
          { stage: "first_purchase", label: "First Purchase", count: 0, conversion_rate: 0 },
          { stage: "repeat_purchase", label: "Repeat Purchase", count: 0, conversion_rate: 0 },
        ],
      }),
    );
    expect(reason).toContain("matched to subscribers by email address");
  });

  it("refuses a funnel with no base measurement", () => {
    expect(
      funnelUnavailableReason(
        parseSubscriberFunnel({
          steps: [
            { stage: "signup", label: "Signed Up" },
            { stage: "first_purchase", label: "First Purchase", count: 3 },
          ],
        }),
      ),
    ).toContain("signup total");
  });

  it("refuses a single-stage payload", () => {
    expect(
      funnelUnavailableReason(
        parseSubscriberFunnel({
          steps: [{ stage: "signup", label: "Signed Up", count: 5 }],
        }),
      ),
    ).toContain("not reported a subscriber funnel");
  });
});

describe("funnelWindowLabel", () => {
  it("says MONTHS, because the server reads `weeks` as months", () => {
    expect(funnelWindowLabel(12, 3)).toBe(
      "Across the last 12 signup months · 3 cohorts with signups.",
    );
    expect(funnelWindowLabel(1, 1)).toBe(
      "Across the last signup month · 1 cohort with signups.",
    );
    expect(funnelWindowLabel(6, 0)).toBe("Across the last 6 signup months.");
  });
});

describe("funnelBarSpoken", () => {
  it("says the exact figure and both denominators", () => {
    const bars = funnelBars(parseSubscriberFunnel(PAYLOAD));
    const spoken = funnelBarSpoken(bars[1] as never, 1000);
    expect(spoken).toContain("First Purchase, 250");
    expect(spoken).toContain("25 percent of signups");
    expect(spoken).toContain("25.0 percent of the previous stage");
  });

  it("says 'not reported' rather than reading a zero", () => {
    expect(
      funnelBarSpoken(
        { stage: "x", label: "X", count: null, widthPct: 0, conversionPct: null },
        100,
      ),
    ).toBe("X, not reported.");
  });
});
