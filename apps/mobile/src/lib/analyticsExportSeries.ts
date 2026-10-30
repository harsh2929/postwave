/**
 * analyticsExportSeries — turning what the Analytics screen HOLDS into
 * exportable rows (DASHBOARD#40).
 *
 * Separate from `analyticsExport` on purpose: that module owns the CSV rules
 * (quoting, formula neutralisation, the cap, absence-as-empty-cell), this one
 * owns the mapping from each section's parsed shape to columns. Both are
 * import-free so both are testable in the node vitest run (house rule 6).
 *
 * THE SELECTION RULE. Only sections whose rows are a TABLE are exported —
 * audience growth, the template leaderboard, revenue by campaign, the RFM
 * bands. The single-figure cards (customer value, model coverage) are
 * deliberately absent: a one-row "median = 42" line in a spreadsheet invites
 * exactly the arithmetic the card's own caption spends three sentences
 * refusing (no currency is established for that figure). A number that needs a
 * paragraph of caveats does not survive being pasted into Sheets.
 *
 * EVERY SECTION THAT IS ASKED FOR AND CANNOT ANSWER IS NAMED. A section that
 * errored and a section that is genuinely empty are both reported as
 * "not included", because from the reader's side they are the same risk: an
 * absent section read as a zero.
 */

export interface ExportSeries {
  section: string;
  columns: readonly string[];
  rows: readonly (readonly (string | number | null)[])[];
}

/** Minimal row shapes — structural, so nothing here imports a hook module. */
export interface GrowthPointLike {
  date: string;
  count: number;
}

export interface LeaderboardRowLike {
  name: string;
  campaignsUsed: number;
  sent: number;
  opens: number;
  clicks: number;
  openRate: number | null;
  clickRate: number | null;
}

export interface RevenueRowLike {
  name: string;
  conversions: number;
  revenueCents: number;
  emailsSent: number;
  revenuePerSendCents: number | null;
}

export interface BandRowLike {
  label: string;
  profiles: number;
  share: number;
}

export interface AnalyticsExportSource {
  growth: { rows: readonly GrowthPointLike[]; failed: boolean };
  leaderboard: { rows: readonly LeaderboardRowLike[]; failed: boolean };
  revenue: {
    rows: readonly RevenueRowLike[];
    /** Dominant currency, or null when the window holds no monetary rows. */
    currency: string | null;
    failed: boolean;
  };
  bands: { rows: readonly BandRowLike[]; failed: boolean };
}

export interface AnalyticsExportPlan {
  series: readonly ExportSeries[];
  unavailable: readonly string[];
}

const GROWTH = "Audience growth";
const LEADERBOARD = "Top templates";
const REVENUE = "Revenue by campaign";
const BANDS = "Customer bands";

export function buildAnalyticsExportPlan(
  source: AnalyticsExportSource,
): AnalyticsExportPlan {
  const series: ExportSeries[] = [];
  const unavailable: string[] = [];

  const add = (
    section: string,
    failed: boolean,
    columns: readonly string[],
    rows: readonly (readonly (string | number | null)[])[],
  ) => {
    // A failed section is never exported as an empty one: it is NAMED, so the
    // reader cannot mistake missing rows for measured zeroes.
    if (failed || rows.length === 0) {
      unavailable.push(section);
      return;
    }
    series.push({ section, columns, rows });
  };

  add(
    GROWTH,
    source.growth.failed,
    ["date", "subscribers"],
    source.growth.rows.map((point) => [point.date, point.count]),
  );

  add(
    LEADERBOARD,
    source.leaderboard.failed,
    ["template", "campaigns", "sent", "opens", "clicks", "open_rate", "click_rate"],
    source.leaderboard.rows.map((row) => [
      row.name,
      row.campaignsUsed,
      row.sent,
      row.opens,
      row.clicks,
      // A rate the server did not report is an empty cell. Writing 0 would
      // make a spreadsheet average say the campaign was never opened.
      row.openRate,
      row.clickRate,
    ]),
  );

  add(
    REVENUE,
    source.revenue.failed,
    [
      "campaign",
      "conversions",
      // The currency is in the COLUMN NAME, not beside each figure: the
      // attribution payload reports one dominant currency for the whole
      // window, and repeating it per row would imply it was established per
      // row. `revenue` alone when the server named no currency at all.
      source.revenue.currency
        ? `revenue_${source.revenue.currency.toLowerCase()}`
        : "revenue",
      "emails_sent",
      "revenue_per_send",
    ],
    source.revenue.rows.map((row) => [
      row.name,
      row.conversions,
      centsToMajor(row.revenueCents),
      row.emailsSent,
      row.revenuePerSendCents === null
        ? null
        : centsToMajor(row.revenuePerSendCents),
    ]),
  );

  add(
    BANDS,
    source.bands.failed,
    ["band", "profiles", "share_pct"],
    source.bands.rows.map((row) => [
      row.label,
      row.profiles,
      Math.round(row.share * 1000) / 10,
    ]),
  );

  return { series, unavailable };
}

/** Cents → major units, two decimals, as a NUMBER a spreadsheet can sum. */
function centsToMajor(cents: number): number | null {
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents) / 100;
}
