// Tests for the pure onsite-growth logic behind the Forms Growth
// panel (backlog #49). Weights are basis points (10000 = 100%);
// targeting rule groups are opaque JSON objects edited as raw text.

import { describe, expect, it } from "vitest";

import {
  MAX_EXPERIMENT_VARIANTS,
  TARGETING_RULE_GROUPS,
  buildSpinRewardsInput,
  buildTargetingInput,
  buildVariantsInput,
  experimentEventTotals,
  fmtBasisPoints,
  newSpinRewardDraft,
  newVariantDraft,
  parseRuleGroup,
  ruleGroupText,
  spinDraftWeightSummary,
  spinRewardToDraft,
  spinWeightSummary,
  variantDraftWeightSummary,
  variantEventCounts,
  variantToDraft,
} from "../../components/forms/growth-helpers";
import type {
  OnsiteExperiment,
  OnsiteExperimentVariant,
  OnsiteSpinReward,
} from "../../lib/api-client";

describe("fmtBasisPoints", () => {
  it("formats whole and fractional percentages", () => {
    expect(fmtBasisPoints(10000)).toBe("100%");
    expect(fmtBasisPoints(2500)).toBe("25%");
    expect(fmtBasisPoints(1250)).toBe("12.5%");
    expect(fmtBasisPoints(0)).toBe("0%");
  });
  it("em-dash on missing values", () => {
    expect(fmtBasisPoints(undefined)).toBe("—");
    expect(fmtBasisPoints(null)).toBe("—");
  });
});

describe("spinWeightSummary", () => {
  const reward = (bp: number): OnsiteSpinReward => ({
    key: `r${bp}`,
    label: `Reward ${bp}`,
    weight_basis_points: bp,
  });
  it("flags a complete (=100%) wheel", () => {
    expect(spinWeightSummary([reward(6000), reward(4000)])).toEqual({
      totalBp: 10000,
      complete: true,
    });
  });
  it("flags incomplete or overweight wheels", () => {
    expect(spinWeightSummary([reward(6000)]).complete).toBe(false);
    expect(spinWeightSummary([reward(6000), reward(5000)]).complete).toBe(
      false,
    );
    expect(spinWeightSummary([]).totalBp).toBe(0);
  });
});

describe("variant event counts", () => {
  it("extracts numeric entries sorted by descending count", () => {
    expect(
      variantEventCounts({
        impression: 120,
        submit: 12,
        spin: 30,
        label: "not-a-number",
        nested: { x: 1 },
      }),
    ).toEqual([
      { event: "impression", count: 120 },
      { event: "spin", count: 30 },
      { event: "submit", count: 12 },
    ]);
  });
  it("handles missing metrics", () => {
    expect(variantEventCounts(undefined)).toEqual([]);
  });
});

describe("experimentEventTotals", () => {
  it("rolls variant metrics up across the experiment", () => {
    const exp: OnsiteExperiment = {
      key: "exp-1",
      name: "Headline test",
      variants: [
        {
          key: "control",
          name: "Control",
          traffic_weight_basis_points: 5000,
          metrics: { impression: 100, submit: 10 },
        },
        {
          key: "b",
          name: "Variant B",
          traffic_weight_basis_points: 5000,
          metrics: { impression: 90, submit: 14 },
        },
      ],
    };
    expect(experimentEventTotals(exp)).toEqual([
      { event: "impression", count: 190 },
      { event: "submit", count: 24 },
    ]);
  });
  it("returns [] when there are no variants", () => {
    expect(
      experimentEventTotals({ key: "x", name: "X" }),
    ).toEqual([]);
  });
});

describe("parseRuleGroup / ruleGroupText", () => {
  it("treats empty text as 'no rules' (undefined, omitted from PUT)", () => {
    expect(parseRuleGroup("")).toEqual({ ok: true, value: undefined });
    expect(parseRuleGroup("   \n ")).toEqual({ ok: true, value: undefined });
  });
  it("accepts JSON objects", () => {
    expect(parseRuleGroup('{"mode":"exit_intent"}')).toEqual({
      ok: true,
      value: { mode: "exit_intent" },
    });
  });
  it("rejects arrays, scalars, and malformed JSON", () => {
    expect(parseRuleGroup("[1,2]").ok).toBe(false);
    expect(parseRuleGroup("42").ok).toBe(false);
    expect(parseRuleGroup("null").ok).toBe(false);
    expect(parseRuleGroup("{nope").ok).toBe(false);
  });
  it("round-trips through ruleGroupText", () => {
    const v = { mode: "scroll", depth_pct: 60 };
    const text = ruleGroupText(v);
    expect(parseRuleGroup(text)).toEqual({ ok: true, value: v });
    expect(ruleGroupText(undefined)).toBe("");
    expect(ruleGroupText({})).toBe("");
  });
});

