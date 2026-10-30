/**
 * lib/outboundWebhookSelection.ts — multi-select on the outbound Webhooks
 * screen and the three bulk verbs it offers: pause, resume, delete.
 *
 * THERE IS NO BULK ROUTE. Desktop's `useCanonicalBulkActions`
 * (apps/desktop/src/pages/OutboundWebhooks.tsx) fans every bulk verb out PER
 * ID and keeps the ids that failed selected "for retry". The phone does the
 * same — sequentially, so a long loop is a visible count rather than a frozen
 * spinner — and names the failures instead of reporting "5 of 7".
 *
 * WHICH ROUTE EACH VERB USES, read off the Go handlers rather than guessed:
 *
 *   pause   PATCH  /api/v1/outbound-webhooks/{id} {active:false}
 *           The reversible stop the row already offers one at a time; history,
 *           delivery rows and signing configuration are all retained.
 *   resume  POST   /api/v1/outbound-webhooks/{id}/re-enable
 *           Desktop's bulk "resume" verb too. `Store.ReEnable`
 *           (apps/api/internal/outbound_webhooks/health.go:249) re-validates
 *           destination, receiver auth, filter and transform, then sets
 *           active=true and clears the failure streak for ANY non-deleted
 *           endpoint. That makes it right for a human-paused row AND an
 *           auto-disabled one — and a selection cannot tell those apart
 *           without each row's 24h health rollup, which is only fetched when
 *           a row is expanded. A plain PATCH {active:true} on an auto-disabled
 *           row is the wrong verb: the delivery worker disables it again.
 *   delete  DELETE /api/v1/outbound-webhooks/{id}
 *           A tombstone: "the endpoint disappears from CRUD immediately while
 *           delivery evidence remains until retention safely purges it"
 *           (handlers.go Delete). Irreversible from the app.
 *
 * All three carry session_minimum_role "admin" in routeauth/manifest.json, so
 * selection is withheld from anyone below admin rather than offered and then
 * 403'd once per row.
 *
 * Import-free of react-native / expo so every rule here runs in node vitest.
 */
import { plural, truncateMiddle } from "@/lib/format";

export const BULK_WEBHOOK_VERBS = ["pause", "resume", "delete"] as const;
export type BulkWebhookVerb = (typeof BULK_WEBHOOK_VERBS)[number];

/**
 * A phone ceiling, not a server one. Beyond this a "selection" stops being
 * something anyone reviewed before acting on it; the honest control for a
 * bigger sweep is desktop, where the whole set is visible at once.
 */
export const OUTBOUND_SELECTION_MAX = 100;

/** The fields of GET /api/v1/outbound-webhooks a bulk verb reads. */
export interface SelectableWebhook {
  id: string;
  url: string;
  description?: string | undefined;
  active: boolean;
}

/* ------------------------------------------------------------------ *
 * Selection set algebra
 * ------------------------------------------------------------------ */

/** Add or remove one id, preserving selection order (oldest tap first). */
export function toggleWebhookSelection(
  selected: readonly string[],
  id: string,
): string[] {
  if (!id) return [...selected];
  return selected.includes(id)
    ? selected.filter((s) => s !== id)
    : [...selected, id];
}

/**
 * Drop ids that are no longer in the loaded list. A refetch after a bulk
 * delete removes rows; without this the bar's count disagrees with the
 * highlighted rows and the next verb fires at something nobody can see.
 */
export function pruneWebhookSelection(
  selected: readonly string[],
  visibleIds: readonly string[],
): string[] {
  const present = new Set(visibleIds);
  return selected.filter((id) => present.has(id));
}

/** The rows behind a selection, in the order they appear in the list. */
export function selectedWebhooks<T extends SelectableWebhook>(
  rows: readonly T[],
  selected: readonly string[],
): T[] {
  const wanted = new Set(selected);
  return rows.filter((r) => wanted.has(r.id));
}

/**
 * The name a row is known by in every confirm and result line — the SAME
 * fallback EndpointRow renders as its title, so the sentence names what the
 * operator sees rather than an id.
 */
