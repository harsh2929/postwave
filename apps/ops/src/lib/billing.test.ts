// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { parseBilling, usageColor } from "./billing";

const row = {
  tenant_id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b1",
  slug: "acme",
  name: "Acme",
  tier: "studio",
  dunning: false,
  monthly_sends_used: 1000,
  monthly_sends_cap: 2000,
  usage_fraction: 0.5,
};

describe("parseBilling", () => {
  it("fails loud on non-200", () => {
    const r = parseBilling(500, { error: "x" });
    expect(r.ok).toBe(false);
  });

  it("fails loud on an unexpected shape", () => {
    const r = parseBilling(200, { rows: [] });
    expect(r.ok).toBe(false);
  });

  it("accepts the tenants envelope", () => {
    const r = parseBilling(200, { tenants: [row], truncated: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toHaveLength(1);
  });

  it("rejects inconsistent fractions and duplicate tenants", () => {
    expect(parseBilling(200, { tenants: [{ ...row, usage_fraction: 0.4 }], truncated: false }).ok).toBe(false);
    expect(parseBilling(200, { tenants: [row, row], truncated: false }).ok).toBe(false);
  });
});

describe("usageColor", () => {
  it("is red in dunning regardless of usage", () => {
    expect(usageColor(0.1, true)).toBe("var(--red)");
  });
  it("is red over quota", () => {
    expect(usageColor(1.2, false)).toBe("var(--red)");
  });
  it("is amber approaching the cap", () => {
    expect(usageColor(0.85, false)).toBe("var(--amber)");
  });
  it("is green well under the cap", () => {
    expect(usageColor(0.25, false)).toBe("var(--green)");
  });
  it("is amber exactly at the 80% boundary", () => {
    expect(usageColor(0.8, false)).toBe("var(--amber)");
  });
  it("is red exactly at 100% of quota", () => {
    expect(usageColor(1, false)).toBe("var(--red)");
  });
  it("is green just below the 80% boundary", () => {
    expect(usageColor(0.79, false)).toBe("var(--green)");
  });
  it("dunning overrides a low fraction", () => {
    expect(usageColor(0.2, true)).toBe("var(--red)");
  });
});
