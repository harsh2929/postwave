import { describe, expect, it } from "vitest";

import {
  discountDeleteActionLabel,
  discountDeleteConfirmCopy,
  discountDeletedMessage,
} from "./discountDeleteCopy";

/**
 * The kill switch's words, tested where they can be read without a renderer.
 *
 * The assertions that matter are about what the copy MUST NOT let a reader
 * assume: that the delete is local to Moosewave, that it can be undone, or that
 * the redemption history goes with it. Each of those is a support conversation
 * the operator would have after the fact, and the sheet is the last place to
 * prevent it.
 */
describe("discountDeleteConfirmCopy", () => {
  it("gates the confirm on typing the code itself", () => {
    const copy = discountDeleteConfirmCopy({ code: "BLACKFRIDAY", used: 42 });
    expect(copy.confirmPhrase).toBe("BLACKFRIDAY");
    expect(copy.destructive).toBe(true);
    expect(copy.title).toBe("Delete BLACKFRIDAY?");
  });

  it("says the coupon leaves Stripe too, and that nothing here restores it", () => {
    // `Repo.Delete` calls bridge.DeleteCoupon before touching the local row
    // (apps/api/internal/discounts/repo.go:381-391). An operator who reads
    // this as a Moosewave-only delete has been misled about provider state.
    const copy = discountDeleteConfirmCopy({ code: "SPRING", used: 0 });
    expect(copy.message).toMatch(/Stripe/);
    expect(copy.message).toMatch(/cannot be restored|neither can be restored/);
  });

  it("names the redemptions rather than repeating 'cannot be undone'", () => {
    expect(discountDeleteConfirmCopy({ code: "A", used: 0 }).consequence).toBe(
      "This code has never been redeemed.",
    );
    expect(
      discountDeleteConfirmCopy({ code: "A", used: 1 }).consequence,
    ).toContain("redeemed once");
    expect(
      discountDeleteConfirmCopy({ code: "A", used: 9 }).consequence,
    ).toContain("redeemed 9 times");
  });

  it("promises the history survives, because 'delete' does not imply that", () => {
    for (const used of [1, 9]) {
      expect(
        discountDeleteConfirmCopy({ code: "A", used }).consequence,
      ).toMatch(/stays? in your history/);
    }
  });

  it("never renders a negative or fractional redemption count", () => {
    // `times_redeemed` arrives off the wire and the row can come from an
    // unshape-checked vault snapshot, so this is reachable without a server
    // change (see the catalogue's own Array.isArray guard).
    expect(
      discountDeleteConfirmCopy({ code: "A", used: -3 }).consequence,
    ).toBe("This code has never been redeemed.");
    expect(
      discountDeleteConfirmCopy({ code: "A", used: 2.7 }).consequence,
    ).toContain("redeemed 2 times");
    expect(
      discountDeleteConfirmCopy({
        code: "A",
        used: Number.NaN,
      }).consequence,
    ).toBe("This code has never been redeemed.");
  });

  it("offers a cancel that names keeping the code, not a bare Cancel", () => {
    const copy = discountDeleteConfirmCopy({ code: "A", used: 0 });
    expect(copy.confirmLabel).toBe("Delete code");
    expect(copy.cancelLabel).toBe("Keep it");
  });
});

describe("discountDeletedMessage", () => {
  it("states the outcome, not the operation", () => {
    expect(discountDeletedMessage("BLACKFRIDAY")).toBe(
      "BLACKFRIDAY deleted. It can no longer be redeemed.",
    );
  });
});

describe("discountDeleteActionLabel", () => {
  it("spells out the consequence for a screen reader meeting it beside Extend", () => {
    expect(discountDeleteActionLabel("SPRING")).toBe(
      "Delete SPRING so it can no longer be redeemed",
    );
  });
});
