import { describe, expect, it } from "vitest";

import { formatDiscountOff, ZERO_DECIMAL_CURRENCIES } from "./discountFormat";

describe("formatDiscountOff", () => {
  it("prefers a percentage when the discount carries one", () => {
    expect(formatDiscountOff({ percent_off: 20 })).toBe("20% off");
  });

  it("renders a currency SYMBOL, not a trailing code", () => {
    const out = formatDiscountOff({ amount_off_cents: 500, currency: "usd" });
    // The old line produced "5.00 USD off".
    expect(out).toContain("$5.00");
    expect(out.endsWith(" off")).toBe(true);
    expect(out).not.toContain("USD");
  });

  it("groups thousands", () => {
    const out = formatDiscountOff({
      amount_off_cents: 1_500_000,
      currency: "USD",
    });
    // The old line produced "15000.00 USD off".
    expect(out).toContain("15,000.00");
  });

  it("does not divide a zero-decimal currency by 100", () => {
    // A ¥500 discount. `money(cents / 100, …, {cents:true})` — the naive fix —
    // renders "¥5.00", wrong by two orders of magnitude AND wrongly punctuated.
    const out = formatDiscountOff({ amount_off_cents: 500, currency: "JPY" });
    expect(out).toContain("500");
    expect(out).not.toContain("5.00");
    expect(out).not.toContain(".");
  });

  it("treats every currency in the zero-decimal set the same way", () => {
    for (const currency of ZERO_DECIMAL_CURRENCIES) {
      const out = formatDiscountOff({ amount_off_cents: 1000, currency });
      expect(out, `${currency} must not gain a minor unit`).not.toContain(".00");
    }
  });

  it("defaults to USD when the server omitted the currency", () => {
    expect(formatDiscountOff({ amount_off_cents: 250 })).toContain("$2.50");
  });

  it("returns an em-dash rather than 'undefined off' when neither is set", () => {
    expect(formatDiscountOff({})).toBe("—");
    expect(formatDiscountOff({ percent_off: null, amount_off_cents: null })).toBe(
      "—",
    );
  });
});
