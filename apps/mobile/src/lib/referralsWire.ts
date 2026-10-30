/**
 * lib/referralsWire.ts — the referral payload shapes and their parsers.
 *
 * The second of the three modules behind `lib/referrals.ts` (see that file's
 * header for the split). Everything here answers one question: what did the
 * server actually send? Nothing here decides what a person is told about it —
 * that is lib/referralsCopy.ts — and nothing here knows which routes exist,
 * which is lib/referralsBoundary.ts.
 *
 * The rule the whole module is built on: ABSENCE IS NOT ZERO. A field the
 * server did not send parses to `null` (or is dropped), never to 0, so the
 * screen can render an em-dash for "we do not know" and a real 0 for "none".
 * `numberOrNull` is the single place that distinction is made.
 *
 * Import-free on purpose, so every parser is unit-testable in the node vitest
 * environment without a device or a React renderer.
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Finite numbers only; anything else is ABSENT, not zero. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | undefined {
  const out = text(value);
  return out === "" ? undefined : out;
}

export interface ReferralMilestone {
  count: number;
  rewardLabel: string;
  rewardKind: string | undefined;
  /**
   * The tier's ORIGINAL wire keys, verbatim. POST /referral-programs is a
   * FULL REPLACEMENT, so an edit built from the parsed fields alone would
   * silently wipe `reward_value_cents` / `reward_currency` / `reward_sku` /
   * `reward_image_asset_id` off every untouched tier. The edit flow spreads
   * this bag and overrides only what the user changed.
   */
  wireFields: Record<string, unknown>;
}

/**
 * The seven program-level fields SetProgram replaces wholesale (referrals.go
 * :675-687), kept verbatim for the same reason as `ReferralMilestone.
 * wireFields`: mobile does not render them, but a full-replace save must
 * re-send them or erase them.
 */
export interface ReferralProgramReplaceFields {
  referee_reward_kind: string;
  referee_reward_label: string;
  referee_reward_image_asset_id: string;
  reward_value_cents: number;
  reward_currency: string;
  reward_sku: string;
  verification_window_days: number;
}

export interface ReferralProgram {
  id: string;
  active: boolean;
  milestones: ReferralMilestone[];
  expiresAt: string | undefined;
  refereeRewardLabel: string | undefined;
  verificationWindowDays: number | undefined;
  /** Verbatim for the full-replace save — see ReferralProgramReplaceFields. */
  replaceFields: ReferralProgramReplaceFields;
}

export interface ReferralFunnel {
  /**
   * `null` means the server did not send the field — rendered as an em-dash,
   * never as 0. A genuine zero arrives as 0 and reads as zero.
   */
  conversions7d: number | null;
  conversions30d: number | null;
  conversions90d: number | null;
  clicksTotal: number | null;
  fraudFilteredCount: number | null;
}

export interface ReferralLeaderboardRow {
  /** Pre-masked server-side as `a***@domain`; never an unmasked address. */
  emailMasked: string;
  conversions: number;
  /** Highest unlocked milestone count; 0 = none unlocked / no programme. */
  milestone: number;
  rank: number;
}

export interface ReferralLeaderboard {
  windowDays: number | null;
  rows: ReferralLeaderboardRow[];
}

export function parseReferralFunnel(payload: unknown): ReferralFunnel {
  const funnel = record(record(payload).funnel);
  return {
    conversions7d: numberOrNull(funnel.conversions_7d),
    conversions30d: numberOrNull(funnel.conversions_30d),
    conversions90d: numberOrNull(funnel.conversions_90d),
    clicksTotal: numberOrNull(funnel.clicks_total),
    fraudFilteredCount: numberOrNull(funnel.fraud_filtered_count),
  };
}

/**
 * `top_referrers` carries raw subscriber UUIDs and no email, so it is counted
 * for the funnel card rather than listed as identities — the leaderboard, which
 * IS masked-email bearing, is the human-readable view of the same population.
 *
 * `parseTopReferrers` below returns the same rows in full, because the
 * drill-down that turns one of those UUIDs into something a person can act on
 * (GET /api/v1/subscribers/{id}/referral → a share URL) is mounted now.
 */
export function parseTopReferrerCount(payload: unknown): number | null {
  const top = record(payload).top_referrers;
  return Array.isArray(top) ? top.length : null;
}

/** One row of `top_referrers`: a subscriber id, their 90-day credited count. */
export interface ReferralTopReferrer {
  subscriberId: string;
  count: number;
  /** ISO timestamp of their most recent credited conversion; absent if unsent. */
  lastAt: string | undefined;
}

/**
 * Rows without a subscriber id are dropped rather than rendered blank: the id
 * is the only thing on this row that can be acted on, so a row missing it is
 * not a shorter row, it is not a row.
 */
export function parseTopReferrers(payload: unknown): ReferralTopReferrer[] {
  const top = record(payload).top_referrers;
  if (!Array.isArray(top)) return [];
  const out: ReferralTopReferrer[] = [];
  for (const raw of top) {
    const row = record(raw);
    const subscriberId = text(row.subscriber_id);
    if (subscriberId === "") continue;
    out.push({
      subscriberId,
      count: numberOrNull(row.count) ?? 0,
      lastAt: optionalText(row.last_at),
    });
  }
  return out;
}

/**
 * What GET /api/v1/subscribers/{id}/referral answers with. The request is a
 * READ with a write side effect — the server's `EnsureCode` mints the code on
 * first ask — which is why the UI only issues it on an explicit tap and labels
 * the affordance as getting a link, not as viewing one.
 */
