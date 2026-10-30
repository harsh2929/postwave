// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subscriber drill-down reads that desktop's slide-over renders and the web
 * detail page did not (desktop parity rows audience-54/55/63/80):
 *
 *   GET /api/v1/subscribers/{id}/engagement            contact performance (90-day
 *                                                      counters + revenue by currency)
 *   GET /api/v1/subscribers/{id}/activity?limit=&before=
 *                                                      raw event log, newest first;
 *                                                      `before` is the last row's `at`
 *   GET /api/v1/subscribers/{id}/send-times            per-channel best send windows
 *                                                      + the channel-agnostic aggregate
 *   GET /api/v1/predictive/profiles/{email}            RFM + predictive profile (404 =
 *                                                      no profile computed yet)
 *
 * Every response is checked against the identity that was asked for, so a
 * cache mix-up or a partial rollout never renders another subscriber's facts.
 * Money is never summed across currencies and never labelled with an assumed
 * currency: the performance parser requires the full currency contract the
 * moment any currency-aware field appears.
 */
import { api, isApiError } from "@/lib/api";

export class SubscriberExtrasContractError extends Error {
  readonly code = "subscriber_extras_contract_error";

  constructor(message: string) {
    super(message);
    this.name = "SubscriberExtrasContractError";
  }
}

export class SubscriberExtrasInputError extends Error {
  readonly code = "subscriber_extras_input_error";

