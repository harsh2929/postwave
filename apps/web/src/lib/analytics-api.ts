// SPDX-License-Identifier: AGPL-3.0-only
import { api } from "./api";

type AnalyticsRequestOptions = Omit<RequestInit, "body"> & {
  requireOnline?: boolean;
  maxAttempts?: number;
};

/**
 * Period-over-period comparison window. Field names mirror DashboardStats
 * without the "30d" suffix (see analytics.go PreviousWindow).
 */
export interface DashboardStatsPrevious {
  subscribers_added?: number;
  subscribers_unsubbed?: number;
  campaigns_sent?: number;
  opens_total?: number;
  clicks_total?: number;
  bounces_total?: number;
  emails_sent?: number;
  unique_opens?: number;
  unique_clicks?: number;
  unique_bounces?: number;
  unique_delivered?: number;
  unique_sent?: number;
}

export interface DashboardStats {
  subscribers_total: number;
  subscribers_added_30d: number;
  subscribers_unsubbed_30d: number;
  campaigns_sent_30d: number;
  opens_total_30d: number;
  clicks_total_30d: number;
  bounces_total_30d: number;
  // Distinct-recipient counts the backend returns so open/click/bounce rates
  // can be computed on the client (analytics.go:162-166) — ANL-010.
  unique_opens_30d?: number;
  unique_clicks_30d?: number;
  unique_bounces_30d?: number;
  unique_delivered_30d?: number;
  unique_sent_30d?: number;
  emails_sent_30d?: number;
  active_sequences_count?: number;
  inbox_health?: {
    score?: number;
    state?: string;
  } | null;
  recent_audit?: Array<{
    id?: string;
    action?: string;
    actor?: string;
    at?: string;
    description?: string;
  }>;
  // Refined-dashboard additions (analytics.go): period-over-period comparison,
  // daily sparkline buckets keyed by metric ("subscribers" | "opens" | "clicks"
  // | "bounces"), and z-score anomaly flags per metric.
  range?: string;
  previous?: DashboardStatsPrevious | null;
  sparklines?: Record<string, number[]>;
  anomalies?: Record<string, boolean>;
  // Revenue attribution is not yet emitted by the backend DashboardStats
  // struct (no revenue field exists). Declared optional so the home can light
  // up a revenue KPI the moment the backend starts sending it, without
  // fabricating a value in the meantime (OVR-033).
  revenue_attributed_30d?: number | null;
  revenue_currency?: string | null;
}

/** Path of the dashboard SSE stream; consumed via EventSource (ANL-030). */
export const DASHBOARD_LIVE_PATH = "/api/v1/dashboard/live";

export const analyticsApi = {
  dashboardStats: (opts?: AnalyticsRequestOptions & { range?: string }) => {
    const { range, ...init } = opts ?? {};
    return api.get<DashboardStats>("/api/v1/dashboard/stats", {
      ...init,
      // Only send ?range for non-default windows so the 30d request stays
      // byte-identical to the shared dashboard/home query (dedupe).
      ...(range && range !== "30d" ? { query: { range } } : {}),
    });
  },
};

// ---------------------------------------------------------------------------
// Scheduled email digest prefs — GET/PUT /api/v1/dashboard/digest (ANL-011)
// ---------------------------------------------------------------------------

export type DigestFrequency = "off" | "daily" | "weekly";

export interface DigestPrefs {
  frequency: DigestFrequency;
  lastSentAt?: string;
  updatedAt?: string;
}

export function getDigestPrefs(
  opts?: AnalyticsRequestOptions,
): Promise<DigestPrefs> {
  return api.get<DigestPrefs>("/api/v1/dashboard/digest", opts);
}

