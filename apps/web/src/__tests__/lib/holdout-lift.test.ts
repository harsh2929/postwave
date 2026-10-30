// SPDX-License-Identifier: AGPL-3.0-only
//
// A holdout answers "what did this campaign CAUSE" rather than "what happened
// after it". That only holds while the comparison is powered, so the rule the
// server already enforces — an underpowered test reports that it is
// underpowered INSTEAD OF a number — has to survive into the client. A UI
// handed a number will render it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

import {
  createHoldout,
  deleteHoldout,
  liftVerdict,
  getHoldout,
  getHoldoutLift,
  holdoutReadiness,
  formatSignedPercent,
  validateHoldoutInput,
  type Holdout,
  type HoldoutLift,
  type HoldoutSignificance,
} from "@/lib/holdout-lift";

beforeEach(() => {
  Object.values(apiMocks).forEach((mock) => mock.mockReset());
});

function significance(
  over: Partial<HoldoutSignificance> = {},
): HoldoutSignificance {
  return {
    control_rate: 0.05,
    treatment_rate: 0.07,
    absolute_lift: 0.02,
    relative_lift: 0.4,
    incremental_conversions: 180,
    p_value: 0.001,
    ci_low: 0.01,
    ci_high: 0.03,
    powered: true,
    minimum_detectable_effect: 0.008,
    underpowered_reason: "",
    ...over,
  };
}

function lift(over: Partial<HoldoutLift> = {}): HoldoutLift {
  return {
    campaign_id: "c1",
    percent: 10,
    status: "decided",
    held_out_subs: 1000,
    sent_subs: 9000,
    held_out_clicks: 50,
    sent_clicks: 630,
    held_out_click_rate: 0.05,
    sent_click_rate: 0.07,
    approximate: false,
    significance: significance(),
    incremental_lift: 0.02,
    lift_percent: 0.4,
    ...over,
  };
}

describe("liftVerdict", () => {
  it("reports a measured result when the comparison is powered", () => {
    const verdict = liftVerdict(lift());
    expect(verdict.kind).toBe("measured");
    if (verdict.kind !== "measured") return;
    expect(verdict.absoluteLift).toBe(0.02);
    expect(verdict.interval).toEqual({ low: 0.01, high: 0.03 });
  });

  // The headline claim of the whole feature. An underpowered test that renders
  // "+40% lift" is worse than showing nothing, because it will be quoted.
  it("withholds the number entirely when underpowered", () => {
    const verdict = liftVerdict(
      lift({
        significance: significance({
          powered: false,
          absolute_lift: null,
          underpowered_reason: "control arm too small to detect a 5% effect",
        }),
      }),
    );
    expect(verdict.kind).toBe("underpowered");
    expect(JSON.stringify(verdict)).not.toContain("0.4");
    if (verdict.kind !== "underpowered") return;
    expect(verdict.reason).toMatch(/control arm/);
  });

  // A confidence interval spanning zero means the campaign may have caused
  // nothing. Presenting the point estimate without saying so is the classic
  // way a null result becomes a success story.
  it("flags a powered result whose interval still spans zero", () => {
    const verdict = liftVerdict(
      lift({
        significance: significance({ ci_low: -0.01, ci_high: 0.03 }),
      }),
    );
    expect(verdict.kind).toBe("measured");
    if (verdict.kind !== "measured") return;
    expect(verdict.spansZero).toBe(true);
  });

  it("does not flag an interval that stays above zero", () => {
    const verdict = liftVerdict(lift());
    if (verdict.kind !== "measured") return;
    expect(verdict.spansZero).toBe(false);
  });

  it("reports pending before the holdout is decided", () => {
    expect(liftVerdict(lift({ status: "pending" })).kind).toBe("pending");
  });
});

describe("holdoutReadiness", () => {
  function holdout(over: Partial<Holdout> = {}): Holdout {
    return {
      campaign_id: "c1",
      percent: 10,
      seed: "s",
      held_out_count: 1000,
      sent_count: 9000,
      outcome_metric: "clicked",
      conversion_window_days: 7,
      minimum_relative_effect: 0.05,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      ...over,
    };
  }

  it("is measurable once decided with a frozen assignment ledger", () => {
    const state = holdoutReadiness(
      holdout({
        decided_at: "2026-08-02T00:00:00Z",
        assignment_ledger_sha256: "abc",
        assignment_ledger_version: "v1",
      }),
    );
    expect(state.measurable).toBe(true);
    expect(state.notes).toEqual([]);
  });

  it("is not measurable before the send is decided", () => {
    const state = holdoutReadiness(holdout());
    expect(state.measurable).toBe(false);
    expect(state.notes.join(" ")).toMatch(/not been sent|decided/i);
  });

  // Without a frozen ledger there is no record of WHO was held out, so any
  // later number cannot be reproduced or defended.
  it("warns when no frozen assignment ledger exists", () => {
    const state = holdoutReadiness(holdout({ decided_at: "2026-08-02T00:00:00Z" }));
    expect(state.notes.join(" ")).toMatch(/ledger/i);
  });
});

