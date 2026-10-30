import { describe, expect, it } from "vitest";

import {
  appliesLabel,
  redeemedCount,
  redemptionActor,
  SHARE_SLOT_BASE,
  shareSlotWidth,
  statusOf,
} from "./discountStatus";

const NOW = Date.parse("2026-07-26T12:00:00Z");

describe("redeemedCount", () => {
  it("reads a real count", () => {
    expect(redeemedCount({ times_redeemed: 7 })).toBe(7);
  });

  it("treats a null or missing count as zero rather than letting it compare", () => {
    expect(redeemedCount({ times_redeemed: null })).toBe(0);
    expect(redeemedCount({})).toBe(0);
    expect(redeemedCount({ times_redeemed: Number.NaN })).toBe(0);
  });
});

describe("statusOf", () => {
  it("is active with no expiry and no cap", () => {
    expect(statusOf({ times_redeemed: 3 }, NOW)).toEqual({
      label: "active",
      tone: "success",
    });
  });

  it("is expired past expires_at", () => {
    expect(
      statusOf({ expires_at: "2026-07-25T00:00:00Z", times_redeemed: 0 }, NOW),
    ).toEqual({ label: "expired", tone: "danger" });
  });

  it("is active before expires_at", () => {
    expect(
      statusOf({ expires_at: "2026-07-27T00:00:00Z", times_redeemed: 0 }, NOW)
        .label,
    ).toBe("active");
  });

  it("ignores an unparseable expires_at instead of calling the code expired", () => {
    expect(statusOf({ expires_at: "whenever", times_redeemed: 0 }, NOW).label).toBe(
      "active",
    );
  });

  it("is exhausted at and above the cap", () => {
    expect(statusOf({ max_redemptions: 5, times_redeemed: 5 }, NOW).label).toBe(
      "exhausted",
    );
    expect(statusOf({ max_redemptions: 5, times_redeemed: 6 }, NOW).label).toBe(
      "exhausted",
    );
    expect(statusOf({ max_redemptions: 5, times_redeemed: 4 }, NOW).label).toBe(
      "active",
    );
  });

  it("prefers expired over exhausted when a code is both", () => {
    // The operator can act on the date; raising the redemption limit on an
    // expired code would change nothing.
    expect(
      statusOf(
        {
          expires_at: "2026-07-01T00:00:00Z",
          max_redemptions: 2,
          times_redeemed: 9,
        },
        NOW,
      ).label,
    ).toBe("expired");
  });

  it("does not mislabel a zero-cap code whose count arrived null", () => {
    // `null >= 0` is true in JS, so an unguarded compare would say exhausted.
    expect(
      statusOf({ max_redemptions: 0, times_redeemed: null }, NOW).label,
    ).toBe("exhausted");
    expect(statusOf({ max_redemptions: 1, times_redeemed: null }, NOW).label).toBe(
      "active",
    );
  });
});

describe("appliesLabel", () => {
  it("maps the known modes", () => {
    expect(appliesLabel("first_payment")).toBe("First payment");
    expect(appliesLabel("recurring")).toBe("Recurring");
    expect(appliesLabel("both")).toBe("First + recurring");
  });

  it("humanises an unknown mode rather than dropping it", () => {
    expect(appliesLabel("trial_only")).toBe("trial only");
  });

  it("is empty for a missing mode", () => {
    expect(appliesLabel(undefined)).toBe("");
    expect(appliesLabel("")).toBe("");
  });
});

describe("redemptionActor", () => {
  it("prefers the email, then the id, then says anonymous", () => {
    expect(redemptionActor({ subscriber_email: "a@b.co", subscriber_id: "x" })).toBe(
      "a@b.co",
    );
    expect(redemptionActor({ subscriber_id: "x" })).toBe("x");
    expect(redemptionActor({})).toBe("Anonymous checkout");
  });

  /**
   * THE ARCHIVE TIMELINE RETURNS NEITHER FIELD.
   *
   * `GET /api/v1/discounts/{record_id}/redemptions` answers
   * `{redeemed_at, subscriber_linked}` and nothing else — subscriber IDs and
   * emails never cross the handler boundary. So every row on the drawer arrives
   * with no email and no ID, and the old catch-all would have labelled all of
   * them "Anonymous checkout" — including the ones the server explicitly says
   * WERE tied to a subscriber. That is not a missing detail on a support
   * screen, it is a false one: it turns "we know who redeemed this, we just
   * won't name them here" into "nobody was signed in".
   */
  it("does not call a LINKED redemption anonymous", () => {
    expect(redemptionActor({ subscriber_linked: true })).toBe(
      "Linked subscriber (not named)",
    );
    expect(redemptionActor({ subscriber_linked: true })).not.toBe(
      "Anonymous checkout",
    );
  });

  it("still says anonymous when the server says nothing was linked", () => {
    expect(redemptionActor({ subscriber_linked: false })).toBe(
      "Anonymous checkout",
    );
  });

  it("lets a real identity win over the linkage bit", () => {
    // Older snapshot rows carry both shapes at once. The identity is strictly
    // more informative than the bit, so it must not be shadowed by it.
    expect(
      redemptionActor({ subscriber_email: "a@b.co", subscriber_linked: true }),
    ).toBe("a@b.co");
    expect(
      redemptionActor({ subscriber_id: "x", subscriber_linked: true }),
    ).toBe("x");
  });
});

describe("shareSlotWidth", () => {
  it("is the base width at the default text size", () => {
    expect(shareSlotWidth(1)).toBe(SHARE_SLOT_BASE);
  });

  it("never shrinks below the base for a sub-1 scale", () => {
    expect(shareSlotWidth(0.85)).toBe(SHARE_SLOT_BASE);
  });

  it("grows with the OS text size", () => {
    expect(shareSlotWidth(1.2)).toBeGreaterThan(SHARE_SLOT_BASE);
  });

  it("stops at the control role's own ceiling, not at the OS 3x", () => {
    // The affordance shares the card's top-right corner with the code; letting
    // it track a 3x accessibility size would push the code off its own row.
    expect(shareSlotWidth(3)).toBe(shareSlotWidth(1.4));
    expect(shareSlotWidth(3)).toBeLessThan(SHARE_SLOT_BASE * 2);
  });

  it("falls back to the default size for a first-frame non-number", () => {
    expect(shareSlotWidth(undefined)).toBe(SHARE_SLOT_BASE);
    expect(shareSlotWidth(Number.NaN)).toBe(SHARE_SLOT_BASE);
    expect(shareSlotWidth("1.5")).toBe(SHARE_SLOT_BASE);
  });
});
