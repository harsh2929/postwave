/**
 * lib/commerceLifecycle.ts — reading a store's lifecycle demand, and the words
 * that go around the one write that can change it.
 *
 * WHAT THE REPORT IS. `GET /api/v1/commerce/integrations/{id}/lifecycle/report`
 * answers `CommerceLifecycleReport` (commerce/types.go:462): three queue
 * summaries (cart recovery, back-in-stock, price-drop), each a total plus a
 * `by_status` map in the SERVER's own status vocabulary, a 30-day event
 * histogram, an eligible-in-30-days count and a notified-pending count. None of
 * those vocabularies is closed — `by_status` is whatever statuses the rows
 * actually hold — so every map here is rendered as the server sends it rather
 * than folded into a client-side enum that would silently drop a status this
 * build has never seen.
 *
 * ELIGIBLE IS NOT NOTIFIED. This is the whole reason the surface exists and the
 * reason its copy is careful. `EvaluateLifecycleTriggers` (repo.go:1221) marks
 * qualifying back-in-stock and price-drop subscriptions ELIGIBLE; it queues
 * nothing, sends nothing and proves nothing about delivery. Copy that said
 * "notified" would be the app claiming an outcome the response does not carry.
 *
 * WHY THE EVALUATE COPY NAMES A DENOMINATOR. The write fans out across a
 * tenant's whole catalogue for that store, and the server returns no preflight
 * count. The only honest numbers available before the tap are the ones already
 * on screen in the report, so the confirm quotes THOSE and says where they came
 * from, instead of implying it knows how many rows will flip.
 *
 * No react-native and no expo — only the equally pure `lib/format` — so the
 * node vitest run covers all of it.
 */
import { plural } from "@/lib/format";

/** A count that may legitimately be absent. Never coerced to 0. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A `map[string]int` from the server, flattened to sorted pairs.
 *
 * Sorted by key so two renders of the same report cannot reorder themselves,
 * and filtered to real numbers so a malformed entry disappears rather than
 * rendering "NaN" beside honest counts.
 */
function statusPairs(value: unknown): { key: string; count: number }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: { key: string; count: number }[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const label = text(key);
    const n = count(raw);
    if (label !== null && n !== null) out.push({ key: label, count: n });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export type LifecycleQueueKind =
  | "cart_recovery"
  | "back_in_stock"
  | "price_drop";

export interface LifecycleQueue {
  kind: LifecycleQueueKind;
  /** Our label for the queue. The STATUSES under it stay the server's. */
  label: string;
  total: number | null;
  byStatus: { key: string; count: number }[];
}

export interface CommerceLifecycleReport {
  integrationId: string | null;
  generatedAt: string | null;
  queues: LifecycleQueue[];
  eventsLast30Days: { key: string; count: number }[];
  eligibleLast30Days: number | null;
  notifiedPending: number | null;
}

const QUEUE_LABELS: Record<LifecycleQueueKind, string> = {
  cart_recovery: "Cart recovery",
  back_in_stock: "Back in stock",
  price_drop: "Price drops",
};

function parseQueue(kind: LifecycleQueueKind, value: unknown): LifecycleQueue {
  const row =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    kind,
    label: QUEUE_LABELS[kind],
    total: count(row.total),
    byStatus: statusPairs(row.by_status),
  };
}

export function parseCommerceLifecycleReport(
  value: unknown,
): CommerceLifecycleReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    integrationId: text(raw.integration_id),
    generatedAt: text(raw.generated_at),
    queues: [
      parseQueue("cart_recovery", raw.cart_recovery),
      parseQueue("back_in_stock", raw.back_in_stock),
      parseQueue("price_drop", raw.price_drop),
    ],
    eventsLast30Days: statusPairs(raw.events_last_30_days),
    eligibleLast30Days: count(raw.eligible_last_30_days),
    notifiedPending: count(raw.notified_pending),
  };
}

/**
 * Is this report about the store the reader is looking at?
 *
 * The desktop treats a mismatch as an error rather than rendering it
 * (LifecycleTab.tsx:247-254) and so does the phone: a selection can change
 * while a request is in flight, and lifecycle counts attributed to the wrong
 * shop are worse than no counts at all.
 */
export function lifecycleReportMatches(
  report: CommerceLifecycleReport | null,
  integrationId: string | null,
): boolean {
  if (!report || !integrationId) return false;
  // A server that omitted the id cannot be contradicted; only a DIFFERENT id
  // is a mismatch.
  return report.integrationId === null || report.integrationId === integrationId;
}

/** True when the report carries nothing worth a section. */
export function lifecycleReportIsEmpty(
  report: CommerceLifecycleReport | null,
): boolean {
  if (!report) return true;
  return (
    report.queues.every((q) => q.total === null || q.total === 0) &&
    report.eventsLast30Days.length === 0 &&
    (report.eligibleLast30Days ?? 0) === 0 &&
    (report.notifiedPending ?? 0) === 0
  );
}

