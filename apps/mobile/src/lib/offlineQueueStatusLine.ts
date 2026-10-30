/**
 * lib/offlineQueueStatusLine.ts — what the unsent-writes bar says.
 *
 * SHELL#67's named anchor. The line was assembled in the component as
 *
 *     [statusCount(q, "queued"), statusCount(s, "syncing"),
 *      statusCount(f, "failed"), statusCount(sent, "sent")]
 *       .filter(Boolean).join(" · ")
 *
 *   with `statusCount = (n, s) => n > 0 ? `${n} ${s}` : ""`
 *
 * and that is three untranslatable assumptions stacked in six lines:
 *
 *  1. NUMBER-THEN-WORD ORDER IS FROZEN. `${count} ${status}` cannot become
 *     "queued: 3" or an inflected form. Each clause is now a whole catalogue
 *     entry with a `{count}` placeholder, so word order moves with the
 *     language.
 *  2. THE COUNT IS UNGROUPED. Every other number in the app runs through
 *     `lib/format`'s `num()`; this one printed a bare `1234`. `interpolate`
 *     groups numeric params, so the bar now agrees with the rest of the
 *     product.
 *  3. THE STATUS WORD IS SHARED ACROSS ARBITRARY GRAMMAR. English happens to
 *     use the same participle for one and many ("1 queued" / "2 queued");
 *     plenty of languages do not, so each clause is a PLURAL entry rather
 *     than a noun glued to a number.
 *
 * The separator stays a middle dot, and stays here rather than in the
 * catalogue, because it is punctuation between clauses rather than copy — a
 * translator who needs a different one changes it in one place either way, and
 * putting it in the catalogue invites someone to translate it to a word.
 *
 * Import-free of react-native/expo (only `lib/i18n`, itself import-free), so
 * the whole thing is unit-tested under node. In `i18nCoverage.test.ts`'s
 * COVERED set: a new hardcoded sentence here fails the build.
 */
import { msg, pluralMsg } from "@/lib/i18n";

export interface OfflineQueueStatusCounts {
  queued: number;
  syncing: number;
  failed: number;
  sent: number;
}

/** Clause order is deliberate: the pipeline's own order, oldest state first. */
const CLAUSES = [
  ["queued", "offline.queue.queued"],
  ["syncing", "offline.queue.syncing"],
  ["failed", "offline.queue.failed"],
  ["sent", "offline.queue.sent"],
] as const;

/**
 * "3 queued · 1 syncing". Zero-valued statuses are dropped rather than said,
 * because "0 failed" on a bar that only appears when something is unsent reads
 * as an alarm about nothing.
 *
 * Returns "" when every count is zero — the bar is not visible in that state,
 * and returning a placeholder sentence would put copy on screen for a
 * condition that cannot happen.
 */
export function offlineQueueStatusLine(
  counts: OfflineQueueStatusCounts,
): string {
  const parts: string[] = [];
  for (const [field, key] of CLAUSES) {
    const count = counts[field];
    if (count > 0) parts.push(pluralMsg(key, count));
  }
  return parts.join(" · ");
}

/**
 * What the bar's action button announces. The visible label is one word
 * ("Review"), which out of context tells a screen-reader user nothing about
 * what they would be reviewing, so the spoken form carries the summary with
 * it — one whole frame from the catalogue rather than `label + ". " + summary`
 * assembled here, which would freeze the English sentence break.
 */
export function offlineQueueReviewSpoken(summary: string): string {
  return summary
    ? msg("offline.queue.review.a11y", { summary })
    : msg("offline.queue.review.a11yPlain");
}

/** The button's visible label. */
export function offlineQueueReviewLabel(): string {
  return msg("offline.queue.review");
}

/** The button's hint — what happens after the tap. */
export function offlineQueueReviewHint(): string {
  return msg("offline.queue.review.hint");
}
