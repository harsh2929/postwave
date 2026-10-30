import { describe, expect, it } from "vitest";

import { TIERS } from "@/lib/pricing";

describe("public pricing truth", () => {
  it("publishes only the approved finite monthly catalog", () => {
    expect(TIERS.map(({ tier, name, price, cadence }) => ({
      tier,
      name,
      price,
      cadence,
    }))).toEqual([
      { tier: "sandbox", name: "Sandbox", price: "$0", cadence: "free" },
      { tier: "launch", name: "Launch", price: "$39", cadence: "monthly" },
      { tier: "growth", name: "Growth", price: "$99", cadence: "monthly" },
      { tier: "scale", name: "Scale", price: "$349", cadence: "monthly" },
    ]);

    const publicCopy = JSON.stringify(TIERS).toLowerCase();
    expect(publicCopy).not.toContain("lifetime");
    expect(publicCopy).not.toContain("unlimited");
    expect(publicCopy).toContain("25,000 accepted recipients / month");
    expect(publicCopy).toContain("100,000 accepted recipients / month");
    expect(publicCopy).toContain("500,000 accepted recipients / month");
  });

  it("keeps annual prices as distinct planning inputs", () => {
    expect(
      TIERS.filter((tier) => tier.tier !== "sandbox").map((tier) => ({
        tier: tier.tier,
        annualPrice: tier.annualPrice,
      })),
    ).toEqual([
      { tier: "launch", annualPrice: "$390" },
      { tier: "growth", annualPrice: "$990" },
      { tier: "scale", annualPrice: "$3,890" },
    ]);
  });
});
