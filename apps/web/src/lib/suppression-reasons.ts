// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared metadata for suppression reasons — human labels, which reasons an
// operator may pick manually, and a severity→Badge-variant map. Extracted so
// the Add/Import dialogs and the table read ONE source of truth instead of
// each re-listing the enum (GOV-040/041/043).

import type { SuppressionReason } from "@/lib/suppressions-admin-api";

/** Every canonical reason with a human label. Ordered manual-first. */
export const SUPPRESSION_REASON_LABELS: Record<SuppressionReason, string> = {
  list_manual: "Manual list suppression",
  manual_unsubscribe: "Manual unsubscribe",
  global_unsubscribe: "Global unsubscribe",
  soft_bounce_threshold: "Soft-bounce threshold",
  dsar_deletion: "DSAR deletion",
  role_address: "Role address",
  invalid_email: "Invalid email",
  blocklist_auto: "Automatic blocklist",
  list_unsub_header: "List-Unsubscribe request",
  role_account: "Role account",
  invalid_address: "Invalid address",
  hard_bounce: "Hard bounce",
  spam_complaint: "Spam complaint",
  soft_bounce: "Soft bounce",
  complaint: "Complaint",
  spamtrap: "Spam trap",
  dns_failure: "DNS failure",
};

/**
 * Reasons a human should be able to choose when adding a hold manually.
 * The bounce/complaint pipeline sets the rest (hard_bounce, spam_complaint,
 * spamtrap, dns_failure, soft_bounce) automatically — offering them in the
 * Add/Import selects lets operators mislabel a manual hold (GOV-041).
 */
export const MANUAL_SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  "list_manual",
  "manual_unsubscribe",
  "list_unsub_header",
  "role_account",
  "invalid_address",
] as const;

/** Reasons set automatically by the deliverability pipeline (not human-chosen). */
const SYSTEM_REASONS = new Set<SuppressionReason>([
  "hard_bounce",
  "spam_complaint",
  "soft_bounce_threshold",
  "blocklist_auto",
  "soft_bounce",
  "complaint",
  "spamtrap",
  "dns_failure",
]);

/** Serious/permanent deliverability failures — rendered destructive. */
const SEVERE_REASONS = new Set<string>([
  "hard_bounce",
  "spam_complaint",
  "spamtrap",
  "dns_failure",
  "invalid_address",
]);

/** Transient/soft failures — rendered as a warning. */
const WARNING_REASONS = new Set<string>(["soft_bounce"]);

export type ReasonBadgeVariant = "destructive" | "warning" | "secondary";

/**
 * Maps a reason to a Badge severity so a hard bounce/complaint reads visually
 * distinct from a benign manual hold (GOV-040). Unknown/manual reasons fall to
 * the neutral `secondary`.
 */
export function reasonBadgeVariant(
  reason: string | undefined | null,
): ReasonBadgeVariant {
  if (!reason) return "secondary";
  const key = reason.trim().toLowerCase();
  if (SEVERE_REASONS.has(key)) return "destructive";
  if (WARNING_REASONS.has(key)) return "warning";
  return "secondary";
}

/** Human label for a reason, falling back to the raw value for unknowns. */
export function reasonLabel(reason: string | undefined | null): string {
  if (!reason) return "—";
  const key = reason.trim() as SuppressionReason;
  return SUPPRESSION_REASON_LABELS[key] ?? reason;
}

/** True when the reason is normally set by the pipeline, not a human. */
export function isSystemReason(reason: string | undefined | null): boolean {
  if (!reason) return false;
  return SYSTEM_REASONS.has(reason.trim() as SuppressionReason);
}
