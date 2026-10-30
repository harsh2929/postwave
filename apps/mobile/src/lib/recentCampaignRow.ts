/**
 * lib/recentCampaignRow.ts — what a dashboard "Recent campaigns" row is
 * allowed to claim about a campaign's performance.
 *
 * The row used to render a title, a status pill and a date. The API was
 * already sending the rest: `GET /api/v1/campaigns` attaches `open_rate` and
 * `click_rate` to EVERY list row as 0..1 fractions
 * (apps/api/internal/campaigns/types.go, populated by `attachListRates`), and
 * they are POINTERS on the Go side — so a campaign that has never been sent
 * serialises them ABSENT rather than as 0. That distinction is the whole
 * reason this module exists:
 *
 *  - A DRAFT HAS NO RATE, AND SAYING "0.0%" ABOUT IT IS A LIE. Drafts and
 *    scheduled campaigns get no metrics fragment at all — there is nothing to
 *    report yet, and an em-dash beside a draft is noise, not disclosure.
 *  - A SENT CAMPAIGN WITH NO RATE IS A DISCLOSURE. Once a campaign has gone
 *    out, a missing rate means the server did not report one, and that is
 *    worth an em-dash: the reader would otherwise assume nobody opened it.
 *
 * Pure and free of react-native imports so the branching above is testable in
 * the node environment; the row component only lays the strings out.
 */
import { EMDASH, dateTime, date as formatDate, percent } from "@/lib/format";

/**
 * Only these statuses have had a chance to earn an engagement rate. `running`
 * and `finished` are the Listmonk engine's words for "sending" and "sent" and
 * reach the wire through the same column, so omitting them would silently drop
 * the metrics off exactly the campaigns that have them.
 */
const DELIVERED_STATUSES = new Set([
  "sent",
  "sending",
  "running",
  "finished",
  "paused",
]);

export interface RecentCampaignRowInput {
  /** RAW backend status — the delivery decision is made on the wire value. */
  status?: string | undefined;
  /**
   * Human status for the spoken label ("Sent" rather than `finished`). The
   * display label must never drive the delivery decision: `campaignStatusLabel`
   * folds `running`/`finished` into "Sent", which is right for a reader and
   * wrong as a lifecycle test.
   */
  statusLabel?: string | undefined;
  /** `sent_at ?? created_at` — whichever the row is dated by. */
  when?: string | null | undefined;
  /** 0..1 fraction, or absent when the server reported none. */
  openRate?: number | null | undefined;
  clickRate?: number | null | undefined;
}

export interface RecentCampaignRowSummary {
  /** Visible secondary line: date, plus rates when they mean something. */
  detail: string;
  /** Spoken form of just the metrics half, "" when the row carries none. */
  spokenMetrics: string;
}

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** True once a campaign has been sent (or is sending), so rates are expected. */
export function hasDeliveredStatus(status: string | undefined): boolean {
  return DELIVERED_STATUSES.has((status ?? "").trim().toLowerCase());
}

/**
 * Build the row's secondary line and the metrics half of its spoken label.
 *
 * The visible line is compact because the row is 5 of a scrollable card; the
 * spoken half spells out the nouns, because "24.3%, 3.1%" read aloud is two
 * numbers with no referent.
 */
export function recentCampaignRowSummary({
  status,
  when,
  openRate,
  clickRate,
}: RecentCampaignRowInput): RecentCampaignRowSummary {
  const delivered = hasDeliveredStatus(status);
  const open = rate(openRate);
  const click = rate(clickRate);

  // Nothing has been mailed yet: a rate is not missing, it does not exist.
  if (!delivered && open === null && click === null) {
    return { detail: formatDate(when), spokenMetrics: "" };
  }

  const visible = [
    `${open === null ? EMDASH : percent(open)} opened`,
    `${click === null ? EMDASH : percent(click)} clicked`,
  ];
  const spoken = [
    open === null ? "open rate not reported" : `${percent(open)} opened`,
    click === null ? "click rate not reported" : `${percent(click)} clicked`,
  ];

  return {
    detail: [formatDate(when), ...visible].join(" · "),
    spokenMetrics: spoken.join(", "),
  };
}

/** One composed announcement for the whole row. */
export function recentCampaignRowLabel(
  title: string,
  input: RecentCampaignRowInput,
): string {
  const { spokenMetrics } = recentCampaignRowSummary(input);
  return [
    title,
    input.statusLabel || input.status || "draft",
    dateTime(input.when, "no date"),
    ...(spokenMetrics ? [spokenMetrics] : []),
  ].join(", ");
}