export function putDigestPrefs(
  frequency: DigestFrequency,
  opts: { signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<{ ok: boolean; frequency: DigestFrequency }> {
  return api.put<{ ok: boolean; frequency: DigestFrequency }>(
    "/api/v1/dashboard/digest",
    { frequency },
    {
      signal: opts.signal,
      idempotencyKey: opts.idempotencyKey,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
}

// ---------------------------------------------------------------------------
// Industry benchmarks — GET /api/v1/dashboard/benchmarks (ANL-029)
// ---------------------------------------------------------------------------

export interface BenchmarkRow {
  metric: "opens" | "clicks" | "bounces" | "unsubs" | string;
  /** Rate in [0,1]. */
  average: number;
  source: string;
}

export interface BenchmarksResponse {
  rows: BenchmarkRow[];
  note: string;
}

export function getBenchmarks(
  opts?: AnalyticsRequestOptions,
): Promise<BenchmarksResponse> {
  return api.get<BenchmarksResponse>("/api/v1/dashboard/benchmarks", opts);
}

// ---------------------------------------------------------------------------
// Persisted per-user dashboard layout — GET/PUT /api/v1/dashboard/layout (ANL-034)
// ---------------------------------------------------------------------------

export interface DashboardLayout {
  order: string[];
  surface?: string;
  updatedAt?: string;
}

// OVR-032: `surface` selects which dashboard's layout to read/write —
// "analytics" (the KPI row, default) or "home" (the home widget stack).
function layoutPath(surface?: string): string {
  return surface
    ? `/api/v1/dashboard/layout?surface=${encodeURIComponent(surface)}`
    : "/api/v1/dashboard/layout";
}

export function getLayout(
  opts?: AnalyticsRequestOptions & { surface?: string },
): Promise<DashboardLayout> {
  const { surface, ...rest } = opts ?? {};
  return api.get<DashboardLayout>(layoutPath(surface), rest);
}

export function putLayout(
  order: string[],
  opts?: { surface?: string; signal?: AbortSignal; idempotencyKey?: string },
): Promise<{ ok: boolean }> {
  return api.put<{ ok: boolean }>(
    layoutPath(opts?.surface),
    { order },
    {
      signal: opts?.signal,
      idempotencyKey: opts?.idempotencyKey,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
}

// ---------------------------------------------------------------------------
// Recent anomalies list — GET /api/v1/dashboard/anomalies (ANL-026)
// ---------------------------------------------------------------------------

export interface AnomalyRow {
  id: string;
  metric: string;
  dayBucket: string;
  value: number;
  mean: number;
  zScore: number;
  rangeUsed?: string;
  detectedAt?: string;
}

export function listAnomalies(
  limit = 20,
  opts?: AnalyticsRequestOptions,
): Promise<{ items: AnomalyRow[] }> {
  return api.get<{ items: AnomalyRow[] }>("/api/v1/dashboard/anomalies", {
    ...opts,
    query: { limit },
  });
}

// ---------------------------------------------------------------------------
// Subscriber-growth timeseries — GET /api/v1/analytics/subscribers/timeseries (ANL-012)
// ---------------------------------------------------------------------------

export interface SubscriberTimeseriesPoint {
  date: string;
  count: number;
}

export interface SubscriberTimeseriesResponse {
  range: string;
  points: SubscriberTimeseriesPoint[];
}

export function getSubscriberTimeseries(
  range: string,
  opts?: AnalyticsRequestOptions,
): Promise<SubscriberTimeseriesResponse> {
  return api.get<SubscriberTimeseriesResponse>(
    "/api/v1/analytics/subscribers/timeseries",
    { ...opts, query: { range } },
  );
}

// ---------------------------------------------------------------------------
// Campaign comparison / leaderboard — GET /api/v1/analytics/campaigns/compare (ANL-014)
// ---------------------------------------------------------------------------

export interface CompareRow {
  campaign_id: string;
  total_recipients: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
  unsub_rate: number;
}

export function compareCampaigns(
  ids: string[],
  opts?: AnalyticsRequestOptions,
): Promise<CompareRow[]> {
  return api.get<CompareRow[]>("/api/v1/analytics/campaigns/compare", {
    ...opts,
    query: { ids: ids.join(",") },
  });
}

// ---------------------------------------------------------------------------
// Subscriber lifecycle funnel + campaign revenue attribution parity
// ---------------------------------------------------------------------------

export interface SubscriberFunnelStep {
  stage: "signup" | "first_purchase" | "repeat_purchase";
  label: string;
  count: number;
  conversion_rate: number;
}

export interface SubscriberFunnelCohort {
  cohort_label: string;
  signup_count: number;
  first_purchase_count: number;
  repeat_purchase_count: number;
  first_purchase_rate: number;
  repeat_purchase_rate: number;
}

export interface SubscriberLifecycleFunnel {
  bucket: "month";
  cohort_by: "created_at_month";
  steps: SubscriberFunnelStep[];
  cohorts: SubscriberFunnelCohort[];
}

export interface RevenueCurrencyTotal {
  currency: string;
  conversions: number;
  revenue_cents: number;
}

export interface CampaignRevenueAttributionRow {
  campaign_id: string;
  campaign_name: string;
  conversions: number;
  revenue_cents: number;
  emails_sent: number;
  revenue_per_send_cents?: number;
}

export interface AttributionProvenance {
  explicit: number;
  last_touch: number;
  none: number;
  code_redemption: number;
  campaign_vanity_path: number;
  unclassified: number;
}

export interface CampaignRevenueAttribution {
  items: CampaignRevenueAttributionRow[];
  provenance: AttributionProvenance;
  total_revenue_cents: number;
  unattributed_cents: number;
  unattributed_conversions: number;
  currency?: string;
  currencies: RevenueCurrencyTotal[];
  total_campaigns: number;
  days: number;
}

export interface RevenueTimeseriesPoint {
  date: string;
  revenue_cents: number;
  conversions: number;
}

export interface CampaignRevenueTimeseries {
  points: RevenueTimeseriesPoint[];
  currency?: string;
  currencies: RevenueCurrencyTotal[];
  days: number;
  campaign_id?: string;
}

const ANALYTICS_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_CURRENCY = /^[A-Z]{3}$/u;
const DATE_BUCKET = /^\d{4}-\d{2}-\d{2}$/u;
const COHORT_BUCKET = /^\d{4}-\d{2}$/u;

function analyticsRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid " + label + " response");
  }
  return value as Record<string, unknown>;
}

function analyticsText(
  value: unknown,
  label: string,
  maximum = 500,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error("Invalid " + label);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error("Invalid " + label);
  return normalized;
}

function analyticsInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("Invalid " + label);
  }
  return value;
}

function analyticsNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("Invalid " + label);
  }
  return value;
}

