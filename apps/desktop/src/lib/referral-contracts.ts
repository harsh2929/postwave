import type {
  ReferralLeaderboardResponse,
  ReferralMilestone,
  ReferralMilestonePayout,
  ReferralMilestonePayoutListResponse,
  ReferralProgram,
  ReferralRewardKind,
  ReferralStatsResponse,
  ReferralSubscriberView,
} from "./api-client";

const MAX_MILESTONES = 50;
const MAX_MILESTONE_COUNT = 1_000_000;
const MAX_REWARD_LABEL_CHARACTERS = 200;
const MAX_STATS_ROWS = 200;
const MAX_LEADERBOARD_ROWS = 100;
const MAX_PAYOUT_ROWS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isNonEmptyString(
  value: unknown,
  maximumCharacters = 2_000,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= maximumCharacters
  );
}

function isOptionalString(
  value: unknown,
  maximumCharacters = 2_000,
): value is string | undefined {
  return value === undefined || isNonEmptyString(value, maximumCharacters);
}

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match || match[1] === "0000") return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth && !Number.isNaN(Date.parse(value));
}

function isSafeMaskedEmail(value: unknown): value is string {
  return (
    value === "***" ||
    (typeof value === "string" &&
      value.length <= 320 &&
      /^[^@\s]\*{3}@[^@\s]{1,253}$/u.test(value))
  );
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isOptionalIsoInstant(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || isIsoInstant(value);
}

function isRewardKind(value: unknown): value is ReferralRewardKind {
  return (
    value === "swag" ||
    value === "free" ||
    value === "annual" ||
    value === "custom"
  );
}

function isOptionalRewardKind(
  value: unknown,
): value is ReferralRewardKind | undefined {
  return value === undefined || isRewardKind(value);
}

function isOptionalNonNegativeInteger(
  value: unknown,
): value is number | undefined {
  return value === undefined || isFiniteInteger(value, 0);
}

function decodeMilestone(value: unknown): ReferralMilestone | null {
  if (
    !isRecord(value) ||
    !isFiniteInteger(value.count, 1, MAX_MILESTONE_COUNT) ||
    !isNonEmptyString(value.reward_label, MAX_REWARD_LABEL_CHARACTERS) ||
    !isOptionalRewardKind(value.reward_kind) ||
    !isOptionalNonNegativeInteger(value.reward_value_cents) ||
    !isOptionalString(value.reward_currency, 16) ||
    !isOptionalString(value.reward_sku, 256) ||
    !isOptionalString(value.reward_image_asset_id, 256)
  ) {
    return null;
  }

  const milestone: ReferralMilestone = {
    count: value.count,
    reward_label: value.reward_label,
  };
  if (value.reward_kind !== undefined)
    milestone.reward_kind = value.reward_kind;
  if (value.reward_value_cents !== undefined)
    milestone.reward_value_cents = value.reward_value_cents;
  if (value.reward_currency !== undefined)
    milestone.reward_currency = value.reward_currency;
  if (value.reward_sku !== undefined) milestone.reward_sku = value.reward_sku;
  if (value.reward_image_asset_id !== undefined)
    milestone.reward_image_asset_id = value.reward_image_asset_id;
  return milestone;
}

function unwrapPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.data)) return value.data;
  if (isRecord(value.item)) return value.item;
  return value;
}

