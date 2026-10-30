/**
 * lib/outboundWebhookBulkRun.ts — the sequential fan-out behind one bulk verb
 * on the outbound Webhooks screen.
 *
 * There is no bulk route (see lib/outboundWebhookSelection.ts); a bulk verb
 * is N single-row calls. The loop is here, not in the hook, for two reasons:
 *
 *  - It is the part that decides WHAT THE OPERATOR IS TOLD — which rows
 *    succeeded, which the server refused and why, which were never sent
 *    because they were already in the target state. That is policy, and
 *    policy runs in node vitest.
 *  - It is SEQUENTIAL on purpose. Twelve concurrent PATCHes against one
 *    tenant's webhook table is how a phone turns a tidy-up into a retry
 *    storm; one at a time also gives the bar a count to show.
 *
 * The runners are injected so the loop never imports transport. The hook
 * supplies them from api/outboundWebhooks (pause, resume) and api/settings
 * (delete); a test supplies fakes that fail on cue.
 *
 * Import-free of react-native / expo so every rule here runs in node vitest.
 */
import {
  partitionForVerb,
  webhookSelectionLabel,
  type BulkWebhookOutcome,
  type BulkWebhookVerb,
  type SelectableWebhook,
} from "@/lib/outboundWebhookSelection";

/** One call per row, keyed by verb. Resolve = accepted; reject = refused. */
export interface BulkWebhookRunners {
  pause: (id: string) => Promise<unknown>;
  resume: (id: string) => Promise<unknown>;
  delete: (id: string) => Promise<unknown>;
}

export const BULK_FALLBACK_REASON = "the server refused it";

/**
 * The reason quoted beside a failed row. The server's own sentence when it
 * sent one — "replace the destination URL before re-enabling this webhook"
 * names the repair — and a stated fallback otherwise, never `undefined` or
 * "[object Object]".
 */
export function bulkErrorReason(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return BULK_FALLBACK_REASON;
}

/**
 * Run `verb` across `rows`, one round trip at a time, in list order.
 *
 * Rows already in the target state are partitioned out BEFORE the loop and
 * reported as skipped (never sent, never counted as changed). A rejection
 * from one row does not stop the rest: the operator asked for all of them,
 * and the outcome names each failure with its reason so the retry is
 * targeted rather than blind.
 */
export async function runBulkWebhookVerb<T extends SelectableWebhook>(
  verb: BulkWebhookVerb,
  rows: readonly T[],
  runners: BulkWebhookRunners,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkWebhookOutcome> {
  const { applicable, skipped } = partitionForVerb(rows, verb);
  const outcome: BulkWebhookOutcome = {
    succeeded: [],
    failed: [],
    skipped: skipped.map((row) => webhookSelectionLabel(row)),
  };
  const run = runners[verb];
  const total = applicable.length;
  onProgress?.(0, total);
  for (let i = 0; i < applicable.length; i += 1) {
    const row = applicable[i] as T;
    const label = webhookSelectionLabel(row);
    try {
      await run(row.id);
      outcome.succeeded.push(label);
    } catch (err) {
      outcome.failed.push({ id: row.id, label, reason: bulkErrorReason(err) });
    }
    onProgress?.(i + 1, total);
  }
  return outcome;
}

/**
 * The ids that stay selected once the loop ends: the failures, so a second
 * tap retries exactly them. Succeeded and skipped rows are released — a
 * skipped row was already where the verb wanted it.
 */
export function retainAfterBulkRun(outcome: BulkWebhookOutcome): string[] {
  return outcome.failed.map((failure) => failure.id);
}
