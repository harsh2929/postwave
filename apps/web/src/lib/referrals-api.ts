// SPDX-License-Identifier: AGPL-3.0-only
// Typed, defensive client for the authenticated referral administration API.

import { api, fetchTextAuthed } from "@/lib/api";
import {
  REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE,
  REFERRAL_ATTRIBUTION_RUNTIME_UNAVAILABLE_REASON,
  REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
  REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
  REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
  REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON,
  requireReferralOperation,
} from "@/lib/referral-operational-availability";

export interface ReferralFunnel {
  conversions_7d: number;
  conversions_30d: number;
  conversions_90d: number;
  clicks_total: number;
  fraud_filtered_count: number;
}

export interface ReferralTopReferrer {
  subscriber_id: string;
  count: number;
  last_at: string;
}

export interface ReferralRecentConversion {
  referrer_id: string;
  referee_id: string;
  created_at: string;
}

export interface ReferralStats {
  funnel: ReferralFunnel;
  top_referrers: ReferralTopReferrer[];
  recent: ReferralRecentConversion[];
}

export interface ReferralLeaderRow {
  referrer_email_masked: string;
  conversions: number;
  milestone: number;
  rank: number;
}

export interface ReferralLeaderboard {
  window_days: number;
  items: ReferralLeaderRow[];
}

export type ReferralPayoutStatus = "pending" | "approved" | "paid";

export interface ReferralPayout {
  id: string;
  referrer_id: string;
  milestone: number;
  reward_label: string;
  status: ReferralPayoutStatus;
  created_at: string;
  updated_at: string;
}

export interface ReferralPayoutPage {
  items: ReferralPayout[];
  total: number;
}

export interface ReferralMilestone {
  count: number;
  reward_label: string;
  reward_kind?: "swag" | "free" | "annual" | "custom";
  reward_value_cents?: number;
  reward_currency?: string;
  reward_sku?: string;
  reward_image_asset_id?: string;
}

export interface ReferralProgram {
  id: string;
  milestones: ReferralMilestone[];
  active: boolean;
  expires_at?: string;
  referee_reward_kind?: string;
  referee_reward_label?: string;
  referee_reward_image_asset_id?: string;
  reward_value_cents?: number;
  reward_currency?: string;
  reward_sku?: string;
  verification_window_days?: number;
}

export interface ReferralProgramInput {
  milestones: ReferralMilestone[];
  expires_at?: string;
  referee_reward_kind?: string;
  referee_reward_label?: string;
  referee_reward_image_asset_id?: string;
  reward_value_cents?: number;
  reward_currency?: string;
  reward_sku?: string;
  verification_window_days?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(0, Math.floor(parsed)))
    : 0;
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeMilestone(value: unknown): ReferralMilestone | null {
  const row = record(value);
  const milestoneCount = count(row.count, 1_000_000);
  const label = text(row.reward_label).trim().slice(0, 200);
  if (milestoneCount < 1 || !label) return null;
  const kind = text(row.reward_kind);
  if (
    kind &&
    kind !== "swag" &&
    kind !== "free" &&
    kind !== "annual" &&
    kind !== "custom"
  ) {
    return null;
  }
  return {
    count: milestoneCount,
    reward_label: label,
    ...(kind === "swag" ||
    kind === "free" ||
    kind === "annual" ||
    kind === "custom"
      ? { reward_kind: kind }
      : {}),
    ...(count(row.reward_value_cents) > 0
      ? { reward_value_cents: count(row.reward_value_cents) }
      : {}),
    ...(text(row.reward_currency)
      ? { reward_currency: text(row.reward_currency).toUpperCase() }
      : {}),
    ...(text(row.reward_sku) ? { reward_sku: text(row.reward_sku) } : {}),
    ...(text(row.reward_image_asset_id)
      ? { reward_image_asset_id: text(row.reward_image_asset_id) }
      : {}),
  };
}

