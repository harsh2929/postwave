// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers for the Commerce workspace's Recovery and Lifecycle tabs.
 *
 * Render-free so they unit-test under the node vitest environment. The copy,
 * masks, and thresholds mirror apps/desktop's commerce helpers so both clients
 * read the same record the same way; the report/acknowledgement guards are
 * what stops a malformed answer from rendering as totals a reader might act
 * on.
 */

import type {
  CommerceIntegration,
  CommerceLifecycleEvaluation,
  CommerceLifecycleReport,
  CommerceLifecycleStats,
} from "./commerce-api";

/* ---------- status vocabularies (the values the list handlers filter on) ---------- */

export const CART_RECOVERY_STATUSES = [
  "active",
  "converted",
  "expired",
  "disabled",
] as const;

export const BACK_IN_STOCK_STATUSES = [
  "waiting",
  "eligible",
  "notified",
  "expired",
  "cancelled",
] as const;

export const PRICE_DROP_STATUSES = [
  "watching",
  "eligible",
  "notified",
  "expired",
  "cancelled",
] as const;

export type RecoveryBadgeVariant = "success" | "warning" | "secondary";

/** Badge variant for a recovery record status: reached-the-goal is success,
 *  still-in-flight is warning, ended-without-outcome is secondary. */
export function recoveryStatusVariant(
  status: string | undefined,
): RecoveryBadgeVariant {
  const s = (status || "").toLowerCase();
  if (["converted", "recovered", "notified"].includes(s)) return "success";
  if (["active", "waiting", "pending", "eligible", "watching"].includes(s)) {
    return "warning";
  }
  return "secondary";
}

/* ---------- store + identity display ---------- */

/** How a store is named in headings and confirms: its shop domain when
 *  known, otherwise the provider plus a short id. */
export function integrationLabel(integration: CommerceIntegration): string {
  return (
    integration.shop_domain ||
    `${integration.provider} · ${integration.id.slice(0, 8)}`
  );
}

/** Customer or subscriber email as the tables show it: first character and
 *  the domain. The list is review evidence, not a contact directory. */
export function maskedEmail(value?: string | null): string {
  if (!value) return "Email not recorded";
  const [local, domain, ...rest] = value.trim().split("@");
  if (!local || !domain || rest.length > 0) return "Email recorded · masked";
  return `${local.slice(0, 1) || "•"}•••@${domain}`;
}

/* ---------- recovery URL ---------- */

/** An https URL with a host and no embedded credentials, normalized; null
 *  for anything else. A recovery link is opened by a customer, so a
 *  plaintext or credentialed destination is refused before it is stored. */
export function verifiedHttpsUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Origin of a stored recovery URL for display. The path and query may carry
 *  the recovery token, so they never render in a list. */
export function recoveryUrlOrigin(value: string): string | null {
  const verified = verifiedHttpsUrl(value);
  return verified ? new URL(verified).origin : null;
}

/* ---------- price-drop target ---------- */

export type TargetPriceParse =
  | { ok: true; cents: number }
  | { ok: false; error: string };

/** A customer-facing amount ("39.00") to the integer cents the price-drop
 *  create route expects. More than two decimals or a non-positive amount is
 *  refused with the sentence the field shows. */
export function parseTargetPriceCents(input: string): TargetPriceParse {
  const normalized = input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) {
    return {
      ok: false,
      error:
        "Enter a positive target price with no more than two decimal places.",
    };
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { ok: false, error: "Target price must be greater than zero." };
  }
  return { ok: true, cents };
}

/* ---------- lifecycle report + acknowledgement guards ---------- */

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A `map[string]int` on the wire; a nil map serializes as null, which is an
 *  empty breakdown rather than a malformed one. */
function isCountMap(value: unknown): value is Record<string, number> | null {
  if (value === null || value === undefined) return true;
  return (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(isCount)
  );
}

function isLifecycleStats(value: unknown): value is CommerceLifecycleStats {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { total?: unknown; by_status?: unknown };
  return isCount(candidate.total) && isCountMap(candidate.by_status);
}

