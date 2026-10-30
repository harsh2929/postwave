/**
 * The discount edit rules mirror four server-side 400s (repo.go Update) and one
 * anchoring decision the server does NOT make. These tests exist because the
 * sheet now sends real PATCHes: a regression here is a request the operator is
 * told succeeded and a promotion that is still dead.
 */
import { describe, expect, it } from "vitest";

import {
  buildDiscountPatch,
  currentCap,
  currentExpiry,
  extendedExpiryISO,
  parseDiscountCheck,
  redeemabilityDisagreement,
  redeemabilitySummary,
  timesRedeemed,
} from "@/lib/discountEdit";

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 86_400_000;

describe("row readers", () => {
  it("treats a null times_redeemed as zero", () => {
    expect(timesRedeemed({ code: "A", times_redeemed: null })).toBe(0);
    expect(timesRedeemed({ code: "A", times_redeemed: 7 })).toBe(7);
  });

  it("distinguishes an uncapped code from a zero cap", () => {
    expect(currentCap({ code: "A", max_redemptions: null })).toBeNull();
    expect(currentCap({ code: "A" })).toBeNull();
    expect(currentCap({ code: "A", max_redemptions: 0 })).toBe(0);
  });

  it("returns null for a junk expiry rather than NaN", () => {
    expect(currentExpiry({ code: "A", expires_at: "not-a-date" })).toBeNull();
    expect(currentExpiry({ code: "A", expires_at: null })).toBeNull();
    expect(
      currentExpiry({ code: "A", expires_at: "2026-07-08T12:00:00.000Z" }),
    ).toBe(Date.UTC(2026, 6, 8, 12, 0, 0));
  });
});

describe("extendedExpiryISO anchors an already-lapsed code to now", () => {
  it("extends from the existing expiry while it is still ahead", () => {
    const iso = extendedExpiryISO(
      { code: "A", expires_at: new Date(NOW + 10 * DAY).toISOString() },
      7,
      NOW,
    );
    expect(iso).toBe(new Date(NOW + 17 * DAY).toISOString());
  });

  it("extends from NOW once the code has already lapsed", () => {
    // The bug this guards: +7 days from a date three weeks ago is still in the
    // past. The request would succeed and the code would stay dead.
    const iso = extendedExpiryISO(
      { code: "A", expires_at: new Date(NOW - 21 * DAY).toISOString() },
      7,
      NOW,
    );
    expect(iso).toBe(new Date(NOW + 7 * DAY).toISOString());
  });

  it("refuses when there is no expiry, or the span is not positive", () => {
    expect(extendedExpiryISO({ code: "A" }, 7, NOW)).toBeNull();
    expect(
      extendedExpiryISO({ code: "A", expires_at: "2026-08-01" }, 0, NOW),
    ).toBeNull();
  });
});

describe("buildDiscountPatch mirrors the server's refusals", () => {
  const capped = {
    code: "BF26",
    max_redemptions: 100,
    times_redeemed: 40,
    expires_at: new Date(NOW + 5 * DAY).toISOString(),
  };

  it("refuses an empty intent instead of sending 'nothing to update'", () => {
    const out = buildDiscountPatch(
      capped,
      { expiry: { kind: "keep" }, cap: { kind: "keep" } },
      NOW,
    );
    expect(out).toEqual({ ok: false, reason: "Nothing to change yet." });
  });

  it("refuses a cap below times_redeemed and names the number", () => {
    const out = buildDiscountPatch(
      capped,
      { expiry: { kind: "keep" }, cap: { kind: "raise", value: 12 } },
      NOW,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("40");
  });

  it("refuses a cap that is not actually a raise", () => {
    const out = buildDiscountPatch(
      capped,
      { expiry: { kind: "keep" }, cap: { kind: "raise", value: 100 } },
      NOW,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("already 100");
  });

  it("refuses to clear a limit that does not exist", () => {
    const out = buildDiscountPatch(
      { code: "A", max_redemptions: null },
      { expiry: { kind: "keep" }, cap: { kind: "clear" } },
      NOW,
    );
    expect(out).toEqual({
      ok: false,
      reason: "This code already has no redemption limit.",
    });
  });

  it("refuses to extend an expiry that does not exist", () => {
    const out = buildDiscountPatch(
      { code: "A" },
      { expiry: { kind: "extend", days: 7 }, cap: { kind: "keep" } },
      NOW,
    );
    expect(out).toEqual({
      ok: false,
      reason: "This code has no expiry to extend.",
    });
  });

  it("omits keys rather than sending nulls, and summarises both edits", () => {
    const out = buildDiscountPatch(
      capped,
      { expiry: { kind: "extend", days: 30 }, cap: { kind: "raise", value: 250 } },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // `encoding/json` cannot tell absent from null on a *int, which is why the
    // server uses clear_* flags — a null here would be read as "clear it".
    expect(Object.keys(out.patch).sort()).toEqual([
      "expires_at",
      "max_redemptions",
    ]);
    expect(out.patch.max_redemptions).toBe(250);
    expect(out.patch.expires_at).toBe(new Date(NOW + 35 * DAY).toISOString());
    expect(out.summary).toBe(
      "BF26: raised the limit to 250 and extended the expiry by 30 days.",
    );
  });

  it("uses the clear_* flags, never a null value", () => {
    const out = buildDiscountPatch(
      capped,
      { expiry: { kind: "clear" }, cap: { kind: "clear" } },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.patch).toEqual({
      clear_max_redemptions: true,
      clear_expires_at: true,
    });
  });
});

describe("the live redeemability probe", () => {
  it("drops fields of the wrong type instead of trusting the wire", () => {
    expect(parseDiscountCheck(null)).toEqual({});
    expect(parseDiscountCheck("nope")).toEqual({});
    expect(
      parseDiscountCheck({
        code: "A",
        valid: true,
        currently_redeemable: "yes",
        reason: 4,
      }),
    ).toEqual({ code: "A", valid: true });
  });

  it("names the reason the server gave", () => {
    expect(redeemabilitySummary({ currently_redeemable: true }).tone).toBe(
      "success",
    );
    expect(
      redeemabilitySummary({
        currently_redeemable: false,
        reason: "max_redemptions_reached",
      }).headline,
    ).toBe("Not redeemable — limit reached");
    expect(
      redeemabilitySummary({ currently_redeemable: false, reason: "expired" })
        .tone,
    ).toBe("danger");
    // An unrecognised reason must still say the server refused it, not invent
    // a cause.
    expect(
      redeemabilitySummary({ currently_redeemable: false, reason: "moon" })
        .headline,
    ).toBe("Not redeemable");
  });

  it("reports a disagreement in BOTH directions and stays silent otherwise", () => {
    expect(
      redeemabilityDisagreement("active", { currently_redeemable: false }),
    ).toContain("the list is out of date");
    expect(
      redeemabilityDisagreement("expired", { currently_redeemable: true }),
    ).toContain("the server accepts it");
    expect(
      redeemabilityDisagreement("active", { currently_redeemable: true }),
    ).toBeNull();
    expect(redeemabilityDisagreement("expired", {})).toBeNull();
    expect(redeemabilityDisagreement("expired", undefined)).toBeNull();
  });
});
