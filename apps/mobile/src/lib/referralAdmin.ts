/**
 * lib/referralAdmin.ts — the pure logic behind the referral ADMIN verbs the
 * desktop-parity pass brought to mobile: advancing a payout, editing the
 * programme (a full-replace POST with stale-write preconditions), and the
 * public widget install snippet.
 *
 * Server contracts, each read from apps/api/internal/referrals:
 *  - PATCH /referrals/payouts/{id} takes ONLY {status: "approved"|"paid"};
 *    legal transitions are pending→approved, pending→paid, approved→paid
 *    (payouts.go:338-393). There is NO way back — advancing is forward-only —
 *    so every advance confirms before it fires.
 *  - POST /referral-programs is a FULL REPLACEMENT (referrals.go:669-740)
 *    guarded by exactly one precondition: `expected_program_id` (editing) XOR
 *    `expect_no_active_program` (creating). A mismatch is a 409
 *    `program_conflict` — surfaced to the user as "refresh before saving".
 *  - GET /api/public/r/{code}/widget.js serves a self-contained referral
 *    widget for one referrer code (widget.go:30-51); the snippet is assembled
 *    client-side because no server route emits it.
 *
 * Import-free; unit-tested in the node vitest run.
 */
import type {
  ReferralMilestone,
  ReferralProgram,
} from "./referralsWire";

export const REFERRAL_ADMIN_MINIMUM_ROLE = "admin" as const;

/* ------------------------------------------------------------------ *
 * Payout advancement
 * ------------------------------------------------------------------ */

export type PayoutAdvanceTarget = "approved" | "paid";

/**
 * Which advance verbs one payout row offers — desktop's `payoutActionsFor`
 * (payout-helpers.ts:18-24), which mirrors the server's transition table
 * exactly: pending offers both, approved offers paid, paid offers nothing.
 * Unknown statuses offer nothing (never a verb the server would 409).
 */
export function payoutActionsFor(
  status: string | null | undefined,
): PayoutAdvanceTarget[] {
  const current = (status ?? "").trim().toLowerCase();
  if (current === "pending") return ["approved", "paid"];
  if (current === "approved") return ["paid"];
  return [];
}

/** The exact wire request an advance makes — pinned by the node test. */
export function payoutAdvanceRequest(
  id: string,
  status: PayoutAdvanceTarget,
): { method: "PATCH"; path: string; body: { status: PayoutAdvanceTarget } } {
  return {
    method: "PATCH",
    path: `/api/v1/referrals/payouts/${encodeURIComponent(id)}`,
    body: { status },
  };
}

export interface PayoutAdvanceCopy {
  label: string;
  confirmTitle: string;
  confirmMessage: string;
  successMessage: string;
}

export function payoutAdvanceCopy(
  target: PayoutAdvanceTarget,
  rewardLabel: string,
): PayoutAdvanceCopy {
  const reward = rewardLabel.trim() || "this reward";
  if (target === "approved") {
    return {
      label: "Approve",
      confirmTitle: `Approve ${reward}?`,
      confirmMessage:
        "Marks the reward as approved for fulfilment. Advancing a payout cannot be undone — there is no way back to pending.",
      successMessage: `${reward} approved.`,
    };
  }
  return {
    label: "Mark paid",
    confirmTitle: `Mark ${reward} as paid?`,
    confirmMessage:
      "Records that the reward has actually been handed over. This is the final state — it cannot be reversed, so mark it only after the fulfilment happened.",
    successMessage: `${reward} marked paid.`,
  };
}

/* ------------------------------------------------------------------ *
 * Widget install snippet
 * ------------------------------------------------------------------ */

/**
 * The `<script>` tag that embeds one referrer's public widget. Null when
 * either half is missing — a snippet with a blank origin or code is a paste
 * that can only 404.
 */
export function referralWidgetSnippet(
  origin: string | null | undefined,
  refCode: string | null | undefined,
): string | null {
  const base = (origin ?? "").trim().replace(/\/+$/u, "");
  const code = (refCode ?? "").trim();
  if (base === "" || code === "") return null;
  return `<script src="${base}/api/public/r/${encodeURIComponent(code)}/widget.js" async></script>`;
}

/* ------------------------------------------------------------------ *
 * Programme editing (full replace + precondition)
 * ------------------------------------------------------------------ */

/** Server caps (referrals.go:66-70, :274-308), mirrored client-side. */
export const REFERRAL_MAX_MILESTONES = 50;
export const REFERRAL_MAX_MILESTONE_COUNT = 1_000_000;
export const REFERRAL_MAX_REWARD_LABEL = 200;
export const REFERRAL_REWARD_KINDS = ["swag", "free", "annual", "custom"] as const;

