/**
 * lib/conversionAttribution.ts — parsing the conversion-attribution surface,
 * and refusing to overstate what it measured.
 *
 * WHAT THIS SURFACE ANSWERS. `apps/desktop/src/components/track/
 * ConversionsSection.tsx` is a tracking console: a cursor-paged raw conversion
 * feed, plus creating and revoking the public site keys that JavaScript ships.
 * Key management is credential authoring and stays on the desk. The raw feed
 * carries `subscriber_email` on every row and is a PII stream — a phone is the
 * wrong screen for it and this app deliberately never requests it. What ports
 * is the money question: *did revenue land, and which campaign earned it*.
 *
 * THE SHAPES, READ OFF THE GO SOURCE (not off openapi.json):
 *   - `CampaignAttributionResponse` apps/api/internal/conversions/attribution.go:147-173
 *   - `TimeseriesResponse`          attribution.go:182-189
 *   - `AttributionProvenance`       attribution.go:133-146
 *   - the queries that produce them attribution.go:498-696
 *
 * SIX SERVER FACTS THAT DECIDE HOW THIS SCREEN READS NUMBERS.
 *
 *  1. REVENUE AND CONVERSIONS HAVE DIFFERENT DENOMINATORS. `revenue_cents` is
 *     `sum(amount_cents) FILTER (WHERE currency = dominant)` while `conversions`
 *     is a plain `count(*)` (attribution.go:518-530). The count therefore
 *     includes other currencies AND non-monetary conversions. Dividing one by
 *     the other would produce an average order value the server never
 *     computed and cannot support, so this module never does.
 *  2. THE CURRENCY LIST IS THE DISCLOSURE. `currencies` comes from
 *     `currencyTotals`, which is `WHERE amount_cents IS NOT NULL`
 *     (attribution.go:293-297) — monetary rows only. Every currency in it that
 *     is not the dominant one is money EXCLUDED from every `*_cents` figure on
 *     the payload, and a screen that shows the revenue without naming the
 *     exclusion is under-reporting by an amount only the server knows.
 *  3. LAST TOUCH IS A HEURISTIC WITH A 7-DAY WINDOW. `attributed_via` is one of
 *     explicit / last_touch / none / NULL, and last_touch means "auto-joined to
 *     the subscriber's most recent click within `lastTouchAttributionWindow`"
 *     — 7 days (attribution.go:62-72). It is a guess and the type's own comment
 *     says clients must never present it as certain.
 *  4. `unclassified` IS NOT `none`. NULL `attributed_via` means a pre-migration
 *     row the backfill has not stamped yet (attribution.go:141-145). Folding it
 *     into either bucket overstates confidence in one direction or the other.
 *  5. THE ITEM LIST IS ROLLED UP AT 50. `rollupTopCampaigns`
 *     (attribution.go:240-253) keeps the top 50 by revenue and folds the rest
 *     into one row named "(other campaigns)" with an EMPTY campaign_id. That
 *     row is an aggregate, not a campaign, and `total_campaigns` is captured
 *     BEFORE the roll-up so the UI can say "top 50 of M" honestly.
 *  6. `revenue_per_send_cents` IS OMITTED, NOT ZEROED, when the campaign has no
 *     recorded sends (attribution.go:257-263) — an honest "no denominator".
 *     Rendering it as 0 would claim a campaign earned nothing per send when
 *     what actually happened is that nobody counted its sends.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** The windows the monitor offers. The server accepts 1..365 (parseDays). */
export type AttributionWindow = 7 | 30 | 90;

export const ATTRIBUTION_WINDOWS: readonly AttributionWindow[] = [7, 30, 90];

/**
 * The same windows as strings.
 *
 * `SegmentedControl<T extends string>` cannot carry a numeric union, and
 * stringifying at the call site would put an unchecked `Number()` between the
 * control and the query. Two total functions with a shared source of truth
 * cost less than one cast that can silently produce NaN days.
 */
export type AttributionWindowKey = "7" | "30" | "90";

export function attributionWindowKey(days: AttributionWindow): AttributionWindowKey {
  return String(days) as AttributionWindowKey;
}

export function attributionWindowFromKey(
  key: AttributionWindowKey,
): AttributionWindow {
  if (key === "7") return 7;
  if (key === "90") return 90;
  return 30;
}

/** The server's name for the folded tail row. Matched, never re-spelled. */
export const ROLLUP_CAMPAIGN_NAME = "(other campaigns)";

