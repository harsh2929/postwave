export interface SubscriberCurrencyRevenue {
  currency: string;
  conversions: number;
  revenue_cents: number;
  revenue_cents_saturated: boolean;
}

export interface SubscriberEngagementResult {
  subscriber_id: string;
  email: string;
  score: number;
  counts: {
    sends: number;
    opens: number;
    clicks: number;
    replies: number;
    /** Dominant valid-currency total. Never a cross-currency sum. */
    revenue_cents?: number;
    revenue_cents_saturated?: boolean;
    revenue_currency?: string;
    revenue_by_currency?: SubscriberCurrencyRevenue[];
    mixed_currency?: boolean;
    unclassified_monetary_conversions?: number;
  };
  window_days: number;
  computed_at: string;
  opens_30d?: number;
  clicks_30d?: number;
  last_open_at?: string | null;
  last_click_at?: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return finiteInteger(value) && value >= 0;
}

function isoCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function validOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || validTimestamp(value);
}

function validCurrencyRevenue(value: unknown): value is SubscriberCurrencyRevenue {
  const item = record(value);
  return Boolean(
    item &&
      isoCurrency(item.currency) &&
      finiteInteger(item.conversions) &&
      item.conversions > 0 &&
      finiteInteger(item.revenue_cents) &&
      typeof item.revenue_cents_saturated === "boolean",
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Runtime boundary for the contact-performance response. It accepts the
 * legacy counts-only money shape, but when any currency-aware field appears
 * it requires the complete, internally consistent contract.
 */
export function isSubscriberEngagementResult(
  value: unknown,
): value is SubscriberEngagementResult {
  const result = record(value);
  const counts = record(result?.counts);
  if (
    !result ||
    !counts ||
    typeof result.subscriber_id !== "string" ||
    result.subscriber_id.trim().length === 0 ||
    typeof result.email !== "string" ||
    result.email.length === 0 ||
    result.email.length > 320 ||
    !finiteInteger(result.score) ||
    result.score < 0 ||
    result.score > 100 ||
    !nonNegativeInteger(counts.sends) ||
    !nonNegativeInteger(counts.opens) ||
    !nonNegativeInteger(counts.clicks) ||
    !nonNegativeInteger(counts.replies) ||
    !finiteInteger(result.window_days) ||
    result.window_days < 1 ||
    result.window_days > 3660 ||
    !validTimestamp(result.computed_at) ||
    (result.opens_30d !== undefined &&
      !nonNegativeInteger(result.opens_30d)) ||
    (result.clicks_30d !== undefined &&
      !nonNegativeInteger(result.clicks_30d)) ||
    !validOptionalTimestamp(result.last_open_at) ||
    !validOptionalTimestamp(result.last_click_at)
  ) {
    return false;
  }

  const currencyKeys = [
    "revenue_cents_saturated",
    "revenue_currency",
    "revenue_by_currency",
    "mixed_currency",
    "unclassified_monetary_conversions",
  ];
  const hasCurrencyContract = currencyKeys.some((key) => hasOwn(counts, key));
  if (!hasCurrencyContract) {
    return (
      counts.revenue_cents === undefined || finiteInteger(counts.revenue_cents)
    );
  }

  if (
    !finiteInteger(counts.revenue_cents) ||
    typeof counts.revenue_cents_saturated !== "boolean" ||
    !Array.isArray(counts.revenue_by_currency) ||
    counts.revenue_by_currency.length > 512 ||
    typeof counts.mixed_currency !== "boolean" ||
    !nonNegativeInteger(counts.unclassified_monetary_conversions) ||
    !counts.revenue_by_currency.every(validCurrencyRevenue)
  ) {
    return false;
  }

  const breakdown = counts.revenue_by_currency;
  const currencies = breakdown.map((item) => item.currency);
  if (
    new Set(currencies).size !== currencies.length ||
    counts.mixed_currency !== (breakdown.length > 1)
  ) {
    return false;
  }
  if (breakdown.length === 0) {
    return counts.revenue_currency === undefined && counts.revenue_cents === 0;
  }
  return (
    isoCurrency(counts.revenue_currency) &&
    counts.revenue_currency === breakdown[0]?.currency &&
    counts.revenue_cents === breakdown[0]?.revenue_cents &&
    counts.revenue_cents_saturated ===
      breakdown[0]?.revenue_cents_saturated
  );
}
