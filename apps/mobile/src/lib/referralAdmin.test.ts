import { describe, expect, it } from "vitest";

import {
  REFERRAL_ADMIN_MINIMUM_ROLE,
  buildReferralProgramBody,
  milestoneDraftsFrom,
  payoutActionsFor,
  payoutAdvanceCopy,
  payoutAdvanceRequest,
  referralExpiryIso,
  referralWidgetSnippet,
  validateMilestoneDrafts,
} from "./referralAdmin";
import { parseReferralProgram } from "./referralsWire";

describe("payoutActionsFor", () => {
  it("mirrors the server transition table exactly", () => {
    // payouts.go:357-372: pending→approved|paid, approved→paid, paid terminal.
    expect(payoutActionsFor("pending")).toEqual(["approved", "paid"]);
    expect(payoutActionsFor("approved")).toEqual(["paid"]);
    expect(payoutActionsFor("paid")).toEqual([]);
  });

  it("offers nothing on an unknown status — the server would 409", () => {
    expect(payoutActionsFor("reversed")).toEqual([]);
    expect(payoutActionsFor(undefined)).toEqual([]);
    expect(payoutActionsFor("")).toEqual([]);
  });

  it("normalises case and whitespace", () => {
    expect(payoutActionsFor(" Pending ")).toEqual(["approved", "paid"]);
  });
});

describe("payoutAdvanceRequest", () => {
  it("PATCHes the mounted route with exactly {status}", () => {
    expect(payoutAdvanceRequest("po-1", "approved")).toEqual({
      method: "PATCH",
      path: "/api/v1/referrals/payouts/po-1",
      body: { status: "approved" },
    });
  });

  it("id-encodes the path", () => {
    expect(payoutAdvanceRequest("a/b", "paid").path).toBe(
      "/api/v1/referrals/payouts/a%2Fb",
    );
  });
});

describe("payoutAdvanceCopy", () => {
  it("says the advance is irreversible in both directions", () => {
    expect(payoutAdvanceCopy("approved", "T-shirt").confirmMessage).toContain(
      "cannot be undone",
    );
    expect(payoutAdvanceCopy("paid", "T-shirt").confirmMessage).toContain(
      "cannot be reversed",
    );
  });

  it("names the reward, with a fallback", () => {
    expect(payoutAdvanceCopy("paid", "T-shirt").confirmTitle).toBe(
      "Mark T-shirt as paid?",
    );
    expect(payoutAdvanceCopy("approved", "  ").confirmTitle).toBe(
      "Approve this reward?",
    );
  });
});

describe("referralWidgetSnippet", () => {
  it("builds the script tag for widget.go's mounted route", () => {
    expect(referralWidgetSnippet("https://api.example.com/", "AB-12")).toBe(
      '<script src="https://api.example.com/api/public/r/AB-12/widget.js" async></script>',
    );
  });

  it("URL-encodes the code and refuses empty halves", () => {
    expect(referralWidgetSnippet("https://x.io", "a b")).toContain("r/a%20b/");
    expect(referralWidgetSnippet("", "AB")).toBeNull();
    expect(referralWidgetSnippet("https://x.io", " ")).toBeNull();
    expect(referralWidgetSnippet(null, null)).toBeNull();
  });
});