describe("buildTargetingInput", () => {
  it("assembles status/priority + parsed groups, omitting empties", () => {
    const res = buildTargetingInput(
      { status: "active", priority: 5 },
      { trigger: '{"mode":"delay","seconds":3}', url_rules: "" },
    );
    expect(res).toEqual({
      ok: true,
      input: {
        status: "active",
        priority: 5,
        trigger: { mode: "delay", seconds: 3 },
      },
    });
  });
  it("reports the offending group on a parse failure", () => {
    const res = buildTargetingInput(
      { status: "active", priority: 0 },
      { geo_rules: "{broken" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.group).toBe("geo_rules");
      expect(res.error.length).toBeGreaterThan(0);
    }
  });
  it("covers every wire rule group exactly once (no drift)", () => {
    const keys = TARGETING_RULE_GROUPS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("trigger");
    expect(keys).toContain("custom_trigger_rules");
    // `compiled` is server-derived and must never be editable.
    expect(keys).not.toContain("compiled");
  });
});

/* ---------- #49 spin rewards editor (PUT full-replace) ---------- */

describe("spinRewardToDraft / buildSpinRewardsInput", () => {
  const wireReward: OnsiteSpinReward = {
    id: "rw_1",
    form_id: "f1",
    key: "ten-off",
    label: "10% off",
    reward_type: "coupon",
    weight_basis_points: 2500,
    coupon_pool_id: "pool_1",
    status: "active",
    display: { color: "#fff" },
    sort_order: 3,
  };

  it("projects a wire row into an editable draft", () => {
    const d = spinRewardToDraft(wireReward);
    expect(d.key).toBe("ten-off");
    expect(d.weightText).toBe("2500");
    expect(d.couponKind).toBe("coupon_pool");
    expect(d.couponValue).toBe("pool_1");
    expect(d.base).toBe(wireReward);
  });

  it("prefers the pool over a static code when both exist, else static", () => {
    expect(
      spinRewardToDraft({ ...wireReward, static_code: "SAVE10" }).couponKind,
    ).toBe("coupon_pool");
    expect(
      spinRewardToDraft({
        ...wireReward,
        coupon_pool_id: undefined,
        static_code: "SAVE10",
      }),
    ).toMatchObject({ couponKind: "static_code", couponValue: "SAVE10" });
    expect(
      spinRewardToDraft({ ...wireReward, coupon_pool_id: undefined }).couponKind,
    ).toBe("none");
  });

  it("round-trips untouched wire fields verbatim on build", () => {
    const built = buildSpinRewardsInput([spinRewardToDraft(wireReward)]);
    expect(built.ok).toBe(true);
    if (built.ok) {
      const item = built.items[0]!;
      expect(item.id).toBe("rw_1");
      expect(item.reward_type).toBe("coupon");
      expect(item.display).toEqual({ color: "#fff" });
      expect(item.coupon_pool_id).toBe("pool_1");
      expect(item.static_code).toBeUndefined();
      // sort_order is rewritten to the editor row order.
      expect(item.sort_order).toBe(0);
    }
  });

  it("switching the coupon kind clears the other linkage field", () => {
    const d = spinRewardToDraft(wireReward);
    const built = buildSpinRewardsInput([
      { ...d, couponKind: "static_code", couponValue: "SAVE10" },
    ]);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.items[0]!.static_code).toBe("SAVE10");
      expect(built.items[0]!.coupon_pool_id).toBeUndefined();
    }
  });

  it("builds a brand-new row from an empty draft", () => {
    const built = buildSpinRewardsInput([
      {
        ...newSpinRewardDraft(),
        key: "no-luck",
        label: "Try again",
        weightText: "7500",
      },
    ]);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.items[0]).toMatchObject({
        key: "no-luck",
        label: "Try again",
        weight_basis_points: 7500,
        sort_order: 0,
      });
      expect(built.items[0]!.id).toBeUndefined();
    }
  });

  it("flags the offending row index on per-row failures", () => {
    const ok = {
      ...newSpinRewardDraft(),
      key: "a",
      label: "A",
      weightText: "5000",
    };
    const cases: Array<[Partial<ReturnType<typeof newSpinRewardDraft>>, RegExp]> = [
      [{ label: "B", weightText: "1" }, /Key is required/],
      [{ key: "a", label: "B", weightText: "1" }, /Duplicate key/],
      [{ key: "b", weightText: "1" }, /Label is required/],
      [{ key: "b", label: "B", weightText: "12.5" }, /basis points/],
      [{ key: "b", label: "B", weightText: "-1" }, /basis points/],
      [
        { key: "b", label: "B", weightText: "1", couponKind: "static_code" as const },
        /static coupon code/,
      ],
      [
        { key: "b", label: "B", weightText: "1", couponKind: "coupon_pool" as const },
        /coupon pool id/,
      ],
    ];
    for (const [patch, re] of cases) {
      const res = buildSpinRewardsInput([ok, { ...newSpinRewardDraft(), ...patch }]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.index).toBe(1);
        expect(res.error).toMatch(re);
      }
    }
  });

  it("an empty editor builds an empty full-replace body", () => {
    const res = buildSpinRewardsInput([]);
    expect(res).toEqual({ ok: true, items: [] });
  });
});