function analyticsCurrency(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const currency = analyticsText(value, label, 3).toUpperCase();
  if (!ISO_CURRENCY.test(currency)) throw new Error("Invalid " + label);
  return currency;
}

function parseCurrencyTotals(
  value: unknown,
  label: string,
): RevenueCurrencyTotal[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Invalid " + label);
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const row = analyticsRecord(item, label + " row");
    const currency = analyticsCurrency(row.currency, label + " currency");
    if (!currency || seen.has(currency)) {
      throw new Error("Invalid " + label + " currency identity");
    }
    seen.add(currency);
    return {
      currency,
      conversions: analyticsInteger(row.conversions, label + " conversions"),
      revenue_cents: analyticsInteger(
        row.revenue_cents,
        label + " revenue",
        Number.MIN_SAFE_INTEGER,
      ),
    };
  });
}

export function parseSubscriberLifecycleFunnel(
  value: unknown,
): SubscriberLifecycleFunnel {
  const root = analyticsRecord(value, "subscriber lifecycle funnel");
  if (root.bucket !== "month" || root.cohort_by !== "created_at_month") {
    throw new Error("Invalid subscriber lifecycle funnel dimensions");
  }
  if (!Array.isArray(root.steps) || root.steps.length !== 3) {
    throw new Error("Invalid subscriber lifecycle funnel steps");
  }
  const expected = [
    ["signup", "Signed Up"],
    ["first_purchase", "First Purchase"],
    ["repeat_purchase", "Repeat Purchase"],
  ] as const;
  const steps = root.steps.map((item, index) => {
    const row = analyticsRecord(item, "subscriber lifecycle funnel step");
    const [stage, label] = expected[index]!;
    if (row.stage !== stage || row.label !== label) {
      throw new Error("Invalid subscriber lifecycle funnel stage");
    }
    return {
      stage,
      label,
      count: analyticsInteger(row.count, stage + " count"),
      conversion_rate: analyticsNumber(
        row.conversion_rate,
        stage + " conversion rate",
        0,
        100,
      ),
    };
  });
  if (steps[1]!.count > steps[0]!.count || steps[2]!.count > steps[1]!.count) {
    throw new Error("Invalid subscriber lifecycle funnel hierarchy");
  }
  if (!Array.isArray(root.cohorts) || root.cohorts.length > 24) {
    throw new Error("Invalid subscriber lifecycle funnel cohorts");
  }
  const seen = new Set<string>();
  const cohorts = root.cohorts.map((item) => {
    const row = analyticsRecord(item, "subscriber lifecycle cohort");
    const cohortLabel = analyticsText(row.cohort_label, "cohort label", 7);
    if (!COHORT_BUCKET.test(cohortLabel) || seen.has(cohortLabel)) {
      throw new Error("Invalid subscriber lifecycle cohort identity");
    }
    seen.add(cohortLabel);
    const signupCount = analyticsInteger(row.signup_count, "cohort signups");
    const firstPurchaseCount = analyticsInteger(
      row.first_purchase_count,
      "cohort first purchases",
    );
    const repeatPurchaseCount = analyticsInteger(
      row.repeat_purchase_count,
      "cohort repeat purchases",
    );
    if (
      firstPurchaseCount > signupCount ||
      repeatPurchaseCount > firstPurchaseCount
    ) {
      throw new Error("Invalid subscriber lifecycle cohort hierarchy");
    }
    return {
      cohort_label: cohortLabel,
      signup_count: signupCount,
      first_purchase_count: firstPurchaseCount,
      repeat_purchase_count: repeatPurchaseCount,
      first_purchase_rate: analyticsNumber(
        row.first_purchase_rate,
        "cohort first-purchase rate",
        0,
        100,
      ),
      repeat_purchase_rate: analyticsNumber(
        row.repeat_purchase_rate,
        "cohort repeat-purchase rate",
        0,
        100,
      ),
    };
  });
  const sums = cohorts.reduce(
    (total, cohort) => ({
      signup: total.signup + cohort.signup_count,
      first: total.first + cohort.first_purchase_count,
      repeat: total.repeat + cohort.repeat_purchase_count,
    }),
    { signup: 0, first: 0, repeat: 0 },
  );
  if (
    sums.signup !== steps[0]!.count ||
    sums.first !== steps[1]!.count ||
    sums.repeat !== steps[2]!.count
  ) {
    throw new Error("Subscriber lifecycle funnel totals do not reconcile");
  }
  return {
    bucket: "month",
    cohort_by: "created_at_month",
    steps,
    cohorts,
  };
}