describe("formatSignedPercent", () => {
  it("keeps the sign so a negative result reads as a loss", () => {
    expect(formatSignedPercent(-0.123)).toBe("−12.3%");
  });

  it("marks an increase explicitly", () => {
    expect(formatSignedPercent(0.4)).toBe("+40.0%");
  });
});

// Creation input. The client mirrors the server's bounds so an operator is
// corrected in the form rather than by a 400 — but the server stays the
// authority, and these bounds are asserted against its constants rather than
// invented here: percent 0..50, window 1..30 days, effect >0..1.
describe("validateHoldoutInput", () => {
  it("accepts a plausible experiment", () => {
    expect(
      validateHoldoutInput({ percent: 10, conversionWindowDays: 7, minimumRelativeEffect: 0.05 }),
    ).toEqual([]);
  });

  // Above 50% the "holdout" is most of the audience, which is a different
  // decision than measuring a campaign.
  it("rejects a holdout larger than half the audience", () => {
    expect(
      validateHoldoutInput({ percent: 60, conversionWindowDays: 7, minimumRelativeEffect: 0.05 }),
    ).toHaveLength(1);
  });

  it("rejects a negative holdout", () => {
    expect(
      validateHoldoutInput({ percent: -1, conversionWindowDays: 7, minimumRelativeEffect: 0.05 }),
    ).toHaveLength(1);
  });

  it("rejects a conversion window outside 1..30 days", () => {
    expect(
      validateHoldoutInput({ percent: 10, conversionWindowDays: 0, minimumRelativeEffect: 0.05 }),
    ).toHaveLength(1);
    expect(
      validateHoldoutInput({ percent: 10, conversionWindowDays: 31, minimumRelativeEffect: 0.05 }),
    ).toHaveLength(1);
  });

  // A minimum detectable effect of 0 means "detect anything", which no sample
  // size can deliver — the test would be underpowered by construction.
  it("rejects a minimum relative effect of zero or above one", () => {
    expect(
      validateHoldoutInput({ percent: 10, conversionWindowDays: 7, minimumRelativeEffect: 0 }),
    ).toHaveLength(1);
    expect(
      validateHoldoutInput({ percent: 10, conversionWindowDays: 7, minimumRelativeEffect: 1.5 }),
    ).toHaveLength(1);
  });

  it("reports every problem at once rather than one per submit", () => {
    expect(
      validateHoldoutInput({ percent: 90, conversionWindowDays: 99, minimumRelativeEffect: 0 }),
    ).toHaveLength(3);
  });
});

describe("holdout path transport", () => {
  it("keeps slash-bearing campaign identifiers inside one encoded segment", async () => {
    apiMocks.get.mockResolvedValue({});
    apiMocks.post.mockResolvedValue({});
    apiMocks.delete.mockResolvedValue(undefined);
    const campaignId = "campaign/team A";

    await getHoldout(campaignId);
    await getHoldoutLift(campaignId);
    await createHoldout(campaignId, {
      percent: 10,
      conversionWindowDays: 7,
      minimumRelativeEffect: 0.05,
    });
    await deleteHoldout(campaignId);

    const segment = "campaign%2Fteam%20A";
    expect(apiMocks.get.mock.calls.map(([path]) => path)).toEqual([
      `/api/v1/campaigns/${segment}/holdout`,
      `/api/v1/campaigns/${segment}/holdout/lift`,
    ]);
    expect(apiMocks.post).toHaveBeenCalledWith(
      `/api/v1/campaigns/${segment}/holdout`,
      expect.any(Object),
      expect.any(Object),
    );
    expect(apiMocks.delete).toHaveBeenCalledWith(
      `/api/v1/campaigns/${segment}/holdout`,
      expect.any(Object),
    );
  });
});