  constructor(message: string) {
    super(message);
    this.name = "SubscriberExtrasInputError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function subscriberSegment(subscriberId: string): string {
  const id = subscriberId.trim();
  if (!UUID_RE.test(id)) {
    throw new SubscriberExtrasInputError("The subscriber id is invalid.");
  }
  return encodeURIComponent(id);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function optionalTimestamp(value: unknown): string | null {
  return isTimestamp(value) ? value : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/* ========================== Contact performance ========================== */

export interface SubscriberCurrencyRevenue {
  currency: string;
  conversions: number;
  revenue_cents: number;
  revenue_cents_saturated: boolean;
}

export interface SubscriberContactPerformance {
  subscriber_id: string;
  score: number;
  counts: {
    sends: number;
    opens: number;
    clicks: number;
    replies: number;
    /**
     * Every validly denominated currency, dominant first. `null` only for a
     * legacy server that predates the currency contract.
     */
    revenue_by_currency: SubscriberCurrencyRevenue[] | null;
    mixed_currency: boolean;
    unclassified_monetary_conversions: number;
    /**
     * True when a legacy server sent an amount with no denomination — the
     * amount is withheld rather than shown in an assumed currency.
     */
    legacy_unlabelled_revenue: boolean;
  };
  window_days: number;
  computed_at: string;
  opens_30d: number | null;
  clicks_30d: number | null;
  last_open_at: string | null;
  last_click_at: string | null;
}

function isIsoCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function isCurrencyRevenue(value: unknown): value is SubscriberCurrencyRevenue {
  return (
    isRecord(value) &&
    isIsoCurrency(value.currency) &&
    isInteger(value.conversions) &&
    value.conversions > 0 &&
    isInteger(value.revenue_cents) &&
    typeof value.revenue_cents_saturated === "boolean"
  );
}

const CURRENCY_KEYS = [
  "revenue_cents_saturated",
  "revenue_currency",
  "revenue_by_currency",
  "mixed_currency",
  "unclassified_monetary_conversions",
] as const;

function performanceContractError(): SubscriberExtrasContractError {
  return new SubscriberExtrasContractError(
    "The contact-performance service returned an invalid response.",
  );
}

/**
 * Runtime boundary for GET /subscribers/{id}/engagement. It accepts the legacy
 * counts-only money shape, but once any currency-aware field is present it
 * requires the complete, internally consistent contract (the dominant
 * currency must be the breakdown's first entry, `mixed_currency` must agree
 * with the breakdown's length, and currencies must be unique).
 */
export function parseSubscriberContactPerformance(
  value: unknown,
  expectedSubscriberId: string,
): SubscriberContactPerformance {
  if (!isRecord(value) || !isRecord(value.counts)) {
    throw performanceContractError();
  }
  const counts = value.counts;
  if (
    typeof value.subscriber_id !== "string" ||
    !value.subscriber_id.trim() ||
    !isInteger(value.score) ||
    value.score < 0 ||
    value.score > 100 ||
    !isNonNegativeInteger(counts.sends) ||
    !isNonNegativeInteger(counts.opens) ||
    !isNonNegativeInteger(counts.clicks) ||
    !isNonNegativeInteger(counts.replies) ||
    !isInteger(value.window_days) ||
    value.window_days < 1 ||
    value.window_days > 3660 ||
    !isTimestamp(value.computed_at) ||
    (value.opens_30d != null && !isNonNegativeInteger(value.opens_30d)) ||
    (value.clicks_30d != null && !isNonNegativeInteger(value.clicks_30d)) ||
    (value.last_open_at != null && !isTimestamp(value.last_open_at)) ||
    (value.last_click_at != null && !isTimestamp(value.last_click_at))
  ) {
    throw performanceContractError();
  }
  if (!sameId(value.subscriber_id, expectedSubscriberId)) {
    throw new SubscriberExtrasContractError(
      "The contact-performance service answered for a different subscriber.",
    );
  }

  const base = {
    subscriber_id: value.subscriber_id,
    score: value.score,
    window_days: value.window_days,
    computed_at: value.computed_at,
    opens_30d: isNonNegativeInteger(value.opens_30d) ? value.opens_30d : null,
    clicks_30d: isNonNegativeInteger(value.clicks_30d)
      ? value.clicks_30d
      : null,
    last_open_at: optionalTimestamp(value.last_open_at),
    last_click_at: optionalTimestamp(value.last_click_at),
  };
  const counters = {
    sends: counts.sends,
    opens: counts.opens,
    clicks: counts.clicks,
    replies: counts.replies,
  };

  const hasCurrencyContract = CURRENCY_KEYS.some((key) => hasOwn(counts, key));
  if (!hasCurrencyContract) {
    if (counts.revenue_cents !== undefined && !isInteger(counts.revenue_cents)) {
      throw performanceContractError();
    }
    return {
      ...base,
      counts: {
        ...counters,
        revenue_by_currency: null,
        mixed_currency: false,
        unclassified_monetary_conversions: 0,
        legacy_unlabelled_revenue:
          isInteger(counts.revenue_cents) && counts.revenue_cents !== 0,
      },
    };
  }

  const breakdown = counts.revenue_by_currency;
  if (
    !isInteger(counts.revenue_cents) ||
    typeof counts.revenue_cents_saturated !== "boolean" ||
    !Array.isArray(breakdown) ||
    breakdown.length > 512 ||
    typeof counts.mixed_currency !== "boolean" ||
    !isNonNegativeInteger(counts.unclassified_monetary_conversions) ||
    !breakdown.every(isCurrencyRevenue)
  ) {
    throw performanceContractError();
  }
  const currencies = breakdown.map((item) => item.currency);
  if (
    new Set(currencies).size !== currencies.length ||
    counts.mixed_currency !== breakdown.length > 1
  ) {
    throw performanceContractError();
  }
  const dominant = breakdown[0];
  const consistent = dominant
    ? counts.revenue_currency === dominant.currency &&
      counts.revenue_cents === dominant.revenue_cents &&
      counts.revenue_cents_saturated === dominant.revenue_cents_saturated
    : (counts.revenue_currency === undefined || counts.revenue_currency === "") &&
      counts.revenue_cents === 0;
  if (!consistent) throw performanceContractError();

  return {
    ...base,
    counts: {
      ...counters,
      revenue_by_currency: breakdown.map((item) => ({
        currency: item.currency,
        conversions: item.conversions,
        revenue_cents: item.revenue_cents,
        revenue_cents_saturated: item.revenue_cents_saturated,
      })),
      mixed_currency: counts.mixed_currency,
      unclassified_monetary_conversions:
        counts.unclassified_monetary_conversions,
      legacy_unlabelled_revenue: false,
    },
  };
}

export async function getSubscriberContactPerformance(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberContactPerformance> {
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/engagement`,
    { signal },
  );
  return parseSubscriberContactPerformance(raw, subscriberId);
}

/* ============================ Raw activity log =========================== */

export const SUBSCRIBER_ACTIVITY_PAGE_SIZE = 50;

/** One `subscriber_events` row, as GET /subscribers/{id}/activity emits it. */
export interface SubscriberActivityRow {
  id: number;
  event_type: string;
  campaign_id: string | null;
  link_url: string | null;
  at: string;
}

export interface SubscriberActivityPage {
  items: SubscriberActivityRow[];
  /**
   * The `before=` cursor for the next (older) page — the last row's `at`,
   * verbatim, so the server's microsecond precision survives. `null` when the
   * page came back short, i.e. there is nothing older.
   */
  next_before: string | null;
}

function activityContractError(): SubscriberExtrasContractError {
  return new SubscriberExtrasContractError(
    "The activity service returned an invalid response.",
  );
}

export function parseSubscriberActivityPage(
  value: unknown,
  requested: { limit: number; before?: string },
): SubscriberActivityPage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw activityContractError();
  }
  const limit =
    isInteger(value.limit) && value.limit > 0 ? value.limit : requested.limit;
  if (value.items.length > limit) throw activityContractError();
  const beforeMs =
    requested.before !== undefined ? Date.parse(requested.before) : null;
  const seen = new Set<number>();
  let previousMs = Number.POSITIVE_INFINITY;
  const items = value.items.map((item) => {
    if (
      !isRecord(item) ||
      !isInteger(item.id) ||
      typeof item.event_type !== "string" ||
      !item.event_type.trim() ||
      item.event_type.length > 64 ||
      !isTimestamp(item.at) ||
      (item.campaign_id !== undefined && typeof item.campaign_id !== "string") ||
      (item.link_url !== undefined && typeof item.link_url !== "string")
    ) {
      throw activityContractError();
    }
    const atMs = Date.parse(item.at);
    // Newest first, never repeating a row, and never newer than the cursor
    // that was asked for (millisecond compare: the server keeps microseconds).
    if (
      seen.has(item.id) ||
      atMs > previousMs ||
      (beforeMs !== null && atMs > beforeMs)
    ) {
      throw activityContractError();
    }
    seen.add(item.id);
    previousMs = atMs;
    return {
      id: item.id,
      event_type: item.event_type,
      campaign_id:
        typeof item.campaign_id === "string" && item.campaign_id
          ? item.campaign_id
          : null,
      link_url:
        typeof item.link_url === "string" && item.link_url
          ? item.link_url
          : null,
      at: item.at,
    };
  });
  const last = items.at(-1);
  return {
    items,
    next_before: items.length >= limit && last ? last.at : null,
  };
}

export async function listSubscriberActivity(
  subscriberId: string,
  options: { before?: string; signal?: AbortSignal } = {},
): Promise<SubscriberActivityPage> {
  if (options.before !== undefined && !isTimestamp(options.before)) {
    throw new SubscriberExtrasInputError("The activity cursor is invalid.");
  }
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/activity`,
    {
      query: {
        limit: SUBSCRIBER_ACTIVITY_PAGE_SIZE,
        before: options.before,
      },
      signal: options.signal,
    },
  );
  return parseSubscriberActivityPage(raw, {
    limit: SUBSCRIBER_ACTIVITY_PAGE_SIZE,
    before: options.before,
  });
}

/* ============================ Best send times ============================ */

/** Display order — matches the per-channel consent table. */
export const SEND_TIME_CHANNELS = [
  "email",
  "sms",
  "push",
  "whatsapp",
  "rcs",
] as const;

export interface ChannelSendTime {
  channel: string;
  /** Modal hour-of-week, 0-167 (UTC-bucketed, 0 = Sunday 00:00). */
  best_send_hour: number | null;
  best_send_hour_at: string | null;
}

export interface SubscriberSendTimes {
  subscriber_id: string;
  aggregate_best_send_hour: number | null;
  aggregate_best_send_hour_at: string | null;
  channels: ChannelSendTime[];
}

function isHourOfWeek(value: unknown): value is number {
  return isInteger(value) && value >= 0 && value <= 167;
}

function sendTimesContractError(): SubscriberExtrasContractError {
  return new SubscriberExtrasContractError(
    "The send-time service returned an invalid response.",
  );
}

export function parseSubscriberSendTimes(
  value: unknown,
  expectedSubscriberId: string,
): SubscriberSendTimes {
  if (
    !isRecord(value) ||
    typeof value.subscriber_id !== "string" ||
    !Array.isArray(value.channels) ||
    value.channels.length > 32 ||
    (value.aggregate_best_send_hour != null &&
      !isHourOfWeek(value.aggregate_best_send_hour)) ||
    (value.aggregate_best_send_hour_at != null &&
      !isTimestamp(value.aggregate_best_send_hour_at))
  ) {
    throw sendTimesContractError();
  }
  if (!sameId(value.subscriber_id, expectedSubscriberId)) {
    throw new SubscriberExtrasContractError(
      "The send-time service answered for a different subscriber.",
    );
  }
  const seen = new Set<string>();
  const channels = value.channels.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.channel !== "string" ||
      !row.channel.trim() ||
      row.channel.length > 32 ||
      seen.has(row.channel) ||
      (row.best_send_hour != null && !isHourOfWeek(row.best_send_hour)) ||
      (row.best_send_hour_at != null && !isTimestamp(row.best_send_hour_at))
    ) {
      throw sendTimesContractError();
    }
    seen.add(row.channel);
    const hour = isHourOfWeek(row.best_send_hour) ? row.best_send_hour : null;
    // The server derives day_of_week/hour_of_day from the same hour; a pair
    // that disagrees with it is a corrupted row, not a second opinion.
    if (
      (row.day_of_week != null &&
        (hour === null || row.day_of_week !== Math.floor(hour / 24))) ||
      (row.hour_of_day != null &&
        (hour === null || row.hour_of_day !== hour % 24))
    ) {
      throw sendTimesContractError();
    }
    return {
      channel: row.channel,
      best_send_hour: hour,
      best_send_hour_at: optionalTimestamp(row.best_send_hour_at),
    };
  });
  return {
    subscriber_id: value.subscriber_id,
    aggregate_best_send_hour: isHourOfWeek(value.aggregate_best_send_hour)
      ? value.aggregate_best_send_hour
      : null,
    aggregate_best_send_hour_at: optionalTimestamp(
      value.aggregate_best_send_hour_at,
    ),
    channels,
  };
}

