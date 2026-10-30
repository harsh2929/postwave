import { describe, expect, it } from "vitest";

import {
  isOverPlan,
  overageEnableConsequence,
  overageHeadroom,
  overageState,
  smsCreditSummary,
  smsCreditWarnings,
  smsCreditsAreLow,
  spendSummary,
  spendTone,
  validateOverageCap,
  type SendingAddonLike,
  type SmsCreditBalanceLike,
} from "./spendControls";

function addon(over: Partial<SendingAddonLike> = {}): SendingAddonLike {
  return {
    monthlyCap: 100_000,
    used: 40_000,
    daysRemaining: 12,
    overageEnabled: false,
    overageUnits: 0,
    overageChargeable: false,
    overageBillingConfigured: false,
    ...over,
  };
}

describe("overageState distinguishes all four situations", () => {
  it("off when the preference is off", () => {
    expect(overageState(addon())).toBe("off");
  });

  it("on_not_billed when the preference is on but billing is not wired", () => {
    // The self-host case. Saying "being billed" here would invent a charge that
    // cannot happen.
    const a = addon({
      overageEnabled: true,
      overageChargeable: false,
      overageBillingConfigured: false,
    });
    expect(overageState(a)).toBe("on_not_billed");
  });

  it("on_billing only when the server says chargeable", () => {
    const a = addon({
      overageEnabled: true,
      overageChargeable: true,
      overageBillingConfigured: true,
    });
    expect(overageState(a)).toBe("on_billing");
  });

  it("capped_out outranks on_billing — it changes what happens next", () => {
    const a = addon({
      overageEnabled: true,
      overageChargeable: true,
      overageBillingConfigured: true,
      overageUnits: 5_000,
      overageCap: 5_000,
    });
    expect(overageState(a)).toBe("capped_out");
  });

  it("treats a cap of zero as a real ceiling, not as absent", () => {
    const a = addon({ overageEnabled: true, overageCap: 0, overageUnits: 0 });
    expect(overageState(a)).toBe("capped_out");
  });

  it("does not invent a ceiling when the cap is absent", () => {
    const a = addon({
      overageEnabled: true,
      overageChargeable: true,
      overageUnits: 999_999,
    });
    expect(overageState(a)).toBe("on_billing");
  });
});

describe("overageHeadroom", () => {
  it("is null when there is no ceiling", () => {
    expect(overageHeadroom(addon({ overageUnits: 10 }))).toBeNull();
  });

  it("counts down to the ceiling", () => {
    expect(overageHeadroom(addon({ overageCap: 500, overageUnits: 200 }))).toBe(
      300,
    );
  });

  it("never goes negative — a negative remaining count reads as a bug", () => {
    expect(overageHeadroom(addon({ overageCap: 100, overageUnits: 400 }))).toBe(
      0,
    );
  });

  it("is zero, not null, for a ceiling of zero", () => {
    expect(overageHeadroom(addon({ overageCap: 0 }))).toBe(0);
  });
});

describe("spendSummary always names state AND consequence", () => {
  it("under the cap with overage off says sends will stop", () => {
    expect(spendSummary(addon())).toContain("stop at the plan cap");
  });

  it("under the cap with overage on says sends will continue", () => {
    expect(spendSummary(addon({ overageEnabled: true }))).toContain(
      "continue past the cap",
    );
  });

  it("over the cap and billing says so plainly", () => {
    const s = spendSummary(
      addon({
        overageEnabled: true,
        overageChargeable: true,
        overageBillingConfigured: true,
        overageUnits: 2_500,
      }),
    );
    expect(s).toContain("being billed as overage");
  });

  it("over the cap with billing unwired never claims a charge", () => {
    const s = spendSummary(
      addon({ overageEnabled: true, overageUnits: 2_500 }),
    );
    expect(s).toContain("nothing is being charged");
    expect(s).not.toContain("being billed as overage");
  });

  it("capped out says sends are refused, not that overage is on", () => {
    const s = spendSummary(
      addon({
        overageEnabled: true,
        overageChargeable: true,
        overageUnits: 1_000,
        overageCap: 1_000,
      }),
    );
    expect(s).toContain("refused");
  });

  it("never shows a negative remaining count when usage exceeds the cap", () => {
    const s = spendSummary(addon({ used: 140_000, monthlyCap: 100_000 }));
    expect(s).not.toMatch(/-\d/u);
  });
});

