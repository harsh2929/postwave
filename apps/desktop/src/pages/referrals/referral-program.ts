import type { ReferralMilestone, ReferralProgram } from "../../lib/api-client";
import { decodeReferralProgram } from "../../lib/referral-contracts";

export type RewardKind = "swag" | "free" | "annual" | "custom";

export const MAX_REFERRAL_MILESTONES = 50;
export const MAX_REFERRAL_COUNT = 1_000_000;
export const MAX_REFERRAL_REWARD_LABEL_CHARS = 200;

export const KIND_LABELS: Record<RewardKind, string> = {
  swag: "Branded swag",
  free: "Free time",
  annual: "Annual / lifetime",
  custom: "Custom",
};

export interface DraftMilestone {
  count: string;
  imageAssetId?: string;
  kind: RewardKind;
  label: string;
  rewardCurrency?: string;
  rewardSku?: string;
  rewardValueCents?: number;
}

export const DEFAULT_REFERRAL_DRAFTS: DraftMilestone[] = [
  { count: "3", kind: "swag", label: "Branded swag" },
  { count: "10", kind: "free", label: "1 month free" },
  { count: "25", kind: "annual", label: "Annual subscription" },
];

function isRewardKind(value: unknown): value is RewardKind {
  return (
    value === "swag" ||
    value === "free" ||
    value === "annual" ||
    value === "custom"
  );
}

export function parseReward(raw: string): {
  kind: RewardKind;
  label: string;
} {
  const match = /^\[([a-z]+)\]\s*(.*)$/.exec(raw ?? "");
  if (match && isRewardKind(match[1])) {
    return { kind: match[1], label: (match[2] ?? "").trim() };
  }
  return { kind: "custom", label: (raw ?? "").trim() };
}

export function milestoneDraft(milestone: ReferralMilestone): DraftMilestone {
  const parsed = parseReward(milestone.reward_label);
  const structuralKind = isRewardKind(milestone.reward_kind)
    ? milestone.reward_kind
    : null;
  return {
    count: String(milestone.count),
    kind: structuralKind ?? parsed.kind,
    label:
      structuralKind && parsed.kind === structuralKind
        ? parsed.label
        : structuralKind
          ? milestone.reward_label.trim()
          : parsed.label,
    imageAssetId: milestone.reward_image_asset_id,
    rewardValueCents: milestone.reward_value_cents,
    rewardCurrency: milestone.reward_currency,
    rewardSku: milestone.reward_sku,
  };
}

export function normalizeReferralProgram(
  value: unknown,
): ReferralProgram | null {
  return decodeReferralProgram(value);
}

export type DraftValidation =
  | { error: string; ok: false }
  | { milestones: ReferralMilestone[]; ok: true };

export function validateReferralDrafts(
  drafts: DraftMilestone[],
): DraftValidation {
  if (drafts.length === 0) {
    return { error: "Add at least one milestone.", ok: false };
  }
  if (drafts.length > MAX_REFERRAL_MILESTONES) {
    return {
      error: `A program can have at most ${MAX_REFERRAL_MILESTONES} milestones.`,
      ok: false,
    };
  }

  const milestones: ReferralMilestone[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const count = Number(draft.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_REFERRAL_COUNT) {
      return {
        error: `Milestone ${index + 1}: referrals must be a whole number from 1 to ${MAX_REFERRAL_COUNT.toLocaleString()}.`,
        ok: false,
      };
    }
    if (seen.has(count)) {
      return {
        error: `Milestone ${index + 1}: ${count.toLocaleString()} referrals is duplicated.`,
        ok: false,
      };
    }
    seen.add(count);

    const label = draft.label.trim();
    if (!label) {
      return {
        error: `Milestone ${index + 1}: reward label is required.`,
        ok: false,
      };
    }
    if (Array.from(label).length > MAX_REFERRAL_REWARD_LABEL_CHARS) {
      return {
        error: `Milestone ${index + 1}: reward label must be ${MAX_REFERRAL_REWARD_LABEL_CHARS} characters or fewer.`,
        ok: false,
      };
    }
    milestones.push({
      count,
      reward_label: label,
      reward_kind: draft.kind,
      reward_image_asset_id: draft.imageAssetId,
      reward_value_cents: draft.rewardValueCents,
      reward_currency: draft.rewardCurrency,
      reward_sku: draft.rewardSku,
    });
  }
  milestones.sort((left, right) => left.count - right.count);
  return { milestones, ok: true };
}

export function isoDateValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function expiryIso(date: string): string | null | undefined {
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T23:59:59Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function programReplaceFields(
  program: ReferralProgram | null | undefined,
): Partial<ReferralProgram> {
  if (!program) return {};
  return {
    referee_reward_kind: program.referee_reward_kind,
    referee_reward_label: program.referee_reward_label,
    referee_reward_image_asset_id: program.referee_reward_image_asset_id,
    reward_value_cents: program.reward_value_cents,
    reward_currency: program.reward_currency,
    reward_sku: program.reward_sku,
    verification_window_days: program.verification_window_days,
  };
}
