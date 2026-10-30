import { describe, expect, it } from "vitest";

import { parseDeliverability, rateColor } from "./deliverability";

const row = {
  tenant_id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b1",
  slug: "acme",
  name: "Acme",
  sent_7d: 1000,
  complained_7d: 4,
  bounced_7d: 2,
  unsubscribed_7d: 3,
  complaint_rate: 0.004,
  bounce_rate: 0.002,
};

describe("parseDeliverability", () => {
  it("returns rows from a well-formed body", () => {
    const r = parseDeliverability(200, { tenants: [row], truncated: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].complaint_rate).toBe(0.004);
  });
  it("a non-200 is a loud failure", () => {
    expect(parseDeliverability(500, {}).ok).toBe(false);
  });
  it("rejects inconsistent derived rates and duplicate tenants", () => {
    expect(parseDeliverability(200, { tenants: [{ ...row, complaint_rate: 0.003 }], truncated: false }).ok).toBe(false);
    expect(parseDeliverability(200, { tenants: [row, row], truncated: false }).ok).toBe(false);
  });
});

describe("rateColor (the enforced lines)", () => {
  it("green under 0.10%", () => expect(rateColor(0.0005)).toBe("var(--green)"));
  it("amber between 0.10% and 0.30%", () => expect(rateColor(0.002)).toBe("var(--amber)"));
  it("red at or above 0.30% (the ceiling providers reject at)", () => expect(rateColor(0.003)).toBe("var(--red)"));
  it("amber exactly at the 0.10% line", () => expect(rateColor(0.001)).toBe("var(--amber)"));
  it("green just below the 0.10% line", () => expect(rateColor(0.0009)).toBe("var(--green)"));
});