export function webhookSelectionLabel(w: SelectableWebhook): string {
  const description = (w.description ?? "").trim();
  return description || truncateMiddle(w.url, 42);
}

/* ------------------------------------------------------------------ *
 * What a verb can act on
 * ------------------------------------------------------------------ */

export interface VerbPartition<T extends SelectableWebhook> {
  /** Rows the verb will actually be sent for. */
  applicable: T[];
  /** Rows already in the target state, stated up front rather than 200'd silently. */
  skipped: T[];
}

/**
 * Pause only touches active rows and resume only inactive ones. Sending
 * PATCH {active:false} to a paused endpoint would succeed and be counted as
 * "paused", which is how an operator comes to believe a write changed rows
 * it never touched. Delete applies to every row.
 */
export function partitionForVerb<T extends SelectableWebhook>(
  rows: readonly T[],
  verb: BulkWebhookVerb,
): VerbPartition<T> {
  const applicable: T[] = [];
  const skipped: T[] = [];
  for (const row of rows) {
    const wanted =
      verb === "delete" ? true : verb === "pause" ? row.active : !row.active;
    if (wanted) applicable.push(row);
    else skipped.push(row);
  }
  return { applicable, skipped };
}

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

export interface BulkWebhookAvailability {
  enabled: boolean;
  /** Why the bar's buttons are inert — rendered beside them, never implied by opacity. */
  reason?: string;
}

/**
 * Whether the bulk buttons may fire at all. Order matters: the most durable
 * reason wins, so an offline editor hears about their role (still true when
 * the signal returns) rather than the connection.
 */
export function bulkWebhookAvailability(input: {
  count: number;
  /** canAccessMinimumRole("admin", role, mode) — see the module doc. */
  hasAdminRole: boolean;
  online: boolean;
  /** True when the session is cached/stale and must not issue writes. */
  gated: boolean;
}): BulkWebhookAvailability {
  if (!input.hasAdminRole) {
    return {
      enabled: false,
      reason:
        "Pausing, resuming and deleting webhooks need an owner or admin role.",
    };
  }
  if (input.gated) {
    return {
      enabled: false,
      reason: "Reconnect this session before changing webhooks in bulk.",
    };
  }
  if (!input.online) {
    return {
      enabled: false,
      // Deliberately not queued offline: a pause resolved hours later acts on
      // state the operator has long since moved past.
      reason: "You're offline. Bulk actions aren't queued — they need a connection.",
    };
  }
  if (input.count === 0) {
    return { enabled: false, reason: "Select at least one webhook." };
  }
  if (input.count > OUTBOUND_SELECTION_MAX) {
    return {
      enabled: false,
      reason: `Selections are capped at ${OUTBOUND_SELECTION_MAX} webhooks on a phone — narrow the list first, or do this on the web app.`,
    };
  }
  return { enabled: true };
}

/**
 * The sentence a single verb button carries when it cannot fire: the shared
 * availability reason first, then the verb's own "nothing here to act on".
 */