describe("spendTone", () => {
  it("is success while comfortably inside the plan", () => {
    expect(spendTone(addon())).toBe("success");
  });

  it("warns once past the plan cap, billed or not", () => {
    expect(spendTone(addon({ overageUnits: 1 }))).toBe("warning");
    expect(
      spendTone(
        addon({ overageEnabled: true, overageChargeable: true, overageUnits: 1 }),
      ),
    ).toBe("warning");
  });

  it("warns when capped out", () => {
    expect(
      spendTone(
        addon({ overageEnabled: true, overageUnits: 10, overageCap: 10 }),
      ),
    ).toBe("warning");
  });
});

describe("validateOverageCap", () => {
  it("reads an empty field as no ceiling, not as zero", () => {
    // These are opposite instructions: blank means unlimited, 0 means none.
    expect(validateOverageCap("")).toEqual({ ok: true, cap: undefined });
    expect(validateOverageCap("   ")).toEqual({ ok: true, cap: undefined });
  });

  it("accepts zero as an explicit ceiling", () => {
    expect(validateOverageCap("0")).toEqual({ ok: true, cap: 0 });
  });

  it("accepts a plain whole number", () => {
    expect(validateOverageCap("50000")).toEqual({ ok: true, cap: 50_000 });
  });

  it("rejects non-numeric input with an actionable sentence", () => {
    const result = validateOverageCap("50,000");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/whole number/u);
  });

  it("rejects a negative value", () => {
    expect(validateOverageCap("-1").ok).toBe(false);
  });

  it("rejects a value past the server's int32 ceiling before the round trip", () => {
    const result = validateOverageCap("2147483648");
    expect(result.ok).toBe(false);
  });

  it("accepts exactly the server's maximum", () => {
    expect(validateOverageCap("2147483647")).toEqual({
      ok: true,
      cap: 2_147_483_647,
    });
  });
});

describe("overageEnableConsequence", () => {
  it("promises billing only when billing is configured", () => {
    expect(
      overageEnableConsequence(addon({ overageBillingConfigured: true }), 100),
    ).toContain("billed as overage");
    expect(overageEnableConsequence(addon(), 100)).toContain(
      "nothing will be charged yet",
    );
  });

  it("says plainly when there is no upper bound", () => {
    expect(overageEnableConsequence(addon(), undefined)).toContain(
      "no upper bound",
    );
  });

  it("distinguishes a zero ceiling from an absent one", () => {
    expect(overageEnableConsequence(addon(), 0)).toContain(
      "no sends past the plan cap will be allowed",
    );
  });
});

describe("SMS credits", () => {
  function balance(
    over: Partial<SmsCreditBalanceLike> = {},
  ): SmsCreditBalanceLike {
    return {
      plan: "growth",
      included_credits: 1_000,
      purchased_credits: 500,
      used_credits: 300,
      available_credits: 1_200,
      period_start: "2026-08-01T00:00:00Z",
      period_end: "2026-09-01T00:00:00Z",
      ledger_mode: "metered",
      ...over,
    };
  }

  it("leads with the number that decides the next send", () => {
    expect(smsCreditSummary(balance())).toMatch(/^1,200 SMS credits available/u);
  });

  it("stays silent about a normal ledger mode", () => {
    expect(smsCreditSummary(balance())).not.toContain("Ledger mode");
  });

  it("surfaces an abnormal ledger mode — the claim is different", () => {
    expect(smsCreditSummary(balance({ ledger_mode: "estimated" }))).toContain(
      "Ledger mode: estimated",
    );
  });

  it("does not render NaN when the server omits the number", () => {
    const s = smsCreditSummary(
      balance({ available_credits: Number.NaN }),
    );
    expect(s).not.toContain("NaN");
    expect(s).toMatch(/^0 SMS credits/u);
  });

  it("flags a low balance at the threshold, not just below it", () => {
    expect(smsCreditsAreLow(balance({ available_credits: 100 }))).toBe(true);
    expect(smsCreditsAreLow(balance({ available_credits: 101 }))).toBe(false);
  });

  it("returns null rather than an empty string when there are no warnings", () => {
    expect(smsCreditWarnings(balance())).toBeNull();
    expect(smsCreditWarnings(balance({ warnings: [] }))).toBeNull();
    expect(smsCreditWarnings(balance({ warnings: ["  "] }))).toBeNull();
  });

  it("passes server warnings through verbatim", () => {
    expect(
      smsCreditWarnings(balance({ warnings: ["Sender not registered."] })),
    ).toBe("Sender not registered.");
  });
});

describe("isOverPlan", () => {
  it("is false at exactly the cap and true one past it", () => {
    expect(isOverPlan(addon({ overageUnits: 0 }))).toBe(false);
    expect(isOverPlan(addon({ overageUnits: 1 }))).toBe(true);
  });
});