function parseAttributionProvenance(value: unknown): AttributionProvenance {
  const row = analyticsRecord(value, "revenue attribution provenance");
  return {
    explicit: analyticsInteger(row.explicit, "explicit attribution"),
    last_touch: analyticsInteger(row.last_touch, "last-touch attribution"),
    none: analyticsInteger(row.none, "unattributed conversions"),
    code_redemption: analyticsInteger(
      row.code_redemption,
      "code-redemption linkage",
    ),
    campaign_vanity_path: analyticsInteger(
      row.campaign_vanity_path,
      "campaign vanity-path linkage",
    ),
    unclassified: analyticsInteger(
      row.unclassified,
      "unclassified attribution",
    ),
  };
}

export function parseCampaignRevenueAttribution(
  value: unknown,
  expectedDays?: number,
): CampaignRevenueAttribution {
  const root = analyticsRecord(value, "campaign revenue attribution");
  const days = analyticsInteger(root.days, "attribution days", 1, 365);
  if (expectedDays !== undefined && days !== expectedDays) {
    throw new Error("Revenue attribution window mismatch");
  }
  if (!Array.isArray(root.items) || root.items.length > 51) {
    throw new Error("Invalid campaign revenue attribution rows");
  }
  const seen = new Set<string>();
  let rollups = 0;
  const items = root.items.map((item) => {
    const row = analyticsRecord(item, "campaign revenue attribution row");
    const campaignId = analyticsText(
      row.campaign_id,
      "campaign identity",
      64,
      true,
    ).toLowerCase();
    if (campaignId) {
      if (!ANALYTICS_UUID.test(campaignId) || seen.has(campaignId)) {
        throw new Error("Invalid campaign revenue attribution identity");
      }
      seen.add(campaignId);
    } else {
      rollups += 1;
    }
    const revenuePerSend =
      row.revenue_per_send_cents === undefined ||
      row.revenue_per_send_cents === null
        ? undefined
        : analyticsNumber(
            row.revenue_per_send_cents,
            "campaign revenue per send",
            Number.MIN_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
          );
    return {
      campaign_id: campaignId,
      campaign_name: analyticsText(row.campaign_name, "campaign name"),
      conversions: analyticsInteger(row.conversions, "campaign conversions"),
      revenue_cents: analyticsInteger(
        row.revenue_cents,
        "campaign revenue",
        Number.MIN_SAFE_INTEGER,
      ),
      emails_sent: analyticsInteger(row.emails_sent, "campaign sends"),
      ...(revenuePerSend === undefined
        ? {}
        : { revenue_per_send_cents: revenuePerSend }),
    };
  });
  if (rollups > 1) throw new Error("Invalid campaign revenue rollup");
  const currency = analyticsCurrency(root.currency, "attribution currency");
  const currencies = parseCurrencyTotals(
    root.currencies,
    "attribution currencies",
  );
  const provenance = parseAttributionProvenance(root.provenance);
  const unattributedConversions = analyticsInteger(
    root.unattributed_conversions,
    "unattributed conversions",
  );
  const itemConversions = items.reduce(
    (sum, item) => sum + item.conversions,
    0,
  );
  const provenanceTotal =
    provenance.explicit +
    provenance.last_touch +
    provenance.none +
    provenance.code_redemption +
    provenance.campaign_vanity_path +
    provenance.unclassified;
  if (provenanceTotal !== itemConversions + unattributedConversions) {
    throw new Error("Revenue attribution provenance does not reconcile");
  }
  const totalRevenue = analyticsInteger(
    root.total_revenue_cents,
    "total revenue",
    Number.MIN_SAFE_INTEGER,
  );
  const unattributedRevenue = analyticsInteger(
    root.unattributed_cents,
    "unattributed revenue",
    Number.MIN_SAFE_INTEGER,
  );
  if (
    items.reduce((sum, item) => sum + item.revenue_cents, 0) +
      unattributedRevenue !==
    totalRevenue
  ) {
    throw new Error("Campaign revenue attribution totals do not reconcile");
  }
  if (
    currency &&
    !currencies.some(
      (entry) =>
        entry.currency === currency && entry.revenue_cents === totalRevenue,
    )
  ) {
    throw new Error("Revenue attribution currency totals do not reconcile");
  }
  const totalCampaigns = analyticsInteger(
    root.total_campaigns,
    "attributed campaign count",
  );
  if (totalCampaigns < seen.size) {
    throw new Error("Invalid attributed campaign count");
  }
  return {
    items,
    provenance,
    total_revenue_cents: totalRevenue,
    unattributed_cents: unattributedRevenue,
    unattributed_conversions: unattributedConversions,
    ...(currency ? { currency } : {}),
    currencies,
    total_campaigns: totalCampaigns,
    days,
  };
}

