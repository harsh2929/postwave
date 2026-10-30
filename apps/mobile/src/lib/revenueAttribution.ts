/**
 * lib/revenueAttribution.ts — the pure edge in front of
 * `GET /api/v1/conversions/attribution/campaigns`.
 *
 * Revenue is the number a founder most wants on a phone, and it is also the
 * easiest one to overstate. The Go handler
 * (apps/api/internal/conversions/attribution.go) is unusually careful about
 * that, and this module exists so the phone does not throw its care away:
 *
 *  - ATTRIBUTED IS NOT TOTAL. `total_revenue_cents` is ALL revenue in the
 *    window — attributed plus unattributed — and `unattributed_cents` is the
 *    part no campaign can claim. Printing the total beside a campaign list
 *    would credit email with money it never touched, so the attributed figure
 *    is derived (`total − unattributed`) and both halves are reported.
 *  - LAST TOUCH IS A GUESS AND SAYS SO. `provenance` splits every conversion
 *    into explicit (the caller passed a campaign id), last_touch (auto-joined
 *    from a recent click — a heuristic), none, and unclassified (pre-0397 rows
 *    the backfill has not stamped). Folding those four into one number is
 *    exactly the overstatement the server refused to make.
 *  - ONE CURRENCY IS SUMMED, THE REST ARE DISCLOSED. Every `*_cents` field is
 *    denominated in the dominant `currency`; a mixed-currency workspace has
 *    money in `currencies` that is NOT in those sums. `mixedCurrency` exists so
 *    the screen can say so rather than quietly under-reporting.
 *
 * Deliberately import-free, like `chartScale` and `approvalPolicy`: the vitest
 * environment is node, so anything that transitively reaches react-native
 * cannot be tested. Formatting (money, percent) happens at the call site.
 */

/** One campaign's attributed revenue in the window. */
export interface AttributionCampaign {
  id: string;
  name: string;
  /** ALL attributed conversions — every currency, plus non-monetary. */
  conversions: number;
  /** Dominant-currency revenue only. */
  revenueCents: number;
  /** All-time per-recipient send count for the campaign. */
  emailsSent: number;
  /** Null when the server omitted it — there was no honest denominator. */
  revenuePerSendCents: number | null;
}

/** How the window's conversions came to be attributed at all. */
export interface AttributionProvenance {
  explicit: number;
  lastTouch: number;
  none: number;
  codeRedemption: number;
  campaignVanityPath: number;
  unclassified: number;
  /** The six above, summed. Zero means "nothing to apportion". */
  total: number;
}

export interface CurrencyTotal {
  currency: string;
  conversions: number;
  revenueCents: number;
}

export interface RevenueAttribution {
  items: AttributionCampaign[];
  provenance: AttributionProvenance;
  /** Attributed + unattributed, dominant currency. */
  totalRevenueCents: number;
  unattributedCents: number;
  unattributedConversions: number;
  /** Null when the window holds no monetary conversions at all. */
  currency: string | null;
  currencies: CurrencyTotal[];
  /** DISTINCT campaigns with attributed revenue, before the top-N rollup. */
  totalCampaigns: number;
  days: number;
}

const EMPTY_PROVENANCE: AttributionProvenance = {
  explicit: 0,
  lastTouch: 0,
  none: 0,
  codeRedemption: 0,
  campaignVanityPath: 0,
  unclassified: 0,
  total: 0,
};

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** Non-negative finite number, else 0. Counts and money never go backwards. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Total by construction, in the style of `analyticsSeries`: accepts `unknown`,
 * keeps every row it can understand, drops the ones it cannot, never throws.
 * A partial deployment must degrade to a thinner card, not a blank screen.
 */
export function parseRevenueAttribution(raw: unknown): RevenueAttribution {
  const body = record(raw);
  const items: AttributionCampaign[] = [];
  const rawItems = body && Array.isArray(body.items) ? body.items : [];
  for (const row of rawItems) {
    const item = record(row);
    if (!item) continue;
    const id = text(item.campaign_id) ?? text(item.id);
    // A row with no campaign identity cannot be labelled, ranked or opened.
    if (id === null) continue;
    items.push({
      id,
      name: text(item.campaign_name) ?? text(item.name) ?? "Untitled campaign",
      conversions: count(item.conversions),
      revenueCents: count(item.revenue_cents),
      emailsSent: count(item.emails_sent),
      revenuePerSendCents: optionalNumber(item.revenue_per_send_cents),
    });
  }

  const prov = record(body?.provenance);
  const explicit = count(prov?.explicit);
  const lastTouch = count(prov?.last_touch);
  const none = count(prov?.none);
  const codeRedemption = count(prov?.code_redemption);
  const campaignVanityPath = count(prov?.campaign_vanity_path);
  const unclassified = count(prov?.unclassified);

  const currencies: CurrencyTotal[] = [];
  const rawCurrencies =
    body && Array.isArray(body.currencies) ? body.currencies : [];
  for (const row of rawCurrencies) {
    const entry = record(row);
    const code = entry ? text(entry.currency) : null;
    if (!entry || code === null) continue;
    currencies.push({
      currency: code,
      conversions: count(entry.conversions),
      revenueCents: count(entry.revenue_cents),
    });
  }

  return {
    items,
    provenance: prov
      ? {
          explicit,
          lastTouch,
          none,
          codeRedemption,
          campaignVanityPath,
          unclassified,
          total:
            explicit +
            lastTouch +
            none +
            codeRedemption +
            campaignVanityPath +
            unclassified,
        }
      : EMPTY_PROVENANCE,
    totalRevenueCents: count(body?.total_revenue_cents),
    unattributedCents: count(body?.unattributed_cents),
    unattributedConversions: count(body?.unattributed_conversions),
    currency: text(body?.currency),
    currencies,
    totalCampaigns: count(body?.total_campaigns),
    days: count(body?.days),
  };
}