/** The report shape the handler documents. Anything else is not rendered as
 *  totals, because a reader would act on them. */
export function isLifecycleReport(
  value: unknown,
): value is CommerceLifecycleReport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CommerceLifecycleReport>;
  return (
    typeof candidate.integration_id === "string" &&
    typeof candidate.generated_at === "string" &&
    isLifecycleStats(candidate.cart_recovery) &&
    isLifecycleStats(candidate.back_in_stock) &&
    isLifecycleStats(candidate.price_drop) &&
    isCountMap(candidate.events_last_30_days) &&
    isCount(candidate.eligible_last_30_days) &&
    isCount(candidate.notified_pending)
  );
}

export const LIFECYCLE_INVALID_REPORT =
  "The service returned an invalid lifecycle report. Retry before acting on these totals.";
export const LIFECYCLE_WRONG_STORE_REPORT =
  "The service returned a report for another store. No totals are shown; retry to restore verified store context.";
export const LIFECYCLE_LOAD_FAILURE =
  "The lifecycle service could not be reached. Check the connection and retry.";
export const LIFECYCLE_EVALUATE_FAILURE =
  "The lifecycle evaluator could not be reached. No completion was confirmed; try again.";

/**
 * Why a 200 lifecycle report must not be rendered as totals — null when it
 * may be. Two ways a successful transport still carries an unusable answer:
 * a shape the handler does not document, and a report whose
 * `integration_id` is a DIFFERENT store from the one asked about (a stale
 * in-flight answer arriving after the selection moved). Both would otherwise
 * render as numbers a reader acts on.
 */
export function lifecycleReportRefusal(
  value: unknown,
  integrationId: string,
): string | null {
  if (!isLifecycleReport(value)) return LIFECYCLE_INVALID_REPORT;
  if (value.integration_id !== integrationId) {
    return LIFECYCLE_WRONG_STORE_REPORT;
  }
  return null;
}

/** The counters the evaluator acknowledges with. A 200 without them is an
 *  ambiguous completion, not a success to summarize. */
export function isEvaluationAcknowledgement(
  value: unknown,
): value is CommerceLifecycleEvaluation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CommerceLifecycleEvaluation>;
  return (
    isCount(candidate.back_in_stock_eligible) &&
    isCount(candidate.price_drop_eligible) &&
    typeof candidate.evaluated_at === "string"
  );
}

/* ---------- lifecycle report flattening ---------- */

export interface LifecycleRow {
  kind: string;
  total: number;
  /** "pending 3 · notified 1" — stable alphabetical order, em dash when empty. */
  byStatus: string;
}

export function lifecycleRows(report: CommerceLifecycleReport): LifecycleRow[] {
  const row = (kind: string, stats: CommerceLifecycleStats): LifecycleRow => ({
    kind,
    total: stats.total,
    byStatus:
      Object.entries(stats.by_status ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, count]) => `${status} ${count.toLocaleString()}`)
        .join(" · ") || "—",
  });
  return [
    row("Cart recovery", report.cart_recovery),
    row("Back in stock", report.back_in_stock),
    row("Price drop", report.price_drop),
  ];
}

export function eventCounts30d(
  report: CommerceLifecycleReport,
): Array<{ event: string; count: number }> {
  return Object.entries(report.events_last_30_days ?? {})
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
}

/** "back_in_stock_eligible" → "Back In Stock Eligible". */
export function eventLabel(value: string): string {
  return (
    value
      .split(/[._-]+/u)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") || "Recorded event"
  );
}

/** The evaluator's acknowledgement counters, verbatim, as the success toast. */
export function evaluateSummaryMessage(
  summary: Pick<
    CommerceLifecycleEvaluation,
    "back_in_stock_eligible" | "price_drop_eligible"
  >,
): string {
  return (
    `Evaluation finished: ${summary.back_in_stock_eligible.toLocaleString()} back-in-stock and ` +
    `${summary.price_drop_eligible.toLocaleString()} price-drop subscriptions are now eligible to notify.`
  );
}
