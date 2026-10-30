/**
 * lib/campaignCompare.ts — two or three campaigns, side by side.
 *
 * Desktop's CampaignCompareCard compares N campaigns in a wide table. On a
 * phone N-way is unreadable, so this is deliberately a 2–3 column reading of
 * the SAME endpoint: `GET /api/v1/analytics/campaigns/compare?ids=a,b`
 * (analytics/handlers.go:353, scope read:reports, hard cap 25 ids).
 *
 * THE ONE THING THIS MODULE EXISTS TO GET RIGHT. The server does NOT omit a
 * campaign it has no events for — `Service.Compare` fills the gap with
 * `CompareRow{CampaignID: id}` (service.go:627), a struct whose every numeric
 * field is the Go zero value. On the wire that is indistinguishable from a
 * campaign that reached 40,000 people and was opened by none of them, and a
 * comparison screen is exactly where that confusion is most expensive: the
 * operator is about to decide which of two subject lines won.
 *
 * `total_recipients === 0` is therefore treated as NO MEASUREMENT — every
 * rate becomes null, renders as an em-dash, and is excluded from the "better"
 * comparison rather than winning it with a zero.
 *
 * Every rate on this endpoint is a 0..1 FRACTION (`float64(opens) / d`,
 * service.go:608-613) — unlike the per-campaign report, which is already
 * scaled. See the scale map in lib/campaignFormat.
 *
 * Pure and import-free: node-testable.
 */

export interface CampaignCompareRow {
  campaignId: string;
  /** Null when the server reported no recipients, i.e. no data at all. */
  totalRecipients: number | null;
  /** 0..1 fractions, or null when unmeasured. Never 0-for-missing. */
  openRate: number | null;
  clickRate: number | null;
  bounceRate: number | null;
  complaintRate: number | null;
  unsubRate: number | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Wire rows → mobile rows, with the zero-fill trap defused. */
export function parseCompareRows(raw: unknown): CampaignCompareRow[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items ?? [])
      : [];
  const out: CampaignCompareRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.campaign_id === "string" ? row.campaign_id : "";
    if (!id) continue;
    const recipients = finiteOrNull(row.total_recipients);
    // The zero-fill guard. No recipients means the query matched no send
    // events for this campaign, not a send that nobody opened.
    const measured = recipients !== null && recipients > 0;
    out.push({
      campaignId: id,
      totalRecipients: measured ? recipients : null,
      openRate: measured ? finiteOrNull(row.open_rate) : null,
      clickRate: measured ? finiteOrNull(row.click_rate) : null,
      bounceRate: measured ? finiteOrNull(row.bounce_rate) : null,
      complaintRate: measured ? finiteOrNull(row.complaint_rate) : null,
      unsubRate: measured ? finiteOrNull(row.unsub_rate) : null,
    });
  }
  return out;
}

export type CompareMetricKey =
  | "openRate"
  | "clickRate"
  | "bounceRate"
  | "complaintRate"
  | "unsubRate";

export interface CompareMetric {
  key: CompareMetricKey;
  label: string;
  /** True when a HIGHER number is the better outcome. */
  higherIsBetter: boolean;
  /** Spoken qualifier so the winner is never conveyed by colour alone. */
  betterWord: string;
}

export const COMPARE_METRICS: CompareMetric[] = [
  { key: "openRate", label: "Open rate", higherIsBetter: true, betterWord: "higher" },
  { key: "clickRate", label: "Click rate", higherIsBetter: true, betterWord: "higher" },
  { key: "bounceRate", label: "Bounce rate", higherIsBetter: false, betterWord: "lower" },
  {
    key: "complaintRate",
    label: "Complaint rate",
    higherIsBetter: false,
    betterWord: "lower",
  },
  { key: "unsubRate", label: "Unsubscribe rate", higherIsBetter: false, betterWord: "lower" },
];

/**
 * Which campaign leads on a metric, or null when nothing can be said.
 *
 * Returns null on a tie AND when fewer than two campaigns have a measurement,
 * because "this one won" is a claim, and a claim built on one measured column
 * plus one em-dash is a false one.
 */
export function compareLeader(
  rows: readonly CampaignCompareRow[],
  metric: CompareMetric,
): string | null {
  const measured = rows.filter((r) => r[metric.key] !== null);
  if (measured.length < 2) return null;
  let best: CampaignCompareRow | null = null;
  let tied = false;
  for (const row of measured) {
    const value = row[metric.key] as number;
    if (!best) {
      best = row;
      continue;
    }
    const bestValue = best[metric.key] as number;
    if (value === bestValue) {
      tied = true;
      continue;
    }
    const wins = metric.higherIsBetter ? value > bestValue : value < bestValue;
    if (wins) {
      best = row;
      tied = false;
    }
  }
  if (!best || tied) return null;
  return best.campaignId;
}

/**
 * A one-line reading of the comparison, for the sheet header and for
 * VoiceOver. Deliberately refuses to declare a winner when the two campaigns
 * disagree about which one led — "A opened better, B was clicked more" is the
 * honest summary of a genuinely mixed result.
 */
export function compareHeadline(
  rows: readonly CampaignCompareRow[],
  nameFor: (campaignId: string) => string,
): string {
  if (rows.length < 2) return "Select two campaigns to compare them.";
  const unmeasured = rows.filter((r) => r.totalRecipients === null);
  if (unmeasured.length === rows.length) {
    return "Neither campaign has any recorded delivery yet, so there is nothing to compare.";
  }
  if (unmeasured.length > 0) {
    const names = unmeasured.map((r) => nameFor(r.campaignId)).join(", ");
    return `${names} has no recorded delivery yet, so only the others carry measurements.`;
  }
  const openLeader = compareLeader(rows, COMPARE_METRICS[0] as CompareMetric);
  const clickLeader = compareLeader(rows, COMPARE_METRICS[1] as CompareMetric);
  if (openLeader && clickLeader && openLeader === clickLeader) {
    return `${nameFor(openLeader)} led on both open rate and click rate.`;
  }
  if (openLeader && clickLeader) {
    return `${nameFor(openLeader)} opened better; ${nameFor(clickLeader)} was clicked more.`;
  }
  if (openLeader) return `${nameFor(openLeader)} led on open rate.`;
  if (clickLeader) return `${nameFor(clickLeader)} led on click rate.`;
  return "These campaigns performed the same on open and click rate.";
}
