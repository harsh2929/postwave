/**
 * merge-tags-helpers — pure plan/result copy for the tag merge flow
 * (full-surface wiring #27).
 *
 * The Go merge handler (tag_taxonomy.go) responds
 * `{from, into, subscribers_updated}` per call — never the legacy
 * `{merged}` the old client type claimed. These builders keep the UI
 * honest:
 *
 *   - the ConfirmModal copy cites the *predicted* count from the
 *     taxonomy usage map and says so,
 *   - the result toast reports only server-confirmed
 *     `subscribers_updated` totals, and says when the server didn't
 *     report a count instead of inventing a zero,
 *   - partial failures name the tags that failed.
 */

import type { TagUsage } from "../../lib/api-client";

const plural = (n: number): string => (n === 1 ? "" : "s");

export interface MergePlanCopy {
  title: string;
  description: string;
  /** Predicted affected subscribers (from the usage map, may be stale). */
  predicted: number;
}

/** Copy for the ConfirmModal shown before any merge request is sent. */
export function mergePlanCopy(
  sources: string[],
  target: string,
  usage?: Record<string, TagUsage>,
): MergePlanCopy {
  const predicted = sources.reduce(
    (sum, name) => sum + (usage?.[name]?.subscribers ?? 0),
    0,
  );
  const sourceList = sources.map((s) => `"${s}"`).join(", ");
  const countPart = usage
    ? `Currently ~${predicted.toLocaleString()} subscriber${plural(predicted)} carry the source tag${plural(sources.length)} (count may drift until the merge runs).`
    : "Subscriber counts are unavailable right now, so the affected total will only be known after the merge.";
  return {
    title:
      sources.length === 1
        ? `Merge "${sources[0]}" into "${target}"?`
        : `Merge ${sources.length} tags into "${target}"?`,
    description:
      `Every subscriber tagged ${sourceList} will also be tagged "${target}". ` +
      `${countPart} A successful server merge permanently removes the source tag${plural(sources.length)} from the catalogue.`,
    predicted,
  };
}

export interface MergeOutcome {
  from: string;
  ok: boolean;
  /** Server-confirmed count; undefined when the server omitted it. */
  subscribersUpdated?: number;
  error?: string;
}

export interface MergeResultToast {
  ok: boolean;
  message: string;
  detail?: string;
}

/** Honest aggregated toast copy after the merge requests resolved. */
export function mergeResultToastCopy(
  target: string,
  outcomes: MergeOutcome[],
): MergeResultToast {
  const succeeded = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);

  if (succeeded.length === 0) {
    const first = failed[0];
    return {
      ok: false,
      message:
        failed.length === 1
          ? `Couldn't merge "${first?.from ?? "tag"}"`
          : `Merge failed for all ${failed.length} tags`,
      detail: first?.error,
    };
  }

  // Only sum counts the server actually confirmed.
  const confirmed = succeeded.filter((o) => o.subscribersUpdated != null);
  const total = confirmed.reduce(
    (sum, o) => sum + (o.subscribersUpdated ?? 0),
    0,
  );
  const countPart =
    confirmed.length === succeeded.length
      ? `${total.toLocaleString()} subscriber${plural(total)} updated`
      : confirmed.length > 0
        ? `at least ${total.toLocaleString()} subscriber${plural(total)} updated (server didn't report a count for every merge)`
        : "server didn't report how many subscribers were updated";

  if (failed.length === 0) {
    return {
      ok: true,
      message:
        succeeded.length === 1
          ? `Merged "${succeeded[0]!.from}" into "${target}"`
          : `Merged ${succeeded.length} tags into "${target}"`,
      detail: `${countPart}.`,
    };
  }
  return {
    ok: false,
    message: `Merged ${succeeded.length} of ${outcomes.length} tags into "${target}"`,
    detail: `${countPart}. Failed: ${failed
      .map((f) => `"${f.from}"${f.error ? ` (${f.error})` : ""}`)
      .join(", ")}.`,
  };
}
