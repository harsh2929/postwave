/**
 * mailchimp-parity-gating — the dashboard parity card hides only when
 * the feature is genuinely absent (404/501). The parity reads accept
 * session auth now, so 401/403 must flow through the visible error
 * path instead of silently hiding the card (the old behaviour masked
 * real authorization failures as "feature not shipped").
 */

import { describe, expect, it } from "vitest";

import { isFeatureAbsent } from "../../components/dashboard/parityFeatureGate";

describe("isFeatureAbsent", () => {
  it("hides on 404 (route absent) and 501 (not implemented)", () => {
    expect(isFeatureAbsent(404)).toBe(true);
    expect(isFeatureAbsent(501)).toBe(true);
  });

  it("does NOT hide on 401/403 — session auth is accepted now, so these are honest errors", () => {
    expect(isFeatureAbsent(401)).toBe(false);
    expect(isFeatureAbsent(403)).toBe(false);
  });

  it("does not hide on transport-level failures (no status) or 5xx", () => {
    expect(isFeatureAbsent(undefined)).toBe(false);
    expect(isFeatureAbsent(500)).toBe(false);
  });
});
