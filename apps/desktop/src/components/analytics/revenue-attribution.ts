/**
 * revenue-attribution — pure logic behind RevenueAttributionSection.
 * Lives in a .ts module (not the .tsx component) so the
 * node-environment vitest suite can import it without a JSX
 * transform (same pattern as grouped-series / analytics-nlq).
 *
 * Wire facts this module encodes (verified in ROADMAP-WRAPPERS R4):
 * - Amounts are integer CENTS.
 * - The 51st+ campaigns roll into ONE item with `campaign_id: ""`
 *   and `campaign_name: "(other campaigns)"`; that row (and zero-send
 *   rows) omit `revenue_per_send_cents`.
 * - `currency` is the dominant currency used by the primary total and
 *   campaign rows. `currencies` discloses every other unit; none are
 *   converted or summed into that dominant-currency total.
 */

import type {
  RevenueAttributionItem,
  RevenueCurrencyTotal,
  RevenueTimeseriesPoint,
} from "../../lib/api-client";

/* ---------- money formatting ------------------------------------------ */

/**
 * Format integer cents. With a currency code we use Intl currency
 * formatting; without one (mixed-currency totals) we render a plain
 * number with NO symbol — inventing a "$" for a EUR+USD sum would be
 * dishonest.
 */
export function fmtMoneyCents(
  cents: number | null | undefined,
  currency?: string,
  locale?: string,
): string {
  // Guard against a missing/NaN wire field — never format NaN.
  const safeCents =
    typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  const major = safeCents / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: safeCents % 100 === 0 ? 0 : 2,
      }).format(major);
    } catch {
      // Unknown ISO code from the wire — fall through to plain number.
    }
  }
  return major.toLocaleString(locale, {
    maximumFractionDigits: safeCents % 100 === 0 ? 0 : 2,
  });
}

/* ---------- rows -------------------------------------------------------- */

/** The "(other campaigns)" rollup row is keyed by an empty id. */
export function isRollupRow(
  item: Pick<RevenueAttributionItem, "campaign_id">,
): boolean {
  return item.campaign_id === "";
}

/** Revenue-per-send cell; the field is absent on the rollup and on
 *  zero-send rows — render an explicit "—" rather than computing a
 *  client-side division the backend refused to make. */
export function revenuePerSendText(
  item: Pick<RevenueAttributionItem, "revenue_per_send_cents">,
  currency?: string,
  locale?: string,
): string {
  if (item.revenue_per_send_cents == null) return "—";
  return fmtMoneyCents(item.revenue_per_send_cents, currency, locale);
}

/* ---------- currency disclosure ----------------------------------------- */

export interface CurrencyDisclosure {
  /** True when totals span more than one currency. */
  mixed: boolean;
  /** Operator-facing line; null when there's nothing to disclose
   *  (no conversions at all). */
  label: string | null;
}

/**
 * Build the per-manifest currency disclosure: the dominant currency
 * when there is one, the full breakdown when totals are mixed.
 */
export function currencyDisclosure(
  resp: { currency?: string; currencies: RevenueCurrencyTotal[] },
  locale?: string,
): CurrencyDisclosure {
  const currencies = resp.currencies ?? [];
  if (currencies.length === 0) return { mixed: false, label: null };
  if (currencies.length === 1 || resp.currency) {
    const code = resp.currency || currencies[0]?.currency || "";
    return {
      mixed: currencies.length > 1,
      label:
        currencies.length > 1
          ? `Primary net total and campaign rows use ${code}. ${mixedLabel(currencies, locale)}`
          : `All amounts in ${code}.`,
    };
  }
  return { mixed: true, label: mixedLabel(currencies, locale) };
}

function mixedLabel(
  currencies: RevenueCurrencyTotal[],
  locale?: string,
): string {
  const parts = currencies
    .map(
      (c) =>
        `${c.currency} ${fmtMoneyCents(c.revenue_cents, c.currency, locale)} (${c.conversions} conv.)`,
    )
    .join(" · ");
  return `${currencies.length} currencies were recorded — ${parts}. Amounts are not converted or summed across currencies.`;
}

/* ---------- timeseries --------------------------------------------------- */

/**
 * Map the zero-filled daily revenue points onto LineChart's
 * `{date, count}` shape, in MAJOR units (cents/100) so the y-axis and
 * tooltip read as money, not cent counts.
 */
export function revenueTimeseriesPoints(
  points: RevenueTimeseriesPoint[] | null | undefined,
): Array<{ date: string; count: number }> {
  if (!Array.isArray(points)) return [];
  return points.map((p) => ({
    date: p.date,
    // Round to whole cents' worth of major units to avoid float dust.
    count: Math.round(p.revenue_cents ?? 0) / 100,
  }));
}

/** Total across the window — drives the honest empty state. */
export function revenueTimeseriesTotalCents(
  points: RevenueTimeseriesPoint[] | null | undefined,
): number {
  if (!Array.isArray(points)) return 0;
  let total = 0;
  for (const p of points) total += p.revenue_cents ?? 0;
  return total;
}

/** True when the window contains monetary movement, including refunds or
 * offsetting positive/negative days whose net is zero. */
export function revenueTimeseriesHasActivity(
  points: RevenueTimeseriesPoint[] | null | undefined,
): boolean {
  return (
    Array.isArray(points) &&
    points.some(
      (point) =>
        (Number.isFinite(point.revenue_cents) && point.revenue_cents !== 0) ||
        (Number.isFinite(point.conversions) && point.conversions > 0),
    )
  );
}

/** X-tick stride matching the Analytics page's per-range density. */
export function revenueTickStride(days: number): number {
  if (days <= 7) return 1;
  if (days <= 30) return 5;
  return 15;
}

/* ---------- campaign filter ----------------------------------------------- */

/**
 * Options for the timeseries campaign filter. Built from the
 * attribution response itself (NOT the page's campaign list) because
 * the endpoint requires a UUID `campaign_id` — attribution rows are
 * guaranteed to carry exactly the ids the timeseries endpoint
 * accepts, while the page's campaign list may use numeric engine ids.
 * The rollup row (empty id) is excluded: it isn't filterable.
 */
export function campaignFilterOptions(
  items: RevenueAttributionItem[] | null | undefined,
): Array<{ id: string; name: string }> {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => !isRollupRow(i))
    .map((i) => ({ id: i.campaign_id, name: i.campaign_name }));
}