export async function getSubscriberSendTimes(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberSendTimes> {
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/send-times`,
    { signal },
  );
  return parseSubscriberSendTimes(raw, subscriberId);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** "Tuesday 09:00 UTC" from a 0-167 hour-of-week. */
export function hourOfWeekLabel(hourOfWeek: number): string {
  const clamped = Math.min(167, Math.max(0, Math.trunc(hourOfWeek)));
  const day = WEEKDAYS[Math.floor(clamped / 24)] ?? "Sunday";
  return `${day} ${String(clamped % 24).padStart(2, "0")}:00 UTC`;
}

/* =========================== Predictive profile ========================== */

/**
 * The currency-independent half of `predictive.ProfileAnalytics`. CLV and
 * monetary scores are deliberately not carried: the API attaches no currency
 * to them, so they are withheld rather than rendered in an assumed currency.
 * Any individually malformed figure becomes `null` ("Unavailable").
 */
export interface SubscriberPredictiveProfile {
  prediction: {
    email: string;
    churn_risk: number | null;
    confidence: number | null;
    data_sufficiency: string;
    predicted_order_count: number | null;
    average_days_between_orders: number | null;
    expected_next_order_at: string | null;
    calculated_at: string | null;
  };
  rfm: {
    recency_days: number | null;
    recency_score: number | null;
    frequency: number | null;
    frequency_score: number | null;
    calculated_at: string | null;
  };
}

function fraction(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function quintile(value: unknown): number | null {
  return isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

/** Null on a malformed or Go zero-time timestamp. */
function realTimestamp(value: unknown): string | null {
  if (!isTimestamp(value)) return null;
  return value.startsWith("0001-01-01") ? null : value;
}

export function normalizePredictiveEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseSubscriberPredictiveProfile(
  value: unknown,
  expected: { email: string; subscriberId: string },
): SubscriberPredictiveProfile {
  if (
    !isRecord(value) ||
    !isRecord(value.prediction) ||
    !isRecord(value.rfm) ||
    typeof value.prediction.email !== "string"
  ) {
    throw new SubscriberExtrasContractError(
      "The predictive-profile service returned an invalid response.",
    );
  }
  const prediction = value.prediction;
  const rfm = value.rfm;
  const email = value.prediction.email;
  const subscriberId =
    typeof prediction.subscriber_id === "string"
      ? prediction.subscriber_id
      : "";
  if (
    normalizePredictiveEmail(email) !==
      normalizePredictiveEmail(expected.email) ||
    (subscriberId !== "" && !sameId(subscriberId, expected.subscriberId))
  ) {
    throw new SubscriberExtrasContractError(
      "The predictive-profile service answered for a different subscriber.",
    );
  }
  return {
    prediction: {
      email,
      churn_risk: fraction(prediction.churn_risk),
      confidence: fraction(prediction.confidence),
      data_sufficiency:
        typeof prediction.data_sufficiency === "string"
          ? prediction.data_sufficiency.slice(0, 80)
          : "",
      predicted_order_count: nonNegativeNumber(
        prediction.predicted_order_count,
      ),
      average_days_between_orders: nonNegativeNumber(
        prediction.average_days_between_orders,
      ),
      expected_next_order_at: realTimestamp(prediction.expected_next_order_at),
      calculated_at: realTimestamp(prediction.calculated_at),
    },
    rfm: {
      recency_days: isNonNegativeInteger(rfm.recency_days)
        ? rfm.recency_days
        : null,
      recency_score: quintile(rfm.recency_score),
      frequency: isNonNegativeInteger(rfm.frequency) ? rfm.frequency : null,
      frequency_score: quintile(rfm.frequency_score),
      calculated_at: realTimestamp(rfm.calculated_at),
    },
  };
}

/**
 * The predictive profile is keyed by email. A 404 means no profile has been
 * computed for this address yet — resolved as `null`, an empty state, not an
 * error.
 */
export async function getSubscriberPredictiveProfile(
  email: string,
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberPredictiveProfile | null> {
  const normalized = normalizePredictiveEmail(email);
  if (!normalized || normalized.length > 320) {
    throw new SubscriberExtrasInputError(
      "This subscriber has no email address to look a predictive profile up by.",
    );
  }
  try {
    const raw = await api.get<unknown>(
      `/api/v1/predictive/profiles/${encodeURIComponent(normalized)}`,
      { signal },
    );
    return parseSubscriberPredictiveProfile(raw, {
      email: normalized,
      subscriberId,
    });
  } catch (err) {
    if (isApiError(err) && Number(err.status) === 404) return null;
    throw err;
  }
}

/** Mirrors the predictive page: low sufficiency or confidence under 0.4. */
export function predictiveProfileIsLowConfidence(
  profile: SubscriberPredictiveProfile,
): boolean {
  const sufficiency = profile.prediction.data_sufficiency.toLowerCase();
  if (sufficiency.includes("low") || sufficiency.includes("insufficient")) {
    return true;
  }
  const confidence = profile.prediction.confidence;
  return confidence !== null && confidence > 0 && confidence < 0.4;
}
