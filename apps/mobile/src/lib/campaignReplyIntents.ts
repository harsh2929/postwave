/**
 * lib/campaignReplyIntents.ts — narrow a reply thread to one intent.
 *
 * Desktop's CampaignRepliesSection filters the id-bearing list with the
 * `?intent=` param (campaign_replies.go:191 reads it; the unfiltered response
 * also carries `intent_counts` for the tab headers). Mobile classifies replies
 * (ReplyClassifySheet) but its list could never be narrowed, so a 200-reply
 * thread hid the five questions inside it.
 *
 * The chips reuse the exact intent vocabulary the classify verb writes
 * (lib/replyClassification REPLY_INTENTS), so a filter can never name a label
 * the server does not.
 */
import {
  REPLY_INTENTS,
  REPLY_INTENT_LABELS,
  type ReplyIntent,
} from "@/lib/replyClassification";

export interface ReplyIntentChip {
  /** null = the unfiltered "All" chip. */
  intent: ReplyIntent | null;
  label: string;
  /** From the unfiltered response's intent_counts; null = unknown. */
  count: number | null;
}

/** Counts come only from the UNFILTERED fetch, mirroring desktop. */
export function readIntentCounts(data: unknown): Record<string, number> {
  if (!data || typeof data !== "object") return {};
  const counts = (data as { intent_counts?: unknown }).intent_counts;
  if (!counts || typeof counts !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof value === "number" && value >= 0) out[key] = value;
  }
  return out;
}

export function replyIntentChips(
  counts: Readonly<Record<string, number>>,
  total: number | null,
): ReplyIntentChip[] {
  const chips: ReplyIntentChip[] = [
    { intent: null, label: "All", count: total },
  ];
  for (const intent of REPLY_INTENTS) {
    chips.push({
      intent,
      label: REPLY_INTENT_LABELS[intent],
      count: counts[intent] ?? null,
    });
  }
  return chips;
}

/** The query-string suffix for one chip; "" for the unfiltered list. */
export function intentFilterParam(intent: ReplyIntent | null): string {
  return intent ? `&intent=${encodeURIComponent(intent)}` : "";
}