export interface SubscriberReferral {
  shareUrl: string;
  refCode: string;
  referralsCount: number | null;
  milestonesUnlocked: ReferralMilestone[];
}

/**
 * The milestone tiers on a programme and on a subscriber's unlocked list are
 * the same wire shape, parsed the same way: a tier with no `count` is not a
 * tier (it cannot be placed in the ladder), and the ladder is always returned
 * in ascending order so a renderer never has to sort it back.
 */
function parseMilestones(raw: unknown): ReferralMilestone[] {
  const items = Array.isArray(raw) ? raw : [];
  const out: ReferralMilestone[] = [];
  for (const entry of items) {
    const m = record(entry);
    const count = numberOrNull(m.count);
    if (count === null) continue;
    out.push({
      count,
      rewardLabel: text(m.reward_label) || "Reward",
      rewardKind: optionalText(m.reward_kind),
      wireFields: { ...m },
    });
  }
  out.sort((a, b) => a.count - b.count);
  return out;
}

/**
 * `null` when the payload carries no code at all. Without a code there is no
 * link, and a share sheet opened on an empty string is worse than no button.
 */
export function parseSubscriberReferral(
  payload: unknown,
): SubscriberReferral | null {
  const env = record(payload);
  const refCode = text(env.ref_code);
  const shareUrl = text(env.share_url);
  if (refCode === "" && shareUrl === "") return null;
  return {
    shareUrl,
    refCode,
    referralsCount: numberOrNull(env.referrals_count),
    milestonesUnlocked: parseMilestones(env.milestones_unlocked),
  };
}

export interface ReferralPayout {
  id: string;
  /** Raw subscriber UUID — the server sends no email on this row. */
  referrerId: string;
  milestone: number | null;
  rewardLabel: string;
  /** Server-authored; `pending | approved | paid` in every known build. */
  status: string;
  createdAt: string | undefined;
}

export interface ReferralPayoutList {
  rows: ReferralPayout[];
  /**
   * The server's `COUNT(*) OVER()` for the whole filter, which can exceed
   * `rows.length` because the query is LIMITed. `null` means the field was not
   * sent — never assume it equals the rows in hand.
   */
  total: number | null;
}

export function parseReferralPayouts(payload: unknown): ReferralPayoutList {
  const env = record(payload);
  const items = Array.isArray(env.items) ? env.items : [];
  const rows: ReferralPayout[] = [];
  for (const raw of items) {
    const row = record(raw);
    const id = text(row.id);
    // The id is the row's identity and the handle any future PATCH would need.
    if (id === "") continue;
    rows.push({
      id,
      referrerId: text(row.referrer_id),
      milestone: numberOrNull(row.milestone),
      rewardLabel: text(row.reward_label) || "Reward",
      status: text(row.status) || "unknown",
      createdAt: optionalText(row.created_at),
    });
  }
  return { rows, total: numberOrNull(env.total) };
}

export interface ReferralVariant {
  id: string;
  key: string;
  allocationPct: number | null;
  active: boolean;
  milestoneCount: number;
}

export function parseReferralVariants(payload: unknown): ReferralVariant[] {
  const env = record(payload);
  const items = Array.isArray(env.items) ? env.items : [];
  const out: ReferralVariant[] = [];
  for (const raw of items) {
    const row = record(raw);
    const key = text(row.variant_key);
    // The key is what identifies an arm to an operator; a nameless arm is not
    // reportable and would render as a bare percentage attached to nothing.
    if (key === "") continue;
    out.push({
      id: text(row.id),
      key,
      allocationPct: numberOrNull(row.allocation_pct),
      active: row.active === true,
      milestoneCount: Array.isArray(row.milestones) ? row.milestones.length : 0,
    });
  }
  return out;
}

export function parseReferralLeaderboard(payload: unknown): ReferralLeaderboard {
  const env = record(payload);
  const items = Array.isArray(env.items) ? env.items : [];
  const rows: ReferralLeaderboardRow[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const row = record(items[i]);
    const conversions = numberOrNull(row.conversions);
    if (conversions === null) continue;
    rows.push({
      // The server masks; if it somehow sent nothing, show the mask rather
      // than an empty cell — never fall back to any other field, because the
      // only other identity on this row would be an unmasked one.
      emailMasked: text(row.referrer_email_masked) || "***",
      conversions,
      milestone: numberOrNull(row.milestone) ?? 0,
      rank: numberOrNull(row.rank) ?? i + 1,
    });
  }
  return { windowDays: numberOrNull(env.window_days), rows };
}

export function parseReferralProgram(payload: unknown): ReferralProgram | null {
  const env = record(payload);
  const id = text(env.id);
  if (id === "") return null;
  return {
    id,
    active: env.active === true,
    milestones: parseMilestones(env.milestones),
    expiresAt: optionalText(env.expiresAt),
    refereeRewardLabel: optionalText(env.referee_reward_label),
    verificationWindowDays: numberOrNull(env.verification_window_days) ?? undefined,
    replaceFields: {
      referee_reward_kind: text(env.referee_reward_kind),
      referee_reward_label: text(env.referee_reward_label),
      referee_reward_image_asset_id: text(env.referee_reward_image_asset_id),
      reward_value_cents: numberOrNull(env.reward_value_cents) ?? 0,
      reward_currency: text(env.reward_currency),
      reward_sku: text(env.reward_sku),
      verification_window_days: numberOrNull(env.verification_window_days) ?? 0,
    },
  };
}