export function decodeReferralProgram(value: unknown): ReferralProgram | null {
  const payload = unwrapPayload(value);
  if (
    !payload ||
    !isNonEmptyString(payload.id, 128) ||
    payload.active !== true ||
    !Array.isArray(payload.milestones) ||
    payload.milestones.length < 1 ||
    payload.milestones.length > MAX_MILESTONES ||
    !isOptionalString(payload.tenantId, 128) ||
    !isOptionalIsoInstant(payload.expiresAt) ||
    (payload.createdAt !== undefined && !isIsoInstant(payload.createdAt)) ||
    (payload.updatedAt !== undefined && !isIsoInstant(payload.updatedAt)) ||
    !isOptionalRewardKind(payload.referee_reward_kind) ||
    !isOptionalString(
      payload.referee_reward_label,
      MAX_REWARD_LABEL_CHARACTERS,
    ) ||
    !isOptionalString(payload.referee_reward_image_asset_id, 256) ||
    !isOptionalNonNegativeInteger(payload.reward_value_cents) ||
    !isOptionalString(payload.reward_currency, 16) ||
    !isOptionalString(payload.reward_sku, 256) ||
    (payload.verification_window_days !== undefined &&
      !isFiniteInteger(payload.verification_window_days, 0, 30))
  ) {
    return null;
  }

  const milestones: ReferralMilestone[] = [];
  const counts = new Set<number>();
  for (const candidate of payload.milestones) {
    const milestone = decodeMilestone(candidate);
    if (!milestone || counts.has(milestone.count)) return null;
    counts.add(milestone.count);
    milestones.push(milestone);
  }

  const program: ReferralProgram = {
    id: payload.id,
    active: payload.active,
    milestones,
  };
  if (payload.tenantId !== undefined) program.tenantId = payload.tenantId;
  if (payload.expiresAt !== undefined) program.expiresAt = payload.expiresAt;
  if (payload.createdAt !== undefined) program.createdAt = payload.createdAt;
  if (payload.updatedAt !== undefined) program.updatedAt = payload.updatedAt;
  if (payload.referee_reward_kind !== undefined)
    program.referee_reward_kind = payload.referee_reward_kind;
  if (payload.referee_reward_label !== undefined)
    program.referee_reward_label = payload.referee_reward_label;
  if (payload.referee_reward_image_asset_id !== undefined)
    program.referee_reward_image_asset_id =
      payload.referee_reward_image_asset_id;
  if (payload.reward_value_cents !== undefined)
    program.reward_value_cents = payload.reward_value_cents;
  if (payload.reward_currency !== undefined)
    program.reward_currency = payload.reward_currency;
  if (payload.reward_sku !== undefined) program.reward_sku = payload.reward_sku;
  if (payload.verification_window_days !== undefined)
    program.verification_window_days = payload.verification_window_days;
  return program;
}

export function decodeReferralStats(
  value: unknown,
): ReferralStatsResponse | null {
  const payload = unwrapPayload(value);
  if (!payload || !isRecord(payload.funnel)) return null;
  const funnel = payload.funnel;
  if (
    !isFiniteInteger(funnel.conversions_7d, 0) ||
    !isFiniteInteger(funnel.conversions_30d, 0) ||
    !isFiniteInteger(funnel.conversions_90d, 0) ||
    !isFiniteInteger(funnel.clicks_total, 0) ||
    !isFiniteInteger(funnel.fraud_filtered_count, 0) ||
    !Array.isArray(payload.top_referrers) ||
    payload.top_referrers.length > MAX_STATS_ROWS ||
    !Array.isArray(payload.recent) ||
    payload.recent.length > MAX_STATS_ROWS
  ) {
    return null;
  }

  const topReferrers: ReferralStatsResponse["top_referrers"] = [];
  for (const candidate of payload.top_referrers) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.subscriber_id, 128) ||
      !isFiniteInteger(candidate.count, 0) ||
      !isIsoInstant(candidate.last_at)
    ) {
      return null;
    }
    topReferrers.push({
      subscriber_id: candidate.subscriber_id,
      count: candidate.count,
      last_at: candidate.last_at,
    });
  }

  const recent: ReferralStatsResponse["recent"] = [];
  for (const candidate of payload.recent) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.referrer_id, 128) ||
      !isNonEmptyString(candidate.referee_id, 128) ||
      !isIsoInstant(candidate.created_at)
    ) {
      return null;
    }
    recent.push({
      referrer_id: candidate.referrer_id,
      referee_id: candidate.referee_id,
      created_at: candidate.created_at,
    });
  }

  return {
    funnel: {
      conversions_7d: funnel.conversions_7d,
      conversions_30d: funnel.conversions_30d,
      conversions_90d: funnel.conversions_90d,
      clicks_total: funnel.clicks_total,
      fraud_filtered_count: funnel.fraud_filtered_count,
    },
    top_referrers: topReferrers,
    recent,
  };
}