export function parseCampaignRevenueTimeseries(
  value: unknown,
  expected: { days: number; campaignId?: string },
): CampaignRevenueTimeseries {
  const root = analyticsRecord(value, "campaign revenue timeseries");
  const days = analyticsInteger(root.days, "revenue timeseries days", 1, 365);
  if (days !== expected.days)
    throw new Error("Revenue timeseries window mismatch");
  if (!Array.isArray(root.points) || root.points.length !== days) {
    throw new Error("Invalid revenue timeseries points");
  }
  let prior = "";
  const seen = new Set<string>();
  const points = root.points.map((item) => {
    const row = analyticsRecord(item, "revenue timeseries point");
    const date = analyticsText(row.date, "revenue date", 10);
    if (!DATE_BUCKET.test(date) || seen.has(date) || (prior && date <= prior)) {
      throw new Error("Invalid revenue timeseries date sequence");
    }
    const parsed = new Date(date + "T00:00:00Z");
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date
    ) {
      throw new Error("Invalid revenue timeseries date");
    }
    seen.add(date);
    prior = date;
    return {
      date,
      revenue_cents: analyticsInteger(
        row.revenue_cents,
        "daily revenue",
        Number.MIN_SAFE_INTEGER,
      ),
      conversions: analyticsInteger(row.conversions, "daily conversions"),
    };
  });
  const expectedId = expected.campaignId?.trim().toLowerCase();
  const responseId =
    root.campaign_id === undefined || root.campaign_id === ""
      ? undefined
      : analyticsText(
          root.campaign_id,
          "timeseries campaign identity",
          64,
        ).toLowerCase();
  if (
    (expectedId &&
      (!ANALYTICS_UUID.test(expectedId) || responseId !== expectedId)) ||
    (!expectedId && responseId)
  ) {
    throw new Error("Revenue timeseries campaign identity mismatch");
  }
  const currency = analyticsCurrency(root.currency, "timeseries currency");
  const currencies = parseCurrencyTotals(
    root.currencies,
    "timeseries currencies",
  );
  return {
    points,
    ...(currency ? { currency } : {}),
    currencies,
    days,
    ...(responseId ? { campaign_id: responseId } : {}),
  };
}