export function normalizeReferralStats(value: unknown): ReferralStats {
  const source = record(value);
  const funnel = record(source.funnel);
  if (
    !source.funnel ||
    !Array.isArray(source.top_referrers) ||
    !Array.isArray(source.recent) ||
    !Number.isFinite(Number(funnel.conversions_7d)) ||
    !Number.isFinite(Number(funnel.conversions_30d)) ||
    !Number.isFinite(Number(funnel.conversions_90d)) ||
    !Number.isFinite(Number(funnel.clicks_total)) ||
    !Number.isFinite(Number(funnel.fraud_filtered_count))
  ) {
    throw new Error("Referral stats response was malformed.");
  }
  return {
    funnel: {
      conversions_7d: count(funnel.conversions_7d),
      conversions_30d: count(funnel.conversions_30d),
      conversions_90d: count(funnel.conversions_90d),
      clicks_total: count(funnel.clicks_total),
      fraud_filtered_count: count(funnel.fraud_filtered_count),
    },
    top_referrers: items(source.top_referrers)
      .slice(0, 100)
      .map((value) => {
        const row = record(value);
        if (
          !text(row.subscriber_id) ||
          !Number.isFinite(Number(row.count)) ||
          !text(row.last_at)
        ) {
          throw new Error(
            "Referral stats response contained an invalid referrer.",
          );
        }
        return {
          subscriber_id: text(row.subscriber_id),
          count: count(row.count),
          last_at: text(row.last_at),
        };
      }),
    recent: items(source.recent)
      .slice(0, 200)
      .map((value) => {
        const row = record(value);
        if (
          !text(row.referrer_id) ||
          !text(row.referee_id) ||
          !text(row.created_at)
        ) {
          throw new Error(
            "Referral stats response contained an invalid conversion.",
          );
        }
        return {
          referrer_id: text(row.referrer_id),
          referee_id: text(row.referee_id),
          created_at: text(row.created_at),
        };
      }),
  };
}

export function normalizeReferralLeaderboard(
  value: unknown,
): ReferralLeaderboard {
  const source = record(value);
  if (!Array.isArray(source.items)) {
    throw new Error("Referral leaderboard response was malformed.");
  }
  const rows = source.items.slice(0, 100).map((value, index) => {
    const row = record(value);
    if (
      !text(row.referrer_email_masked) ||
      !Number.isFinite(Number(row.conversions))
    ) {
      throw new Error("Referral leaderboard contained an invalid row.");
    }
    return {
      referrer_email_masked: text(row.referrer_email_masked),
      conversions: count(row.conversions),
      milestone: count(row.milestone, 1_000_000),
      rank: count(row.rank, 100) || index + 1,
    };
  });
  return {
    window_days: Math.max(1, count(source.window_days, 365) || 90),
    items: rows,
  };
}

export function normalizeReferralPayoutPage(
  value: unknown,
): ReferralPayoutPage {
  const source = record(value);
  if (!Array.isArray(source.items)) {
    throw new Error("Referral payout response was malformed.");
  }
  const rawRows = items(source.items).slice(0, 500);
  const rows = rawRows
    .map((value) => {
      const row = record(value);
      const status = text(row.status);
      if (
        !text(row.id) ||
        (status !== "pending" && status !== "approved" && status !== "paid")
      )
        return null;
      return {
        id: text(row.id),
        referrer_id: text(row.referrer_id),
        milestone: count(row.milestone, 1_000_000),
        reward_label: text(row.reward_label),
        status,
        created_at: text(row.created_at),
        updated_at: text(row.updated_at),
      } satisfies ReferralPayout;
    })
    .filter((row): row is ReferralPayout => row !== null);
  if (rows.length !== rawRows.length) {
    throw new Error("Referral payout response contained an invalid row.");
  }
  return { items: rows, total: Math.max(rows.length, count(source.total)) };
}

export function normalizeReferralProgram(value: unknown): ReferralProgram {
  const source = record(value);
  if (
    !text(source.id) ||
    typeof source.active !== "boolean" ||
    !Array.isArray(source.milestones)
  ) {
    throw new Error("Referral program response was malformed.");
  }
  const milestones = source.milestones
    .map(normalizeMilestone)
    .filter((row): row is ReferralMilestone => row !== null)
    .slice(0, 50);
  if (milestones.length !== source.milestones.length) {
    throw new Error("Referral program response contained invalid milestones.");
  }
  const expiresAt = text(source.expiresAt) || text(source.expires_at);
  const refereeKind = text(source.referee_reward_kind);
  if (
    refereeKind &&
    refereeKind !== "swag" &&
    refereeKind !== "free" &&
    refereeKind !== "annual" &&
    refereeKind !== "custom"
  ) {
    throw new Error(
      "Referral program response contained an invalid reward kind.",
    );
  }
  return {
    id: text(source.id),
    active: source.active === true,
    milestones,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(refereeKind ? { referee_reward_kind: refereeKind } : {}),
    ...(text(source.referee_reward_label)
      ? { referee_reward_label: text(source.referee_reward_label) }
      : {}),
    ...(text(source.referee_reward_image_asset_id)
      ? {
          referee_reward_image_asset_id: text(
            source.referee_reward_image_asset_id,
          ),
        }
      : {}),
    ...(count(source.reward_value_cents) > 0
      ? { reward_value_cents: count(source.reward_value_cents) }
      : {}),
    ...(text(source.reward_currency)
      ? { reward_currency: text(source.reward_currency).toUpperCase() }
      : {}),
    ...(text(source.reward_sku) ? { reward_sku: text(source.reward_sku) } : {}),
    ...(count(source.verification_window_days, 3650) > 0
      ? {
          verification_window_days: count(
            source.verification_window_days,
            3650,
          ),
        }
      : {}),
  };
}