export function verbBlockedReason(
  verb: BulkWebhookVerb,
  rows: readonly SelectableWebhook[],
  availability: BulkWebhookAvailability,
): string | null {
  if (!availability.enabled) {
    return availability.reason ?? "Bulk actions aren't available right now.";
  }
  const { applicable } = partitionForVerb(rows, verb);
  if (applicable.length === 0) {
    if (verb === "pause") return "Every selected webhook is already paused.";
    if (verb === "resume") return "Every selected webhook is already active.";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

const VERB_WORDS: Readonly<
  Record<BulkWebhookVerb, { done: string; doing: string; progress: string }>
> = {
  pause: { done: "Paused", doing: "pause", progress: "Pausing" },
  resume: { done: "Resumed", doing: "resume", progress: "Resuming" },
  delete: { done: "Deleted", doing: "delete", progress: "Deleting" },
};

/** The bar's title, and what VoiceOver reads when the selection changes. */
export function webhookSelectionTitle(count: number): string {
  return count === 0 ? "Select webhooks" : `${count} selected`;
}

/** "Pausing 3 of 12…" — shown in place of the verbs while the loop runs. */
export function bulkWebhookBusyLabel(
  verb: BulkWebhookVerb,
  done: number,
  total: number,
): string {
  return `${VERB_WORDS[verb].progress} ${done} of ${total}…`;
}

export interface BulkWebhookConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  consequence?: string | undefined;
  destructive: boolean;
}

/**
 * Confirm copy for the verbs that need one. Pause confirms because the
 * single-row pause already does; delete confirms because it is irreversible;
 * resume does not — it is the recovery verb, and the single-row Resume has no
 * confirm either. A skipped count is stated BEFORE the tap, not discovered
 * afterwards as a shortfall in the result.
 */
export function bulkWebhookConfirmCopy<T extends SelectableWebhook>(
  verb: BulkWebhookVerb,
  partition: VerbPartition<T>,
): BulkWebhookConfirmCopy | null {
  const n = partition.applicable.length;
  if (verb === "resume") return null;
  if (verb === "pause") {
    const skipped = partition.skipped.length;
    return {
      title: `Pause ${plural(n, "webhook")}?`,
      message:
        "New events will stop being enqueued for these endpoints. History, delivery rows and signing configuration are all retained, so you can resume at any time.",
      confirmLabel: "Pause",
      ...(skipped > 0
        ? {
            consequence: `${plural(skipped, "webhook")} already paused will be left alone.`,
          }
        : {}),
      destructive: false,
    };
  }
  const named = partition.applicable
    .slice(0, 5)
    .map((row) => webhookSelectionLabel(row))
    .join(", ");
  const rest = n > 5 ? ` and ${n - 5} more` : "";
  return {
    title: `Delete ${plural(n, "webhook")}?`,
    message: `${named}${rest}`,
    confirmLabel: "Delete",
    consequence:
      "They disappear from this list immediately and stop receiving events. Delivery history is kept until retention purges it. This can't be undone from the app.",
    destructive: true,
  };
}

export interface BulkWebhookOutcome {
  /** Labels of the rows the server accepted. */
  succeeded: string[];
  /** Rows the server refused, each with the reason it gave. Ids stay selected for retry. */
  failed: { id: string; label: string; reason: string }[];
  /** Labels of rows already in the target state, never sent. */
  skipped: string[];
}

function skippedTail(verb: BulkWebhookVerb, count: number): string {
  if (count === 0 || verb === "delete") return "";
  const state = verb === "pause" ? "already paused" : "already active";
  return ` ${plural(count, "webhook")} ${state} ${count === 1 ? "was" : "were"} skipped.`;
}

/**
 * One sentence describing what the loop did. "Paused 5 of 7" with no further
 * detail is the failure mode this prevents: up to three failures are NAMED,
 * the server's own reason is quoted (it names the repair — "replace the
 * destination URL before re-enabling"), and the skipped rows are counted
 * separately so a no-op is never reported as a change.
 */
export function bulkWebhookOutcomeMessage(
  verb: BulkWebhookVerb,
  outcome: BulkWebhookOutcome,
): string {
  const words = VERB_WORDS[verb];
  const ok = outcome.succeeded.length;
  const fail = outcome.failed.length;
  const tail = skippedTail(verb, outcome.skipped.length);
  if (fail === 0) {
    return `${words.done} ${plural(ok, "webhook")}.${tail}`;
  }
  const first = outcome.failed[0] as BulkWebhookOutcome["failed"][number];
  if (ok === 0) {
    if (fail === 1) {
      return `Couldn't ${words.doing} "${first.label}" — ${first.reason}${tail}`;
    }
    return `Couldn't ${words.doing} any of the ${plural(fail, "selected webhook")} — ${first.reason}${tail}`;
  }
  const named = outcome.failed
    .slice(0, 3)
    .map((f) => `"${f.label}"`)
    .join(", ");
  const rest = fail > 3 ? ` and ${fail - 3} more` : "";
  return `${words.done} ${ok} of ${ok + fail}. ${named}${rest} ${
    fail === 1 ? "was" : "were"
  } left unchanged and ${fail === 1 ? "stays" : "stay"} selected for retry — ${first.reason}${tail}`;
}