export interface LifecycleEvaluation {
  backInStockEligible: number | null;
  priceDropEligible: number | null;
  evaluatedAt: string | null;
}

/**
 * The evaluate acknowledgement (`CommerceLifecycleEvaluationSummary`,
 * types.go:456). Returns null when the body is not an object at all; the
 * COUNTERS stay nullable on their own, because a 200 whose counters are
 * missing means the write may well have happened and only its receipt is
 * unreadable — a different fact from "it failed".
 */
export function parseLifecycleEvaluation(
  value: unknown,
): LifecycleEvaluation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    backInStockEligible: count(raw.back_in_stock_eligible),
    priceDropEligible: count(raw.price_drop_eligible),
    evaluatedAt: text(raw.evaluated_at),
  };
}

/**
 * Who may run the evaluation.
 *
 * `POST .../lifecycle/evaluate` is `ScopeAdmin` (handlers.go:157) and
 * session_minimum_role admin in the generated manifest, and no commerce write
 * is ever journalled for offline replay — so the verb is absent for a viewer
 * and absent offline, rather than present and failing after the tap.
 */
export function offersLifecycleEvaluation(input: {
  canAdmin: boolean;
  online: boolean;
}): boolean {
  return input.canAdmin && input.online;
}

export interface LifecycleConfirmCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
}

/**
 * The confirm. It has to answer three questions before a fan-out write:
 * what will be examined, what the result means, and where the numbers came
 * from. The counts are quoted from the report ON SCREEN and labelled as such —
 * the server returns no preflight estimate, so any other number would be
 * invented.
 */
export function lifecycleEvaluateConfirmCopy(
  storeName: string,
  report: CommerceLifecycleReport | null,
): LifecycleConfirmCopy {
  const backInStock = report?.queues.find((q) => q.kind === "back_in_stock");
  const priceDrop = report?.queues.find((q) => q.kind === "price_drop");
  const scope =
    backInStock?.total !== null &&
    backInStock?.total !== undefined &&
    priceDrop?.total !== null &&
    priceDrop?.total !== undefined
      ? `The report above counts ${plural(backInStock.total, "back-in-stock subscription", "back-in-stock subscriptions")} and ${plural(priceDrop.total, "price-drop watcher", "price-drop watchers")} on this store; every one of them is re-checked.`
      : "Every back-in-stock subscription and price-drop watcher on this store is re-checked. The report did not give a count, so this cannot say how many.";
  return {
    title: `Evaluate eligibility for ${storeName}?`,
    message: `Checks each back-in-stock and price-drop subscription against the inventory and price data already imported for this store, and marks the ones that now qualify as eligible. ${scope}`,
    consequence:
      "Eligible is not notified. Nothing is queued, sent or delivered by this action, and it does not prove any shopper was told.",
    confirmLabel: "Run evaluation",
  };
}

/**
 * The receipt. Two shapes, because a 200 with unreadable counters is a real
 * outcome the desktop also refuses to round up (LifecycleTab.tsx:313-320).
 */
export function lifecycleEvaluationOutcomeCopy(
  summary: LifecycleEvaluation | null,
): string {
  if (
    !summary ||
    summary.backInStockEligible === null ||
    summary.priceDropEligible === null
  ) {
    return "Evaluation ran, but the server's counters could not be read. Pull to refresh the report before running it again.";
  }
  return `${plural(summary.backInStockEligible, "back-in-stock subscription", "back-in-stock subscriptions")} and ${plural(summary.priceDropEligible, "price-drop watcher", "price-drop watchers")} are now eligible to notify. Nothing has been sent.`;
}

function statusOf(err: unknown): number {
  return err && typeof err === "object" && "status" in err
    ? Number((err as { status: unknown }).status)
    : 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message.trim() : "";
}

/**
 * The HTTP outcomes the two lifecycle routes can produce, in the operator's
 * words. 409 is `integration_disconnected` (handlers.go:1172) — a store that is
 * no longer connected cannot be re-evaluated, and saying "try again" would send
 * someone round a loop that cannot close from a phone.
 */
export function lifecycleErrorMessage(err: unknown, verb: "read" | "evaluate"): string {
  const status = statusOf(err);
  if (status === 403) {
    return verb === "evaluate"
      ? "Running an evaluation needs an owner or admin session."
      : "Reading the lifecycle report needs an owner or admin session.";
  }
  if (status === 404) {
    return "That store no longer exists. Pull to refresh.";
  }
  if (status === 409) {
    return "This store is disconnected, so its lifecycle demand can't be evaluated. Reconnect it on the web admin first.";
  }
  return (
    messageOf(err) ||
    (verb === "evaluate"
      ? "Couldn't run the evaluation."
      : "Couldn't load the lifecycle report.")
  );
}