export interface AttributionItem {
  /** "" for the rolled-up tail row and for a conversion whose campaign is gone. */
  campaignId: string;
  campaignName: string;
  /** ALL attributed conversions — every currency, monetary or not. */
  conversions: number;
  /** Dominant currency only. See fact 1. */
  revenueCents: number;
  emailsSent: number;
  /** null when the campaign has no recorded sends — never 0. */
  revenuePerSendCents: number | null;
  /** This row is the server's folded tail, not a campaign. */
  isRollup: boolean;
}

export interface CurrencyTotal {
  /** "" when the conversion carried an amount but no currency code. */
  currency: string;
  conversions: number;
  revenueCents: number;
}

export interface AttributionProvenance {
  explicit: number;
  lastTouch: number;
  none: number;
  codeRedemption: number;
  campaignVanityPath: number;
  unclassified: number;
  /** Every conversion in the window — the honest denominator for the shares. */
  total: number;
}

export interface CampaignAttribution {
  items: readonly AttributionItem[];
  provenance: AttributionProvenance;
  /** ALL revenue in the dominant currency in the window: attributed + not. */
  totalRevenueCents: number;
  unattributedCents: number;
  unattributedConversions: number;
  /** "" when the window holds no monetary conversion at all. */
  currency: string;
  currencies: readonly CurrencyTotal[];
  /** DISTINCT campaigns with attributed conversions, before the roll-up. */
  totalCampaigns: number;
  days: number;
  /** The window contains at least one conversion carrying an amount. */
  hasMonetary: boolean;
}

export interface AttributionPoint {
  /** YYYY-MM-DD, UTC. */
  date: string;
  revenueCents: number;
  /** ALL conversions that day — attributed or not, every currency. */
  conversions: number;
}

export interface AttributionTimeseries {
  points: readonly AttributionPoint[];
  currency: string;
  currencies: readonly CurrencyTotal[];
  days: number;
  campaignId: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function currencyList(value: unknown): CurrencyTotal[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = record(entry);
    return {
      currency: str(row.currency),
      conversions: int(row.conversions),
      revenueCents: int(row.revenue_cents),
    };
  });
}

function normalizeItem(raw: unknown): AttributionItem {
  const row = record(raw);
  const campaignId = str(row.campaign_id);
  const campaignName = str(row.campaign_name);
  const perSend = row.revenue_per_send_cents;
  return {
    campaignId,
    campaignName,
    conversions: int(row.conversions),
    revenueCents: int(row.revenue_cents),
    emailsSent: int(row.emails_sent),
    // Absent (the Go pointer is nil) means "no denominator", NOT zero. Only a
    // real finite number survives.
    revenuePerSendCents:
      typeof perSend === "number" && Number.isFinite(perSend) ? perSend : null,
    isRollup: campaignId === "" && campaignName === ROLLUP_CAMPAIGN_NAME,
  };
}

export function normalizeCampaignAttribution(raw: unknown): CampaignAttribution {
  const row = record(raw);
  const provenance = record(row.provenance);
  const explicit = int(provenance.explicit);
  const lastTouch = int(provenance.last_touch);
  const none = int(provenance.none);
  const codeRedemption = int(provenance.code_redemption);
  const campaignVanityPath = int(provenance.campaign_vanity_path);
  const unclassified = int(provenance.unclassified);
  const currencies = currencyList(row.currencies);
  return {
    items: Array.isArray(row.items) ? row.items.map(normalizeItem) : [],
    provenance: {
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
    },
    totalRevenueCents: int(row.total_revenue_cents),
    unattributedCents: int(row.unattributed_cents),
    unattributedConversions: int(row.unattributed_conversions),
    currency: str(row.currency),
    currencies,
    totalCampaigns: int(row.total_campaigns),
    days: int(row.days),
    hasMonetary: currencies.length > 0,
  };
}

export function normalizeAttributionTimeseries(
  raw: unknown,
): AttributionTimeseries {
  const row = record(raw);
  const points = Array.isArray(row.points) ? row.points : [];
  return {
    points: points
      .map((entry) => {
        const point = record(entry);
        return {
          date: str(point.date),
          revenueCents: int(point.revenue_cents),
          conversions: int(point.conversions),
        };
      })
      .filter((point) => point.date !== ""),
    currency: str(row.currency),
    currencies: currencyList(row.currencies),
    days: int(row.days),
    campaignId: str(row.campaign_id),
  };
}