export interface MilestoneDraft {
  /** Text, as typed. Parsed and validated by validateMilestoneDrafts. */
  count: string;
  label: string;
  /** One of REFERRAL_REWARD_KINDS, or "" for unset. */
  kind: string;
  /** The original wire row when this draft edits an existing tier. */
  wireFields?: Record<string, unknown>;
}

export function milestoneDraftsFrom(
  milestones: readonly ReferralMilestone[],
): MilestoneDraft[] {
  return milestones.map((m) => ({
    count: String(m.count),
    label: m.rewardLabel,
    kind: m.rewardKind ?? "",
    wireFields: m.wireFields,
  }));
}

export type MilestoneValidation =
  | { ok: true; milestones: Record<string, unknown>[] }
  | { ok: false; problem: string };

/**
 * Parse + validate the edited tiers, preserving each existing tier's unsent
 * wire fields (reward value/currency/sku/image) underneath the edits.
 */
export function validateMilestoneDrafts(
  drafts: readonly MilestoneDraft[],
): MilestoneValidation {
  if (drafts.length === 0) {
    return { ok: false, problem: "The programme needs at least one milestone." };
  }
  if (drafts.length > REFERRAL_MAX_MILESTONES) {
    return {
      ok: false,
      problem: `At most ${REFERRAL_MAX_MILESTONES} milestones.`,
    };
  }
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const draft of drafts) {
    const count = Number(draft.count.trim());
    if (
      !Number.isFinite(count) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > REFERRAL_MAX_MILESTONE_COUNT
    ) {
      return {
        ok: false,
        // Literal, not toLocaleString: this module is import-free and the
        // format.consistency sweep routes all locale formatting to lib/format.
        problem: "Each milestone needs a whole referral count between 1 and 1,000,000.",
      };
    }
    if (seen.has(count)) {
      return { ok: false, problem: `Two milestones share the count ${count}.` };
    }
    seen.add(count);
    const label = draft.label.trim();
    if (label === "") {
      return { ok: false, problem: "Every milestone needs a reward label." };
    }
    if (label.length > REFERRAL_MAX_REWARD_LABEL) {
      return {
        ok: false,
        problem: `Reward labels are capped at ${REFERRAL_MAX_REWARD_LABEL} characters.`,
      };
    }
    const kind = draft.kind.trim();
    if (
      kind !== "" &&
      !REFERRAL_REWARD_KINDS.includes(kind as (typeof REFERRAL_REWARD_KINDS)[number])
    ) {
      return {
        ok: false,
        problem: `Reward kind must be one of: ${REFERRAL_REWARD_KINDS.join(", ")}.`,
      };
    }
    rows.push({
      ...(draft.wireFields ?? {}),
      count,
      reward_label: label,
      ...(kind === "" ? { reward_kind: "" } : { reward_kind: kind }),
    });
  }
  rows.sort((a, b) => (a.count as number) - (b.count as number));
  return { ok: true, milestones: rows };
}

/**
 * Desktop's `expiryIso` (referral-program.ts:150-155): empty → null (no
 * expiry); YYYY-MM-DD → end-of-day UTC ISO; anything else → undefined, which
 * the caller must refuse before sending.
 */
export function referralExpiryIso(
  dateText: string,
): string | null | undefined {
  const trimmed = dateText.trim();
  if (trimmed === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
  const parsed = new Date(`${trimmed}T23:59:59Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return `${trimmed}T23:59:59Z`;
}

/**
 * The exact POST /api/v1/referral-programs body — always all eleven keys
 * (desktop archive-referral-operations.ts:945-960), with the one legal
 * precondition chosen by whether a programme currently exists.
 */
export function buildReferralProgramBody(
  current: ReferralProgram | null,
  milestones: Record<string, unknown>[],
  expiresAt: string | null,
): Record<string, unknown> {
  const replace = current?.replaceFields ?? {
    referee_reward_kind: "",
    referee_reward_label: "",
    referee_reward_image_asset_id: "",
    reward_value_cents: 0,
    reward_currency: "",
    reward_sku: "",
    verification_window_days: 0,
  };
  return {
    milestones,
    expires_at: expiresAt,
    ...(current
      ? { expected_program_id: current.id }
      : { expect_no_active_program: true }),
    referee_reward_kind: replace.referee_reward_kind,
    referee_reward_label: replace.referee_reward_label,
    referee_reward_image_asset_id: replace.referee_reward_image_asset_id,
    reward_value_cents: replace.reward_value_cents,
    reward_currency: replace.reward_currency,
    reward_sku: replace.reward_sku,
    verification_window_days: replace.verification_window_days,
  };
}

/** The one sentence a 409 program_conflict turns into. */
export const REFERRAL_PROGRAM_CONFLICT_MESSAGE =
  "The programme changed since this screen loaded — someone else saved first. Pull to refresh, then re-apply your edit.";
