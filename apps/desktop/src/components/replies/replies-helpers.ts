/**
 * replies-helpers — pure logic behind RepliesOverviewCard.
 *
 * Mirrors apps/api/internal/reply_analytics:
 *   - /replies/summary → {window_days, total, matched, unmatched,
 *     top_campaigns[{campaign_id, replies}]};
 *   - /replies/timeseries → {points[{date, replies}]};
 *   - /replies/by-campaign/{id} → reply_rate is a FRACTION 0..1
 *     (distinct_replyers / unique_recipients) — render ×100.
 *
 * The honest-empty rule lives here: "no replies tracked yet" is only
 * true when the summary genuinely reports zero — a fetch error must
 * never be dressed up as an empty state.
 *
 * Kept free of React/DOM for the node-env vitest suite.
 */

import type {
  Campaign,
  RepliesSummary,
  ReplyTimeseriesPoint,
} from "../../lib/api-client";
import type { LinePoint } from "../charts/LineChart";

/** Days windows offered by the card; server default is 30. */
export const REPLY_WINDOW_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_REPLY_WINDOW = 30;

/** Timeseries points → LineChart input ({date, count}). */
export function timeseriesToLinePoints(
  points: ReplyTimeseriesPoint[] | null | undefined,
): LinePoint[] {
  return (points ?? []).map((p) => ({ date: p.date, count: p.replies }));
}

/** Bare reply counts for the Sparkline `values` prop. */
export function sparkValues(
  points: ReplyTimeseriesPoint[] | null | undefined,
): number[] {
  return (points ?? []).map((p) => p.replies);
}

/**
 * True only when the loaded summary genuinely shows zero tracked
 * replies. `null` (not yet loaded / failed) is NOT empty — callers
 * must branch on error/loading first.
 */
export function summaryIsEmpty(summary: RepliesSummary | null): boolean {
  return summary != null && summary.total === 0;
}

/**
 * Resolve a campaign id from the replies rollup to a display name via
 * the rows the Campaigns page already holds. Falls back to a shortened
 * id (the rollup can reference campaigns beyond the page's 100-row
 * cap, or deleted ones) — never a fake name.
 */
export function campaignDisplayName(
  campaigns: Campaign[] | null | undefined,
  campaignId: string,
): string {
  const match = (campaigns ?? []).find((c) => String(c.id) === campaignId);
  if (match) return match.name ?? match.subject ?? shortId(campaignId);
  return shortId(campaignId);
}

/** First 8 chars of a uuid + ellipsis; short ids pass through. */
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Fraction 0..1 → "12.3%"; non-finite → em dash. */
export function fmtReplyRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export interface TopCampaignRow {
  campaignId: string;
  name: string;
  replies: number;
  /** Share of the summary total, 0..1 (0 when total is 0). */
  share: number;
}

/**
 * Summary top_campaigns → display rows sorted by replies desc, with
 * names resolved against the loaded campaign list and each row's
 * share of the total for the inline bar.
 */
export function buildTopCampaignRows(
  summary: RepliesSummary | null,
  campaigns: Campaign[] | null | undefined,
): TopCampaignRow[] {
  if (!summary) return [];
  const total = summary.total;
  return [...(summary.top_campaigns ?? [])]
    .sort((a, b) => b.replies - a.replies)
    .map((tc) => ({
      campaignId: tc.campaign_id,
      name: campaignDisplayName(campaigns, tc.campaign_id),
      replies: tc.replies,
      share: total > 0 ? tc.replies / total : 0,
    }));
}