export async function getSubscriberLifecycleFunnel(
  input: { weeks?: number; audienceId?: string; signal?: AbortSignal } = {},
): Promise<SubscriberLifecycleFunnel> {
  const weeks = input.weeks ?? 12;
  analyticsInteger(weeks, "subscriber cohort count", 1, 24);
  const audienceId = input.audienceId?.trim() ?? "";
  if (audienceId.length > 200) throw new Error("Invalid funnel audience scope");
  return parseSubscriberLifecycleFunnel(
    await api.get<unknown>("/api/v1/analytics/subscribers/funnel", {
      query: {
        cohort_by: "created_at_month",
        bucket: "month",
        weeks,
        audience_id: audienceId || undefined,
      },
      signal: input.signal,
    }),
  );
}

export async function getCampaignRevenueAttribution(
  days: number,
  signal?: AbortSignal,
): Promise<CampaignRevenueAttribution> {
  analyticsInteger(days, "attribution days", 1, 365);
  return parseCampaignRevenueAttribution(
    await api.get<unknown>("/api/v1/conversions/attribution/campaigns", {
      query: { days },
      signal,
    }),
    days,
  );
}

export async function getCampaignRevenueTimeseries(input: {
  days: number;
  campaignId?: string;
  signal?: AbortSignal;
}): Promise<CampaignRevenueTimeseries> {
  analyticsInteger(input.days, "timeseries days", 1, 365);
  const campaignId = input.campaignId?.trim().toLowerCase();
  if (campaignId && !ANALYTICS_UUID.test(campaignId)) {
    throw new Error("Invalid timeseries campaign identity");
  }
  return parseCampaignRevenueTimeseries(
    await api.get<unknown>("/api/v1/conversions/attribution/timeseries", {
      query: { days: input.days, campaign_id: campaignId || undefined },
      signal: input.signal,
    }),
    { days: input.days, ...(campaignId ? { campaignId } : {}) },
  );
}
