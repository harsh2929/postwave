/**
 * cross-channel-helpers — pure logic for the cross-channel activity
 * timeline (R3: GET /subscribers/{id}/cross-channel-timeline).
 *
 * The endpoint merges email + SMS events server-side and pages by
 * keyset: each response carries `has_more` plus `next_before` (an
 * RFC3339Nano cursor to feed back as `before`). These helpers keep the
 * append/dedupe/badge logic out of the component so it's testable
 * without a DOM.
 */

import type { CrossChannelTimelineItem } from "../../lib/api-client";

/** Stable identity for one timeline item. The wire has no id; the
 * tuple (at, channel, type, label) is the closest honest key. */
export function timelineItemKey(it: CrossChannelTimelineItem): string {
  return `${it.at}::${it.channel}::${it.type}::${it.label}`;
}

/**
 * Append a keyset page onto the already-loaded items, dropping
 * duplicates. The server cursor is strict-less-than so overlap should
 * not happen, but ties at the same nanosecond are conceivable — be
 * defensive rather than render doubled rows.
 */
export function appendTimelinePage(
  existing: CrossChannelTimelineItem[],
  fresh: CrossChannelTimelineItem[],
): CrossChannelTimelineItem[] {
  if (fresh.length === 0) return existing;
  const seen = new Set(existing.map(timelineItemKey));
  const added = fresh.filter((it) => !seen.has(timelineItemKey(it)));
  return added.length > 0 ? [...existing, ...added] : existing;
}

export interface ChannelBadge {
  label: string;
  /** Design-token color var for the badge accent. */
  color: string;
}

/**
 * Channel → badge mapping. The wire promises "email" | "sms"; anything
 * else is rendered verbatim (uppercased) rather than coerced — if the
 * backend grows a channel we show it instead of mislabelling it.
 */
export function channelBadge(channel: string): ChannelBadge {
  const c = channel.toLowerCase();
  if (c === "email") return { label: "Email", color: "var(--pw-accent)" };
  if (c === "sms") return { label: "SMS", color: "var(--pw-success)" };
  return { label: channel.toUpperCase() || "?", color: "var(--pw-fg-muted)" };
}

/** One-line summary for an item: label, falling back to the raw type
 * when the server sent an empty label. */
export function timelineItemText(it: CrossChannelTimelineItem): string {
  return it.label || it.type || "(event)";
}
