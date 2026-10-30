/**
 * lib/inboxRealityHistory.ts — turn a dashboard-stats payload into the
 * sending-history block POST /api/v1/predict accepts.
 *
 * This lived inline in `api/inboxReality.ts` behind a raw `Promise.all`, which
 * meant the pre-send banner re-fetched `/api/v1/dashboard/stats` on every
 * debounced content change — a payload the app already holds in the TanStack
 * cache under `["dashboard-stats", tenantId, range]`. Pulling the derivation
 * out into a pure module is what lets the caller feed it from the cache
 * instead, and lets the arithmetic be tested without React Native.
 *
 * The ratios are GROSS event counts over gross sends, deliberately unchanged
 * from the original: the predictor is calibrated on that definition, and
 * switching it to the unique-recipient contract the dashboard tiles use would
 * silently move every prediction. (The two answer different questions —
 * "how much engagement did this volume generate" vs "what share of people
 * opened" — and only the first is a reputation signal.)
 */

/** `history` block of the predict request. Field names are the server's. */
export interface InboxRealityHistory {
  OpenRate?: number;
  ClickRate?: number;
  ComplaintRate?: number;
  BounceRate?: number;
  SendVolume?: number;
}

/** Counts the ratios are derived from. All optional: older payloads omit them. */
export interface InboxRealityHistorySource {
  opens_total_30d?: number | undefined;
  clicks_total_30d?: number | undefined;
  bounces_total_30d?: number | undefined;
  emails_sent_30d?: number | undefined;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Null when there is no send volume to divide by. That is not a degenerate
 * case to paper over with zeros: a workspace that has never sent has no
 * reputation history, and telling the predictor "0% open rate" would make it
 * forecast spam placement for every first-time sender.
 */
export function inboxRealityHistoryFromStats(
  stats: InboxRealityHistorySource | null | undefined,
): InboxRealityHistory | null {
  const sent = finiteNonNegative(stats?.emails_sent_30d);
  if (sent === null || sent <= 0) return null;

  const opens = finiteNonNegative(stats?.opens_total_30d);
  const clicks = finiteNonNegative(stats?.clicks_total_30d);
  const bounces = finiteNonNegative(stats?.bounces_total_30d);

  return {
    ...(opens !== null ? { OpenRate: Math.min(1, opens / sent) } : {}),
    ...(clicks !== null ? { ClickRate: Math.min(1, clicks / sent) } : {}),
    ...(bounces !== null ? { BounceRate: Math.min(1, bounces / sent) } : {}),
    SendVolume: sent,
  };
}