export async function getReferralStats(): Promise<ReferralStats> {
  return normalizeReferralStats(
    await api.get<unknown>("/api/v1/referrals/stats"),
  );
}

export async function getReferralLeaderboard(): Promise<ReferralLeaderboard> {
  return normalizeReferralLeaderboard(
    await api.get<unknown>("/api/v1/referrals/leaderboard"),
  );
}

/**
 * Creation-time windows the leaderboard offers (desktop
 * components/referrals/leaderboard-helpers.ts LEADERBOARD_WINDOWS). The
 * server parses `Nd` / `Nw` and clamps to 365 days (referrals/leaderboard.go
 * parseLeaderboardWindowDays); an unparseable value silently falls back to 90,
 * which is why only these literals are ever sent.
 */
export const REFERRAL_LEADERBOARD_WINDOWS = [
  { value: "30d", label: "30d", days: 30 },
  { value: "90d", label: "90d", days: 90 },
  { value: "365d", label: "365d", days: 365 },
] as const;

export type ReferralLeaderboardWindow =
  (typeof REFERRAL_LEADERBOARD_WINDOWS)[number]["value"];

export const REFERRAL_LEADERBOARD_DEFAULT_WINDOW: ReferralLeaderboardWindow =
  "90d";

/** Rows requested per window — an overview, not a report (server max 100). */
export const REFERRAL_LEADERBOARD_LIMIT = 20;

/**
 * GET /api/v1/referrals/leaderboard?window=&limit= — one window's ranking.
 * The response's own `window_days` is what the UI labels, so a server clamp
 * is shown as the window the server actually used.
 */
export async function getReferralLeaderboardForWindow(options: {
  window: ReferralLeaderboardWindow;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ReferralLeaderboard> {
  return normalizeReferralLeaderboard(
    await api.get<unknown>("/api/v1/referrals/leaderboard", {
      query: {
        window: options.window,
        limit: options.limit ?? REFERRAL_LEADERBOARD_LIMIT,
      },
      signal: options.signal,
    }),
  );
}

export async function listReferralPayouts(
  status?: ReferralPayoutStatus,
): Promise<ReferralPayoutPage> {
  requireReferralOperation(
    REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
    REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
  );
  return normalizeReferralPayoutPage(
    await api.get<unknown>("/api/v1/referrals/payouts", {
      query: { ...(status ? { status } : {}), limit: 500 },
    }),
  );
}

export function updateReferralPayout(
  id: string,
  status: Exclude<ReferralPayoutStatus, "pending">,
): Promise<ReferralPayout> {
  requireReferralOperation(
    REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
    REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
  );
  return api.patch<ReferralPayout>(
    `/api/v1/referrals/payouts/${encodeURIComponent(id)}`,
    { status },
  );
}

export function referralPayoutsCsv(): Promise<string> {
  requireReferralOperation(
    REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
    REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
  );
  return fetchTextAuthed("/api/v1/referrals/payouts/export");
}

/** The active program, or null when none has been configured. */
export async function getCurrentReferralProgram(): Promise<ReferralProgram | null> {
  try {
    return normalizeReferralProgram(
      await api.get<unknown>("/api/v1/referral-programs/current"),
    );
  } catch (error) {
    if ((error as { code?: string })?.code === "not_found") return null;
    throw error;
  }
}

/**
 * Saves a full replacement of the referral program. Callers pass every field
 * from the current program that they intend to preserve; the endpoint is not a
 * patch. The optimistic-concurrency guard is mandatory.
 */
export async function saveReferralProgram(
  input: ReferralProgramInput,
  guard: { expectedProgramId: string } | { expectNoActiveProgram: true },
): Promise<ReferralProgram | { conflict: true }> {
  requireReferralOperation(
    REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
    REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON,
  );
  const body: Record<string, unknown> = { ...input };
  if ("expectedProgramId" in guard) {
    body.expected_program_id = guard.expectedProgramId;
  } else {
    body.expect_no_active_program = true;
  }
  try {
    return normalizeReferralProgram(
      await api.post<unknown>("/api/v1/referral-programs", body),
    );
  } catch (error) {
    if ((error as { code?: string })?.code === "program_conflict") {
      return { conflict: true };
    }
    throw error;
  }
}

/** Credits a referral to a subscriber using the signed referral cookie. */
export async function creditReferral(subscriberId: string): Promise<unknown> {
  requireReferralOperation(
    REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE,
    REFERRAL_ATTRIBUTION_RUNTIME_UNAVAILABLE_REASON,
  );
  return api.post("/api/v1/referrals/credit", {
    subscriber_id: subscriberId,
  });
}