export function decodeReferralLeaderboard(
  value: unknown,
): ReferralLeaderboardResponse | null {
  const payload = unwrapPayload(value);
  if (
    !payload ||
    !isFiniteInteger(payload.window_days, 1, 365) ||
    !Array.isArray(payload.items) ||
    payload.items.length > MAX_LEADERBOARD_ROWS
  ) {
    return null;
  }
  const items: ReferralLeaderboardResponse["items"] = [];
  const ranks = new Set<number>();
  for (const candidate of payload.items) {
    if (
      !isRecord(candidate) ||
      !isSafeMaskedEmail(candidate.referrer_email_masked) ||
      !isFiniteInteger(candidate.conversions, 0) ||
      !isFiniteInteger(candidate.milestone, 0, MAX_MILESTONE_COUNT) ||
      !isFiniteInteger(candidate.rank, 1, MAX_LEADERBOARD_ROWS) ||
      ranks.has(candidate.rank)
    ) {
      return null;
    }
    ranks.add(candidate.rank);
    items.push({
      referrer_email_masked: candidate.referrer_email_masked,
      conversions: candidate.conversions,
      milestone: candidate.milestone,
      rank: candidate.rank,
    });
  }
  return { window_days: payload.window_days, items };
}

function decodePayout(value: unknown): ReferralMilestonePayout | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id, 128) ||
    !isNonEmptyString(value.referrer_id, 128) ||
    !isFiniteInteger(value.milestone, 1, MAX_MILESTONE_COUNT) ||
    !isNonEmptyString(value.reward_label, MAX_REWARD_LABEL_CHARACTERS) ||
    (value.status !== "pending" &&
      value.status !== "approved" &&
      value.status !== "paid") ||
    !isIsoInstant(value.created_at) ||
    !isIsoInstant(value.updated_at)
  ) {
    return null;
  }
  return {
    id: value.id,
    referrer_id: value.referrer_id,
    milestone: value.milestone,
    reward_label: value.reward_label,
    status: value.status,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

export function decodeReferralPayoutList(
  value: unknown,
): ReferralMilestonePayoutListResponse | null {
  const payload = unwrapPayload(value);
  if (
    !payload ||
    !Array.isArray(payload.items) ||
    payload.items.length > MAX_PAYOUT_ROWS ||
    !isFiniteInteger(payload.total, 0) ||
    payload.total < payload.items.length
  ) {
    return null;
  }
  const items: ReferralMilestonePayout[] = [];
  const ids = new Set<string>();
  for (const candidate of payload.items) {
    const payout = decodePayout(candidate);
    if (!payout || ids.has(payout.id)) return null;
    ids.add(payout.id);
    items.push(payout);
  }
  return { items, total: payload.total };
}

export function decodeReferralPayout(
  value: unknown,
): ReferralMilestonePayout | null {
  const payload = unwrapPayload(value);
  return payload ? decodePayout(payload) : null;
}

export function decodeReferralSubscriberView(
  value: unknown,
): ReferralSubscriberView | null {
  const payload = unwrapPayload(value);
  if (
    !payload ||
    !isNonEmptyString(payload.share_url, 2_048) ||
    !isNonEmptyString(payload.ref_code, 32) ||
    !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,30}[a-z0-9]$/.test(payload.ref_code) ||
    !isFiniteInteger(payload.referrals_count, 0) ||
    !Array.isArray(payload.milestones_unlocked) ||
    payload.milestones_unlocked.length > MAX_MILESTONES
  ) {
    return null;
  }
  let parsedURL: URL;
  try {
    parsedURL = new URL(payload.share_url);
  } catch {
    return null;
  }
  if (
    parsedURL.username !== "" ||
    parsedURL.password !== "" ||
    (parsedURL.protocol !== "https:" &&
      !(parsedURL.protocol === "http:" && isLocalHostname(parsedURL.hostname)))
  ) {
    return null;
  }
  const milestones: ReferralMilestone[] = [];
  for (const candidate of payload.milestones_unlocked) {
    const milestone = decodeMilestone(candidate);
    if (!milestone) return null;
    milestones.push(milestone);
  }
  return {
    share_url: payload.share_url,
    ref_code: payload.ref_code,
    referrals_count: payload.referrals_count,
    milestones_unlocked: milestones,
  };
}
