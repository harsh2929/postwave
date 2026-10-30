import { describe, expect, it } from "vitest";

import {
  decodeReferralLeaderboard,
  decodeReferralPayout,
  decodeReferralPayoutList,
  decodeReferralProgram,
  decodeReferralStats,
  decodeReferralSubscriberView,
} from "../../lib/referral-contracts";

const milestone = {
  count: 3,
  reward_label: "Branded tote",
  reward_kind: "swag",
} as const;

const program = {
  id: "program-1",
  tenantId: "tenant-1",
  active: true,
  milestones: [milestone],
  expiresAt: "2026-08-31T23:59:59.000Z",
  createdAt: "2026-07-01T09:00:00.000Z",
  updatedAt: "2026-07-20T10:30:00.000Z",
  verification_window_days: 14,
} as const;

const stats = {
  funnel: {
    conversions_7d: 4,
    conversions_30d: 12,
    conversions_90d: 31,
    clicks_total: 86,
    fraud_filtered_count: 2,
  },
  top_referrers: [
    {
      subscriber_id: "subscriber-1",
      count: 7,
      last_at: "2026-07-25T09:00:00.000Z",
    },
  ],
  recent: [
    {
      referrer_id: "subscriber-1",
      referee_id: "subscriber-2",
      created_at: "2026-07-25T09:00:00.000Z",
    },
  ],
} as const;

const leaderboard = {
  window_days: 90,
  items: [
    {
      referrer_email_masked: "a***@example.com",
      conversions: 7,
      milestone: 3,
      rank: 1,
    },
  ],
} as const;

const payout = {
  id: "payout-1",
  referrer_id: "subscriber-1",
  milestone: 3,
  reward_label: "Branded tote",
  status: "pending",
  created_at: "2026-07-25T09:00:00.000Z",
  updated_at: "2026-07-25T09:00:00.000Z",
} as const;

describe("referral wire contracts", () => {
  it("decodes canonical and wrapped program payloads without retaining unknown keys", () => {
    expect(decodeReferralProgram(program)).toEqual(program);
    expect(decodeReferralProgram({ data: program })).toEqual(program);
    expect(
      decodeReferralProgram({ item: { ...program, unknown: "ignored" } }),
    ).toEqual(program);
  });

  it("rejects unsafe or structurally impossible program payloads", () => {
    expect(decodeReferralProgram({ ...program, milestones: [] })).toBeNull();
    expect(
      decodeReferralProgram({
        ...program,
        milestones: [milestone, { ...milestone, reward_label: "Duplicate" }],
      }),
    ).toBeNull();
    expect(
      decodeReferralProgram({
        ...program,
        updatedAt: "not-a-date",
      }),
    ).toBeNull();
    expect(
      decodeReferralProgram({
        ...program,
        updatedAt: "2026-02-31T10:30:00.000Z",
      }),
    ).toBeNull();
    expect(
      decodeReferralProgram({
        ...program,
        updatedAt: "July 20, 2026 10:30 UTC",
      }),
    ).toBeNull();
    expect(
      decodeReferralProgram({
        ...program,
        verification_window_days: 31,
      }),
    ).toBeNull();
  });

  it("decodes the complete stats projection", () => {
    expect(decodeReferralStats(stats)).toEqual(stats);
    expect(decodeReferralStats({ data: stats })).toEqual(stats);
  });

  it("fails closed when stats are partial, negative, or contain malformed timestamps", () => {
    expect(
      decodeReferralStats({
        ...stats,
        funnel: { conversions_7d: 4 },
      }),
    ).toBeNull();
    expect(
      decodeReferralStats({
        ...stats,
        funnel: { ...stats.funnel, clicks_total: -1 },
      }),
    ).toBeNull();
    expect(
      decodeReferralStats({
        ...stats,
        recent: [{ ...stats.recent[0], created_at: "yesterday" }],
      }),
    ).toBeNull();
  });

  it("decodes leaderboard rows and rejects ambiguous ranks", () => {
    expect(decodeReferralLeaderboard(leaderboard)).toEqual(leaderboard);
    expect(
      decodeReferralLeaderboard({
        ...leaderboard,
        items: [
          leaderboard.items[0],
          {
            ...leaderboard.items[0],
            referrer_email_masked: "b***@example.com",
          },
        ],
      }),
    ).toBeNull();
    expect(
      decodeReferralLeaderboard({ ...leaderboard, window_days: 0 }),
    ).toBeNull();
    expect(
      decodeReferralLeaderboard({
        ...leaderboard,
        items: [
          {
            ...leaderboard.items[0],
            referrer_email_masked: "alex@example.com",
          },
        ],
      }),
    ).toBeNull();
  });

  it("decodes payout lists and individual update responses", () => {
    expect(decodeReferralPayoutList({ items: [payout], total: 1 })).toEqual({
      items: [payout],
      total: 1,
    });
    expect(decodeReferralPayout({ data: payout })).toEqual(payout);
  });

  it("rejects malformed payout status, timestamps, duplicate rows, and totals", () => {
    expect(decodeReferralPayout({ ...payout, status: "delivered" })).toBeNull();
    expect(
      decodeReferralPayout({ ...payout, updated_at: "not-a-date" }),
    ).toBeNull();
    expect(
      decodeReferralPayoutList({ items: [payout, payout], total: 2 }),
    ).toBeNull();
    expect(decodeReferralPayoutList({ items: [payout], total: 0 })).toBeNull();
  });

  it("decodes safe subscriber share views", () => {
    const view = {
      share_url: "https://news.example.com/r/acme-bestie",
      ref_code: "acme-bestie",
      referrals_count: 4,
      milestones_unlocked: [milestone],
    };
    expect(decodeReferralSubscriberView(view)).toEqual(view);
  });

  it("rejects active-content URLs, invalid codes, and malformed milestone projections", () => {
    const base = {
      share_url: "https://news.example.com/r/acme-bestie",
      ref_code: "acme-bestie",
      referrals_count: 4,
      milestones_unlocked: [milestone],
    };
    expect(
      decodeReferralSubscriberView({
        ...base,
        share_url: "javascript:alert(1)",
      }),
    ).toBeNull();
    expect(
      decodeReferralSubscriberView({
        ...base,
        share_url: "http://news.example.com/r/acme-bestie",
      }),
    ).toBeNull();
    expect(
      decodeReferralSubscriberView({
        ...base,
        share_url: "https://operator:secret@news.example.com/r/acme-bestie",
      }),
    ).toBeNull();
    expect(
      decodeReferralSubscriberView({
        ...base,
        share_url: "http://127.0.0.1:3000/r/acme-bestie",
      }),
    ).toEqual({
      ...base,
      share_url: "http://127.0.0.1:3000/r/acme-bestie",
    });
    expect(
      decodeReferralSubscriberView({ ...base, ref_code: "../escape" }),
    ).toBeNull();
    expect(
      decodeReferralSubscriberView({
        ...base,
        milestones_unlocked: [{ ...milestone, count: 0 }],
      }),
    ).toBeNull();
  });
});