describe("spinDraftWeightSummary", () => {
  it("audits the typed weights with the same 10000bp contract", () => {
    const d = (w: string) => ({
      ...newSpinRewardDraft(),
      key: `k${w}`,
      label: w,
      weightText: w,
    });
    expect(spinDraftWeightSummary([d("6000"), d("4000")])).toEqual({
      totalBp: 10000,
      complete: true,
    });
    expect(spinDraftWeightSummary([d("6000")]).complete).toBe(false);
  });

  it("counts unparsable weights as zero instead of NaN-poisoning", () => {
    const bad = { ...newSpinRewardDraft(), key: "x", label: "X", weightText: "huh" };
    const good = { ...newSpinRewardDraft(), key: "y", label: "Y", weightText: "10000" };
    expect(spinDraftWeightSummary([bad, good])).toEqual({
      totalBp: 10000,
      complete: true,
    });
  });
});

describe("variant editor (ONS-02)", () => {
  const wireVariant: OnsiteExperimentVariant = {
    key: "control",
    name: "Control",
    traffic_weight_basis_points: 5000,
    is_control: true,
    metrics: { impressions: 100 },
  };

  it("round-trips a wire variant through variantToDraft", () => {
    const d = variantToDraft(wireVariant);
    expect(d).toMatchObject({
      key: "control",
      name: "Control",
      weightText: "5000",
      isControl: true,
    });
    expect(d.base).toBe(wireVariant);
  });

  it("newVariantDraft is empty and not control", () => {
    expect(newVariantDraft()).toEqual({
      key: "",
      name: "",
      weightText: "",
      isControl: false,
      base: null,
    });
  });

  it("variantDraftWeightSummary sums and flags 100%", () => {
    const d = (weightText: string) => ({ ...newVariantDraft(), weightText });
    expect(variantDraftWeightSummary([d("5000"), d("5000")])).toEqual({
      totalBp: 10000,
      complete: true,
    });
    expect(variantDraftWeightSummary([d("6000"), d("3000")])).toEqual({
      totalBp: 9000,
      complete: false,
    });
    // Unparsable weights count as 0 (never NaN-poison the total).
    expect(variantDraftWeightSummary([d("abc"), d("5000")])).toEqual({
      totalBp: 5000,
      complete: false,
    });
    expect(variantDraftWeightSummary([])).toEqual({
      totalBp: 0,
      complete: false,
    });
  });

  it("buildVariantsInput round-trips base fields + sets is_control", () => {
    const res = buildVariantsInput([variantToDraft(wireVariant)]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items[0]).toMatchObject({
        key: "control",
        name: "Control",
        traffic_weight_basis_points: 5000,
        is_control: true,
        metrics: { impressions: 100 }, // round-tripped via base
      });
    }
  });

  it("buildVariantsInput drops is_control when unchecked", () => {
    const d = { ...variantToDraft(wireVariant), isControl: false };
    const res = buildVariantsInput([d]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items[0]!.is_control).toBeUndefined();
  });

  it("buildVariantsInput reports the first offending row", () => {
    const ok = { ...newVariantDraft(), key: "a", name: "A", weightText: "5000" };
    // missing key
    let res = buildVariantsInput([ok, { ...newVariantDraft(), name: "B", weightText: "5000" }]);
    expect(res).toMatchObject({ ok: false, index: 1 });
    // duplicate key
    res = buildVariantsInput([ok, { ...ok }]);
    expect(res).toMatchObject({ ok: false, index: 1 });
    // missing name
    res = buildVariantsInput([{ ...newVariantDraft(), key: "x", weightText: "1" }]);
    expect(res).toMatchObject({ ok: false, index: 0 });
    // non-integer / negative weight
    res = buildVariantsInput([{ ...ok, weightText: "-5" }]);
    expect(res).toMatchObject({ ok: false, index: 0 });
  });

  it("MAX_EXPERIMENT_VARIANTS is the Klaviyo-parity cap of 7", () => {
    expect(MAX_EXPERIMENT_VARIANTS).toBe(7);
  });
});