/**
 * Revenue email can claim, in cents of the dominant currency.
 *
 * Floored at zero rather than trusted: the two figures are computed by separate
 * SQL passes, so a race across a window boundary could in principle make
 * `unattributed` exceed `total`, and a negative revenue headline is a bug the
 * reader would have to diagnose rather than a fact.
 */
export function attributedCents(report: RevenueAttribution): number {
  return Math.max(0, report.totalRevenueCents - report.unattributedCents);
}

/** Attributed share of all window revenue, or null when there was none. */
export function attributedShare(report: RevenueAttribution): number | null {
  if (report.totalRevenueCents <= 0) return null;
  return attributedCents(report) / report.totalRevenueCents;
}

export type ProvenanceKey =
  | "explicit"
  | "lastTouch"
  | "none"
  | "codeRedemption"
  | "campaignVanityPath"
  | "unclassified";

export interface ProvenanceRow {
  key: ProvenanceKey;
  label: string;
  count: number;
  /** Share of all conversions in the window, 0..1. */
  share: number;
}

/**
 * The four buckets as display rows, largest first, with empty buckets dropped.
 *
 * The labels are the honest ones: "Tagged by the sender" and "Matched to a
 * recent click" say what happened, where "explicit"/"last_touch" are the
 * server's vocabulary and mean nothing to a reader.
 */
export function provenanceRows(
  provenance: AttributionProvenance,
): ProvenanceRow[] {
  if (provenance.total <= 0) return [];
  const buckets: readonly { key: ProvenanceKey; label: string; count: number }[] =
    [
      {
        key: "explicit",
        label: "Tagged by the sender",
        count: provenance.explicit,
      },
      {
        key: "lastTouch",
        label: "Matched to a recent click",
        count: provenance.lastTouch,
      },
      { key: "none", label: "No campaign link", count: provenance.none },
      {
        key: "codeRedemption",
        label: "Issued-code assignment",
        count: provenance.codeRedemption,
      },
      {
        key: "campaignVanityPath",
        label: "Shared campaign path",
        count: provenance.campaignVanityPath,
      },
      {
        key: "unclassified",
        label: "Not yet classified",
        count: provenance.unclassified,
      },
    ];
  const rows: ProvenanceRow[] = buckets
    .filter((row) => row.count > 0)
    .map((row) => ({ ...row, share: row.count / provenance.total }));
  return rows.sort((a, b) => b.count - a.count);
}

/**
 * Share of conversions attributed by the LAST-TOUCH heuristic rather than by an
 * explicit campaign id. Null when nothing was attributed at all.
 *
 * This is the number the caveat is sized against: a window that is 4%
 * last-touch is a measurement, and one that is 80% last-touch is an estimate.
 */
export function heuristicShare(
  provenance: AttributionProvenance,
): number | null {
  if (provenance.total <= 0) return null;
  return provenance.lastTouch / provenance.total;
}

/**
 * True when money exists outside the dominant currency — i.e. when the summed
 * figures on this card are knowingly incomplete.
 */
export function mixedCurrency(report: RevenueAttribution): boolean {
  return (
    report.currencies.filter((entry) => entry.revenueCents > 0).length > 1
  );
}

/** Currencies excluded from the dominant-currency sums, largest first. */
export function excludedCurrencies(
  report: RevenueAttribution,
): CurrencyTotal[] {
  const dominant = report.currency?.toLowerCase() ?? null;
  return report.currencies
    .filter(
      (entry) =>
        entry.revenueCents > 0 && entry.currency.toLowerCase() !== dominant,
    )
    .sort((a, b) => b.revenueCents - a.revenueCents);
}

/**
 * True when the listed campaigns are a top-N slice of a larger set, so the
 * screen can say "top 6 of 34" instead of implying the list is everything.
 */
export function isTruncated(report: RevenueAttribution): boolean {
  return report.totalCampaigns > report.items.length;
}

/** Cents → major units, for `money()`. Kept here so no caller divides by 100. */
export function centsToMajor(cents: number): number {
  return cents / 100;
}