describe("validateMilestoneDrafts", () => {
  it("parses counts, sorts ascending, and keeps unsent wire fields underneath", () => {
    const result = validateMilestoneDrafts([
      {
        count: "10",
        label: "Free month",
        kind: "free",
        wireFields: {
          count: 10,
          reward_label: "Old label",
          reward_value_cents: 2500,
          reward_currency: "EUR",
        },
      },
      { count: "3", label: "Sticker pack", kind: "swag" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.milestones.map((m) => m.count)).toEqual([3, 10]);
    // The full-replace body must not wipe the tier's monetary fields the
    // phone never rendered.
    expect(result.milestones[1]).toMatchObject({
      count: 10,
      reward_label: "Free month",
      reward_kind: "free",
      reward_value_cents: 2500,
      reward_currency: "EUR",
    });
  });

  it("refuses empties, duplicates, bad kinds and out-of-range counts", () => {
    expect(validateMilestoneDrafts([]).ok).toBe(false);
    expect(
      validateMilestoneDrafts([
        { count: "3", label: "A", kind: "" },
        { count: "3", label: "B", kind: "" },
      ]),
    ).toMatchObject({ ok: false, problem: expect.stringContaining("share") });
    expect(
      validateMilestoneDrafts([{ count: "3", label: "A", kind: "points" }]).ok,
    ).toBe(false);
    expect(
      validateMilestoneDrafts([{ count: "0", label: "A", kind: "" }]).ok,
    ).toBe(false);
    expect(
      validateMilestoneDrafts([{ count: "2.5", label: "A", kind: "" }]).ok,
    ).toBe(false);
    expect(
      validateMilestoneDrafts([{ count: "3", label: " ", kind: "" }]).ok,
    ).toBe(false);
  });
});

describe("referralExpiryIso", () => {
  it("maps empty to null (no expiry) and a date to end-of-day UTC", () => {
    expect(referralExpiryIso("")).toBeNull();
    expect(referralExpiryIso("2026-12-31")).toBe("2026-12-31T23:59:59Z");
  });

  it("returns undefined for garbage — the caller must refuse to send", () => {
    expect(referralExpiryIso("soon")).toBeUndefined();
    expect(referralExpiryIso("2026-13-99")).toBeUndefined();
  });
});

describe("buildReferralProgramBody — the full-replace contract", () => {
  const SERVER_PROGRAM = {
    id: "prog-1",
    active: true,
    milestones: [
      {
        count: 3,
        reward_label: "Sticker pack",
        reward_kind: "swag",
        reward_value_cents: 500,
      },
    ],
    expiresAt: "2026-12-31T23:59:59Z",
    referee_reward_kind: "custom",
    referee_reward_label: "10% off",
    referee_reward_image_asset_id: "asset-9",
    reward_value_cents: 500,
    reward_currency: "USD",
    reward_sku: "SKU-1",
    verification_window_days: 14,
  };

  it("editing re-sends the seven stored replace fields VERBATIM plus the CAS id", () => {
    const program = parseReferralProgram(SERVER_PROGRAM);
    expect(program).not.toBeNull();
    const body = buildReferralProgramBody(program, [], null);
    // Wiping any of these on an untouched save is the custom_fields-wipe bug
    // class all over again.
    expect(body).toMatchObject({
      expected_program_id: "prog-1",
      referee_reward_kind: "custom",
      referee_reward_label: "10% off",
      referee_reward_image_asset_id: "asset-9",
      reward_value_cents: 500,
      reward_currency: "USD",
      reward_sku: "SKU-1",
      verification_window_days: 14,
    });
    expect(body.expect_no_active_program).toBeUndefined();
  });

  it("creating asserts expect_no_active_program and never a CAS id", () => {
    const body = buildReferralProgramBody(null, [{ count: 3 }], null);
    expect(body.expect_no_active_program).toBe(true);
    expect(body.expected_program_id).toBeUndefined();
  });

  it("always carries all eleven keys — the server replaces, never merges", () => {
    const body = buildReferralProgramBody(null, [], "2027-01-01T23:59:59Z");
    for (const key of [
      "milestones",
      "expires_at",
      "referee_reward_kind",
      "referee_reward_label",
      "referee_reward_image_asset_id",
      "reward_value_cents",
      "reward_currency",
      "reward_sku",
      "verification_window_days",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(body, key)).toBe(true);
    }
    expect(body.expires_at).toBe("2027-01-01T23:59:59Z");
  });
});

describe("milestoneDraftsFrom", () => {
  it("carries each tier's wire row into its draft", () => {
    const program = parseReferralProgram({
      id: "p",
      milestones: [
        { count: 5, reward_label: "Mug", reward_kind: "swag", reward_sku: "M-1" },
      ],
    });
    const drafts = milestoneDraftsFrom(program?.milestones ?? []);
    expect(drafts[0]).toMatchObject({ count: "5", label: "Mug", kind: "swag" });
    expect(drafts[0]?.wireFields).toMatchObject({ reward_sku: "M-1" });
  });
});

describe("role floor", () => {
  it("every referral admin verb is admin", () => {
    expect(REFERRAL_ADMIN_MINIMUM_ROLE).toBe("admin");
  });
});
