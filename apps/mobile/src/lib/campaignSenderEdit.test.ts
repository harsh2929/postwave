/**
 * The two contracts the sender edit lives or dies by:
 *
 *   1. FULL-MAP PRESERVATION. The gateway treats a non-nil delivery_settings
 *      as a replace, so the PATCH body must carry every key the campaign
 *      already holds — dropping the spread erases rate limits and A/B
 *      bookkeeping (the subscribers custom_fields wipe, again).
 *   2. THE ONLINE/OFFLINE FORK. A sender change must produce an "online"
 *      plan (never queued for replay); a plain field diff must keep riding
 *      the outbox; no change disables the save.
 */
import { describe, expect, it } from "vitest";

import {
  campaignFromEmailValue,
  deliverySettingsWithFromEmail,
  fromEmailProblem,
  identityPatchWithSender,
  identitySavePlan,
} from "./campaignSenderEdit";

const campaign = {
  delivery_settings: {
    from_email: "old@acme.com",
    rate_limit: 200,
    ab_test: { is_parent: true },
  },
};

describe("campaignFromEmailValue", () => {
  it("reads delivery_settings.from_email first", () => {
    expect(campaignFromEmailValue(campaign)).toBe("old@acme.com");
  });
  it("falls back to the top-level field, then blank", () => {
    expect(campaignFromEmailValue({ from_email: "top@acme.com" })).toBe(
      "top@acme.com",
    );
    expect(campaignFromEmailValue({})).toBe("");
    expect(campaignFromEmailValue(null)).toBe("");
  });
});

describe("fromEmailProblem", () => {
  it("accepts blank (workspace default) and a plausible address", () => {
    expect(fromEmailProblem("")).toBeNull();
    expect(fromEmailProblem("  news@acme.com ")).toBeNull();
  });
  it("rejects a non-address", () => {
    expect(fromEmailProblem("not-an-email")).not.toBeNull();
  });
});

describe("the delivery_settings replace preserves every existing key", () => {
  it("keeps rate_limit and ab_test while changing from_email", () => {
    const next = deliverySettingsWithFromEmail(
      campaign.delivery_settings,
      "new@acme.com",
    );
    expect(next).toEqual({
      from_email: "new@acme.com",
      rate_limit: 200,
      ab_test: { is_parent: true },
    });
  });

  it("identityPatchWithSender carries the field diff AND the full map", () => {
    const body = identityPatchWithSender(
      { subject: "Fixed" },
      campaign,
      "new@acme.com",
    );
    expect(body.subject).toBe("Fixed");
    expect(body.delivery_settings).toEqual({
      from_email: "new@acme.com",
      rate_limit: 200,
      ab_test: { is_parent: true },
    });
  });
});

describe("identitySavePlan — the online/offline fork", () => {
  it("a sender change is ONLINE, with the preserved map", () => {
    const plan = identitySavePlan(
      { reply_to: "hello@acme.com" },
      campaign,
      "old@acme.com",
      "new@acme.com",
    );
    expect(plan.kind).toBe("online");
    if (plan.kind !== "online") throw new Error("unreachable");
    expect(plan.body.reply_to).toBe("hello@acme.com");
    expect(
      (plan.body.delivery_settings as Record<string, unknown>).rate_limit,
    ).toBe(200);
  });

  it("a field-only diff keeps riding the outbox", () => {
    const plan = identitySavePlan(
      { subject: "New" },
      campaign,
      "old@acme.com",
      "old@acme.com",
    );
    expect(plan).toEqual({ kind: "offline", fields: { subject: "New" } });
  });

  it("no change at all disables the save", () => {
    expect(
      identitySavePlan({}, campaign, "old@acme.com", " old@acme.com "),
    ).toEqual({ kind: "none" });
  });

  it("clearing the sender back to workspace default is still an online act", () => {
    const plan = identitySavePlan({}, campaign, "old@acme.com", "");
    expect(plan.kind).toBe("online");
    if (plan.kind !== "online") throw new Error("unreachable");
    expect(
      (plan.body.delivery_settings as Record<string, unknown>).from_email,
    ).toBe("");
  });
});
