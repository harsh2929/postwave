import { describe, expect, it } from "vitest";

import type { ReferralProgram } from "../../lib/api-client";
import {
  expiryIso,
  MAX_REFERRAL_COUNT,
  MAX_REFERRAL_MILESTONES,
  MAX_REFERRAL_REWARD_LABEL_CHARS,
  milestoneDraft,
  normalizeReferralProgram,
  parseReward,
  programReplaceFields,
  validateReferralDrafts,
} from "../../pages/referrals/referral-program";

function program(overrides: Partial<ReferralProgram> = {}): ReferralProgram {
  return {
    id: "program-1",
    active: true,
    milestones: [{ count: 3, reward_label: "Hoodie", reward_kind: "swag" }],
    ...overrides,
  };
}

describe("referral program contracts", () => {
  it("normalizes direct and legacy-wrapped programs but rejects malformed success", () => {
    const value = program();
    expect(normalizeReferralProgram(value)).toEqual(value);
    expect(normalizeReferralProgram({ data: value })).toEqual(value);
    expect(normalizeReferralProgram({ item: value })).toEqual(value);
    expect(normalizeReferralProgram({ id: "bad", active: true })).toBeNull();
    expect(
      normalizeReferralProgram({
        ...value,
        milestones: [{ count: "3", reward_label: "Hoodie" }],
      }),
    ).toBeNull();
  });

  it("reads legacy prefixes and cleans already-prefixed structural labels", () => {
    expect(parseReward("[free] 1 month free")).toEqual({
      kind: "free",
      label: "1 month free",
    });
    expect(parseReward("ordinary label")).toEqual({
      kind: "custom",
      label: "ordinary label",
    });
    expect(
      milestoneDraft({
        count: 5,
        reward_label: "[swag] Hoodie",
        reward_kind: "swag",
        reward_image_asset_id: "asset-1",
        reward_value_cents: 2500,
        reward_currency: "USD",
        reward_sku: "hoodie-blue",
      }),
    ).toEqual({
      count: "5",
      kind: "swag",
      label: "Hoodie",
      imageAssetId: "asset-1",
      rewardValueCents: 2500,
      rewardCurrency: "USD",
      rewardSku: "hoodie-blue",
    });
  });

  it("builds a sorted structural payload with plain labels and preserved fields", () => {
    const result = validateReferralDrafts([
      {
        count: "10",
        kind: "free",
        label: "  One month  ",
        imageAssetId: "asset-1",
        rewardValueCents: 1200,
        rewardCurrency: "USD",
        rewardSku: "month-one",
      },
      { count: "3", kind: "swag", label: "Hoodie" },
    ]);

    expect(result).toEqual({
      ok: true,
      milestones: [
        {
          count: 3,
          reward_label: "Hoodie",
          reward_kind: "swag",
          reward_image_asset_id: undefined,
          reward_value_cents: undefined,
          reward_currency: undefined,
          reward_sku: undefined,
        },
        {
          count: 10,
          reward_label: "One month",
          reward_kind: "free",
          reward_image_asset_id: "asset-1",
          reward_value_cents: 1200,
          reward_currency: "USD",
          reward_sku: "month-one",
        },
      ],
    });
  });

  it("rejects fractional, duplicate, oversized, and excessive milestones", () => {
    const errors = [
      validateReferralDrafts([
        { count: "1.5", kind: "custom", label: "Fractional" },
      ]),
      validateReferralDrafts([
        { count: "3", kind: "custom", label: "One" },
        { count: "3", kind: "custom", label: "Two" },
      ]),
      validateReferralDrafts([
        {
          count: String(MAX_REFERRAL_COUNT + 1),
          kind: "custom",
          label: "Too high",
        },
      ]),
      validateReferralDrafts([
        {
          count: "1",
          kind: "custom",
          label: "😀".repeat(MAX_REFERRAL_REWARD_LABEL_CHARS + 1),
        },
      ]),
      validateReferralDrafts(
        Array.from({ length: MAX_REFERRAL_MILESTONES + 1 }, (_, index) => ({
          count: String(index + 1),
          kind: "custom" as const,
          label: `Reward ${index + 1}`,
        })),
      ),
    ];
    expect(errors.every((result) => !result.ok)).toBe(true);
    const messages = errors.map((result) => (result.ok ? "" : result.error));
    expect(messages[0]).toContain("whole number");
    expect(messages[1]).toContain("duplicated");
    expect(messages[2]).toContain(MAX_REFERRAL_COUNT.toLocaleString());
    expect(messages[3]).toContain(
      `${MAX_REFERRAL_REWARD_LABEL_CHARS} characters`,
    );
    expect(messages[4]).toContain(`at most ${MAX_REFERRAL_MILESTONES}`);
  });

  it("validates UTC expiry dates and preserves every full-replace setting", () => {
    expect(expiryIso("")).toBeNull();
    expect(expiryIso("2026-08-31")).toBe("2026-08-31T23:59:59.000Z");
    expect(expiryIso("not-a-date")).toBeUndefined();

    expect(
      programReplaceFields(
        program({
          referee_reward_kind: "custom",
          referee_reward_label: "Welcome credit",
          referee_reward_image_asset_id: "asset-referee",
          reward_value_cents: 500,
          reward_currency: "USD",
          reward_sku: "credit-5",
          verification_window_days: 14,
        }),
      ),
    ).toEqual({
      referee_reward_kind: "custom",
      referee_reward_label: "Welcome credit",
      referee_reward_image_asset_id: "asset-referee",
      reward_value_cents: 500,
      reward_currency: "USD",
      reward_sku: "credit-5",
      verification_window_days: 14,
    });
  });
});
