import { describe, expect, it } from "vitest";

import {
  normalizePlanSummary,
  projectionCopy,
  resourcePercent,
  safeBillingRedirectURL,
  usageBarSpoken,
  usageResourceLabel,
} from "./billingNormalize";

describe("normalizePlanSummary", () => {
  it("returns an empty resource list when the field is absent", () => {
    const out = normalizePlanSummary({ tier: "pro" });
    expect(out.resources).toEqual([]);
    expect(out.tier).toBe("pro");
  });

  it("survives a null / non-object payload", () => {
    expect(normalizePlanSummary(null).resources).toEqual([]);
    expect(normalizePlanSummary(undefined).tier).toBe("");
    expect(normalizePlanSummary("nope").resources).toEqual([]);
  });

  it("recomputes percent when the server omits it", () => {
    const out = normalizePlanSummary({
      tier: "studio",
      resources: [{ resource: "monthly_sends", current: 25, limit: 100 }],
    });
    expect(out.resources[0]?.percent).toBe(25);
  });

  it("never produces NaN for a non-numeric percent", () => {
    const out = normalizePlanSummary({
      resources: [
        { resource: "a", current: "x", limit: "y", percent: "definitely-not" },
      ],
    });
    expect(Number.isFinite(out.resources[0]?.percent ?? NaN)).toBe(true);
    expect(out.resources[0]?.percent).toBe(0);
  });

  it("clamps an out-of-range percent to 0..100", () => {
    const out = normalizePlanSummary({
      resources: [
        { resource: "over", current: 300, limit: 100, percent: 300 },
        { resource: "under", current: 0, limit: 100, percent: -5 },
      ],
    });
    expect(out.resources[0]?.percent).toBe(100);
    expect(out.resources[1]?.percent).toBe(0);
  });

  it("drops rows with no resource key rather than rendering a blank label", () => {
    const out = normalizePlanSummary({
      resources: [{ current: 1, limit: 2 }, { resource: "ok", current: 1, limit: 2 }],
    });
    expect(out.resources.map((r) => r.resource)).toEqual(["ok"]);
  });

  it("derives `exceeded` when the server omits it", () => {
    const out = normalizePlanSummary({
      resources: [{ resource: "sends", current: 120, limit: 100 }],
    });
    expect(out.resources[0]?.exceeded).toBe(true);
  });

  it("treats an unlimited row (limit <= 0) as 0 percent, not Infinity", () => {
    expect(resourcePercent({ current: 500, limit: 0 })).toBe(0);
    expect(resourcePercent({ current: 500, limit: -1 })).toBe(0);
  });

  it("normalizes sends_projection and nulls a blank exceed date", () => {
    const out = normalizePlanSummary({
      resources: [],
      sends_projection: {
        current: 10,
        limit: 100,
        avg_per_day: 5,
        days_elapsed: 2,
        days_in_period: 30,
        projected_end_of_period: 150,
        projected_exceed_date: "   ",
        on_track_to_exceed: true,
      },
    });
    expect(out.sends_projection?.projected_exceed_date).toBeNull();
    expect(out.sends_projection?.avg_per_day).toBe(5);
  });

  it("omits sends_projection entirely when the server does not send it", () => {
    expect(normalizePlanSummary({ resources: [] }).sends_projection).toBeUndefined();
  });
});

describe("projectionCopy", () => {
  const base = {
    current: 10,
    limit: 100,
    avg_per_day: 5,
    days_elapsed: 2,
    days_in_period: 30,
    projected_end_of_period: 150,
    projected_exceed_date: null as string | null,
    on_track_to_exceed: false,
  };

  it("is null with no projection at all", () => {
    expect(projectionCopy(undefined)).toBeNull();
  });

  it("says so rather than extrapolating when avg_per_day is 0", () => {
    const copy = projectionCopy({ ...base, avg_per_day: 0 });
    expect(copy?.tone).toBe("neutral");
    expect(copy?.exceedDate).toBeNull();
    expect(copy?.text).toMatch(/Not enough sending/);
  });

  it("says so when no days have elapsed", () => {
    expect(projectionCopy({ ...base, days_elapsed: 0 })?.text).toMatch(
      /Not enough sending/,
    );
  });

  it("warns with the server's date when one was given", () => {
    const copy = projectionCopy({
      ...base,
      on_track_to_exceed: true,
      projected_exceed_date: "2026-08-24",
    });
    expect(copy?.tone).toBe("warning");
    expect(copy?.exceedDate).toBe("2026-08-24");
    expect(copy?.text).toMatch(/On pace to pass the send cap around /);
    expect(copy?.text).toMatch(/estimate/);
  });

  it("never invents a date when the server flagged risk without one", () => {
    const copy = projectionCopy({ ...base, on_track_to_exceed: true });
    expect(copy?.tone).toBe("warning");
    expect(copy?.exceedDate).toBeNull();
    expect(copy?.text).toBe(
      "On pace to pass the send cap this period — about 150 sends (estimate).",
    );
  });

  it("is neutral, and still labelled an estimate, when not on track", () => {
    const copy = projectionCopy(base);
    expect(copy?.tone).toBe("neutral");
    expect(copy?.text).toBe("On pace for about 150 sends this period (estimate).");
  });
});

describe("usageBarSpoken", () => {
  it("reads one sentence including the over-limit state", () => {
    expect(
      usageBarSpoken({
        resource: "monthly_sends",
        current: 120,
        limit: 100,
        percent: 100,
        exceeded: true,
      }),
    ).toBe("Monthly sends: 120 of 100 used, 100 percent. Over the plan limit.");
  });

  it("says unlimited instead of a percentage for an uncapped row", () => {
    expect(
      usageBarSpoken({
        resource: "lists",
        current: 4,
        limit: 0,
        percent: 0,
        exceeded: false,
      }),
    ).toBe("Lists: 4 used, unlimited.");
  });
});

describe("usageResourceLabel", () => {
  it("humanises a snake_case key", () => {
    expect(usageResourceLabel("monthly_sends")).toBe("Monthly sends");
  });
});

describe("safeBillingRedirectURL", () => {
  it("accepts a Stripe billing portal URL", () => {
    expect(
      safeBillingRedirectURL("https://billing.stripe.com/session/abc"),
    ).toBe("https://billing.stripe.com/session/abc");
  });

  it("accepts a stripe.com subdomain", () => {
    expect(safeBillingRedirectURL("https://pay.stripe.com/x")).toBe(
      "https://pay.stripe.com/x",
    );
  });

  it("rejects a lookalike host", () => {
    expect(safeBillingRedirectURL("https://stripe.com.evil.test/x")).toBeNull();
  });

  it("rejects non-https schemes including javascript:", () => {
    expect(safeBillingRedirectURL("http://billing.stripe.com/x")).toBeNull();
     
    expect(safeBillingRedirectURL("javascript:alert(1)")).toBeNull();
    expect(safeBillingRedirectURL("moosewave://billing")).toBeNull();
  });

  it("accepts the workspace's own host for the local portal fallback", () => {
    expect(
      safeBillingRedirectURL(
        "https://api.example.test/app/billing?portal=local",
        "https://api.example.test",
      ),
    ).toBe("https://api.example.test/app/billing?portal=local");
  });

  it("rejects an unrelated host even with a base url present", () => {
    expect(
      safeBillingRedirectURL("https://evil.test/x", "https://api.example.test"),
    ).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(safeBillingRedirectURL("")).toBeNull();
    expect(safeBillingRedirectURL(null)).toBeNull();
    expect(safeBillingRedirectURL("not a url")).toBeNull();
    expect(safeBillingRedirectURL(42)).toBeNull();
  });
});
