// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/campaign-analytics-api.ts — the eleven per-campaign analytics reads that
 * back the campaign drill-down (`/app/campaigns/{id}/analytics`).
 *
 * Web reached none of them before this module: only the tenant-wide
 * `/api/v1/dashboard/*` reads and `report.csv` had web call sites, so every
 * per-campaign question desktop can answer — where did the clicks go, which
 * mail clients opened it, what bounced and how, how does it compare with the
 * tenant's own 90-day baseline — had no answer here at all.
 *
 * ## Exports (a sibling implementer will reuse these for the panels)
 *
 * | reader                        | route                                    | shape        |
 * | ----------------------------- | ---------------------------------------- | ------------ |
 * | `getCampaignReport`           | GET /api/v1/campaigns/{id}/report         | object       |
 * | `getCampaignTimeseries`       | GET /api/v1/campaigns/{id}/timeseries     | object       |
 * | `getCampaignAnomalies`        | GET /api/v1/campaigns/{id}/anomalies      | object       |
 * | `getCampaignGoalResults`      | GET /api/v1/campaigns/{id}/goal-results   | object       |
 * | `getCampaignLocaleReport`     | GET /api/v1/campaigns/{id}/locale-report  | `{locales}`  |
 * | `getCampaignLinkReport`       | GET /api/v1/campaigns/{id}/link-report    | BARE ARRAY   |
 * | `getCampaignGeography`        | GET /api/v1/campaigns/{id}/geography      | BARE ARRAY   |
 * | `getCampaignDevices`          | GET /api/v1/campaigns/{id}/devices        | BARE ARRAY   |
 * | `getCampaignBounces`          | GET /api/v1/campaigns/{id}/bounces        | object       |
 * | `getCampaignEngagement`       | GET /api/v1/campaigns/{id}/engagement     | object       |
 * | `getCampaignBenchmark`        | GET /api/v1/campaigns/{id}/benchmark      | object       |
 *
 * Three of them answer with a bare JSON array rather than an envelope
 * (`analytics.Service.LinkReport/Geography/Devices` return `[]Row`), which is
 * the kind of drift a `res.items ?? []` reader turns into a permanently empty
 * panel. Each reader below parses the shape the gateway actually sends.
 *
 * ## Units — the trap this module exists to hold still
 *
 * The gateway mixes rate units and nothing on the wire says which is which:
 *
 *  - `CampaignReport.*_rate` are **percent-unit** — `analytics.pct()`
 *    multiplies by 100. Divide by 100 before formatting as a fraction.
 *  - `LinkRow.ctr`, `GoalResults.conversion_rate`, every `EngagementPanel`
 *    rate, and `BenchmarkMetric.value` / `.baseline` are **fractions in
 *    [0,1]**. Format them directly.
 *
 * `PERCENT_UNIT_REPORT_RATES` names the percent-unit fields so a caller can
 * assert the distinction instead of guessing; guessing is how a genuine 0.8%
 * open rate renders as 80%.
 *
 * Reads only — every route is a GET behind the gateway's `read:reports`
 * scope, so a caller renders `apiErrorMessage(error)` (the server's own
 * refusal sentence) rather than inventing a permission explanation.
 */

import { api } from "@/lib/api";

/* -------------------------------------------------------------------------
 * Shared coercions. The gateway is trusted for meaning, not for shape: a
 * missing numeric field must read as 0, never as `NaN` rendered "NaN%".
 * ---------------------------------------------------------------------- */

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `null` — not 0 — when the server declined to compute the number. A 0
 *  delta and an absent delta mean different things in a benchmark row. */
function optionalNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter(
    (entry): entry is string => typeof entry === "string",
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/* -------------------------------------------------------------------------
 * 1. GET /api/v1/campaigns/{id}/report
 * ---------------------------------------------------------------------- */

export interface CampaignReportLink {
  url: string;
  clicks: number;
}

/** Mirrors apps/api/internal/analytics/analytics.go::CampaignReport. */
export interface CampaignReport {
  campaign_id: string;
  sent: number;
  delivered: number;
  opens: number;
  unique_opens: number;
  clicks: number;
  unique_clicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  /** PERCENT-unit. See the units note at the top of this file. */
  open_rate: number;
  /** PERCENT-unit. */
  click_rate: number;
  /** PERCENT-unit. */
  click_to_open_rate: number;
  /** PERCENT-unit. */
  bounce_rate: number;
  /** PERCENT-unit. */
  unsub_rate: number;
  top_links: CampaignReportLink[];
  /** Zero across the board when POSTWAVE_HUMAN_ENGAGEMENT is off. */
  human_opens: number;
  human_unique_opens: number;
  human_clicks: number;
  human_unique_clicks: number;
  /** PERCENT-unit, bot-stripped (`analytics.pct()` again). Zero when the
   *  human-engagement flag is off — the campaign performance panel only
   *  offers the "Human" view when a signature actually fired. */
  human_open_rate: number;
  /** PERCENT-unit. */
  human_click_rate: number;
  /** PERCENT-unit. */
  human_click_to_open_rate: number;
  /** The top links counted from human clicks only. */
  human_top_links: CampaignReportLink[];
  bot_signatures_applied: string[];
}

/** The report fields the gateway sends already multiplied by 100. */
export const PERCENT_UNIT_REPORT_RATES = [
  "open_rate",
  "click_rate",
  "click_to_open_rate",
  "bounce_rate",
  "unsub_rate",
  "human_open_rate",
  "human_click_rate",
  "human_click_to_open_rate",
] as const;

function parseReportLink(value: unknown): CampaignReportLink {
  const row = record(value);
  return { url: str(row.url), clicks: num(row.clicks) };
}

/**
 * Exported for the campaign performance panel's live stream: each
 * `/api/v1/campaigns/{id}/events` frame is a whole CampaignReport (see
 * analytics/sse.go), so the stream is parsed by the same reader as the GET
 * rather than a second, drifting one.
 */
export function parseCampaignReport(value: unknown): CampaignReport {
  const row = record(value);
  return {
    campaign_id: str(row.campaign_id),
    sent: num(row.sent),
    delivered: num(row.delivered),
    opens: num(row.opens),
    unique_opens: num(row.unique_opens),
    clicks: num(row.clicks),
    unique_clicks: num(row.unique_clicks),
    bounces: num(row.bounces),
    complaints: num(row.complaints),
    unsubscribes: num(row.unsubscribes),
    open_rate: num(row.open_rate),
    click_rate: num(row.click_rate),
    click_to_open_rate: num(row.click_to_open_rate),
    bounce_rate: num(row.bounce_rate),
    unsub_rate: num(row.unsub_rate),
    top_links: list(row.top_links).map(parseReportLink),
    human_opens: num(row.human_opens),
    human_unique_opens: num(row.human_unique_opens),
    human_clicks: num(row.human_clicks),
    human_unique_clicks: num(row.human_unique_clicks),
    human_open_rate: num(row.human_open_rate),
    human_click_rate: num(row.human_click_rate),
    human_click_to_open_rate: num(row.human_click_to_open_rate),
    human_top_links: list(row.human_top_links).map(parseReportLink),
    bot_signatures_applied: strings(row.bot_signatures_applied),
  };
}

export async function getCampaignReport(
  campaignId: string,
  options?: { signal?: AbortSignal; maxAttempts?: number },
): Promise<CampaignReport> {
  return parseCampaignReport(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/report`,
      options,
    ),
  );
}

/* -------------------------------------------------------------------------
 * 2. GET /api/v1/campaigns/{id}/timeseries
 * ---------------------------------------------------------------------- */

export interface CampaignHourBucket {
  /** RFC3339 hour, UTC, gap-filled by the gateway. */
  hour: string;
  opens: number;
  clicks: number;
  unsubs: number;
}

export interface CampaignTimeseries {
  campaign_id: string;
  buckets: CampaignHourBucket[];
  as_of: string;
  timezone: string;
  granularity: string;
  /** True when the series hit the gateway's 30-day hourly cap. */
  truncated: boolean;
}

function parseHourBucket(value: unknown): CampaignHourBucket {
  const row = record(value);
  return {
    hour: str(row.hour),
    opens: num(row.opens),
    clicks: num(row.clicks),
    unsubs: num(row.unsubs),
  };
}

function parseTimeseries(value: unknown): CampaignTimeseries {
  const row = record(value);
  return {
    campaign_id: str(row.campaign_id),
    buckets: list(row.buckets).map(parseHourBucket),
    as_of: str(row.as_of),
    timezone: str(row.timezone),
    granularity: str(row.granularity),
    truncated: bool(row.truncated),
  };
}

export async function getCampaignTimeseries(
  campaignId: string,
): Promise<CampaignTimeseries> {
  return parseTimeseries(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/timeseries`,
    ),
  );
}

/* -------------------------------------------------------------------------
 * 3. GET /api/v1/campaigns/{id}/anomalies
 * ---------------------------------------------------------------------- */

export interface CampaignAnomaly {
  hour: string;
  /** "opens" | "clicks" | "unsubs" — the gateway's own metric name. */
  metric: string;
  value: number;
  mean: number;
  z_score: number;
  /** "spike" | "drop". */
  direction: string;
}

export interface CampaignAnomalies {
  campaign_id: string;
  anomalies: CampaignAnomaly[];
}

function parseAnomaly(value: unknown): CampaignAnomaly {
  const row = record(value);
  return {
    hour: str(row.hour),
    metric: str(row.metric),
    value: num(row.value),
    mean: num(row.mean),
    z_score: num(row.z_score),
    direction: str(row.direction),
  };
}

export async function getCampaignAnomalies(
  campaignId: string,
): Promise<CampaignAnomalies> {
  const response = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/anomalies`,
    ),
  );
  return {
    campaign_id: str(response.campaign_id),
    anomalies: list(response.anomalies).map(parseAnomaly),
  };
}

/* -------------------------------------------------------------------------
 * 4. GET /api/v1/campaigns/{id}/goal-results
 * ---------------------------------------------------------------------- */

export interface CampaignGoalResults {
  campaign_id: string;
  goal_event: string;
  goal_window_hours: number;
  /** False when the campaign has no goal event + window to evaluate. */
  configured: boolean;
  /** Goal events, including repeat events and explicitly attributed anonymous events. */
  conversion_count: number;
  /** Distinct identified recipients with at least one goal event. */
  converted_recipients: number;
  recipients: number;
  /** Distinct identified converters / distinct sent recipients; FRACTION in [0,1]. */
  conversion_rate: number;
  attributed_revenue_cents: number;
  /** Empty when the response carried no per-currency breakdown. */
  currency: string;
  revenue_status?: "none" | "single_currency" | "mixed_currency" | "missing_currency";
}

export async function getCampaignGoalResults(
  campaignId: string,
): Promise<CampaignGoalResults> {
  const row = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/goal-results`,
    ),
  );
  return {
    campaign_id: str(row.campaign_id),
    goal_event: str(row.goal_event),
    goal_window_hours: num(row.goal_window_hours),
    configured: bool(row.configured),
    conversion_count: num(row.conversion_count),
    converted_recipients: num(row.converted_recipients),
    recipients: num(row.recipients),
    conversion_rate: num(row.conversion_rate),
    attributed_revenue_cents: num(row.attributed_revenue_cents),
    currency: str(row.currency),
    revenue_status: (["single_currency", "mixed_currency", "missing_currency"] as const).find(
      (status) => status === row.revenue_status,
    ) ?? "none",
  };
}

/* -------------------------------------------------------------------------
 * 5. GET /api/v1/campaigns/{id}/locale-report
 * ---------------------------------------------------------------------- */

export interface CampaignLocaleStat {
  locale: string;
  sent: number;
  opens: number;
  clicks: number;
}

export async function getCampaignLocaleReport(
  campaignId: string,
): Promise<CampaignLocaleStat[]> {
  const response = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/locale-report`,
    ),
  );
  return list(response.locales).map((value) => {
    const row = record(value);
    return {
      locale: str(row.locale),
      sent: num(row.sent),
      opens: num(row.opens),
      clicks: num(row.clicks),
    };
  });
}

/* -------------------------------------------------------------------------
 * 6. GET /api/v1/campaigns/{id}/link-report — BARE ARRAY
 * ---------------------------------------------------------------------- */

export interface CampaignLinkRow {
  url: string;
  clicks: number;
  /** Unique clickers of THIS link. Per-link, so these do not sum to a
   *  campaign-level unique total — one person can appear in several rows. */
  unique_clickers: number;
  /** FRACTION in [0,1]. */
  ctr: number;
}

export async function getCampaignLinkReport(
  campaignId: string,
): Promise<CampaignLinkRow[]> {
  const response = await api.get<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/link-report`,
  );
  return list(response).map((value) => {
    const row = record(value);
    return {
      url: str(row.url),
      clicks: num(row.clicks),
      unique_clickers: num(row.unique_clickers),
      ctr: num(row.ctr),
    };
  });
}

/* -------------------------------------------------------------------------
 * 7. GET /api/v1/campaigns/{id}/geography — BARE ARRAY
 * ---------------------------------------------------------------------- */

export interface CampaignGeographyRow {
  country: string;
  opens: number;
  clicks: number;
}

export async function getCampaignGeography(
  campaignId: string,
): Promise<CampaignGeographyRow[]> {
  const response = await api.get<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/geography`,
  );
  return list(response).map((value) => {
    const row = record(value);
    return {
      country: str(row.country),
      opens: num(row.opens),
      clicks: num(row.clicks),
    };
  });
}

/* -------------------------------------------------------------------------
 * 8. GET /api/v1/campaigns/{id}/devices — BARE ARRAY
 * ---------------------------------------------------------------------- */

export interface CampaignDeviceRow {
  /** Mail client, inferred from the open beacon's user agent. */
  client: string;
  opens: number;
  clicks: number;
}

export async function getCampaignDevices(
  campaignId: string,
): Promise<CampaignDeviceRow[]> {
  const response = await api.get<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/devices`,
  );
  return list(response).map((value) => {
    const row = record(value);
    return {
      client: str(row.client),
      opens: num(row.opens),
      clicks: num(row.clicks),
    };
  });
}

/* -------------------------------------------------------------------------
 * 9. GET /api/v1/campaigns/{id}/bounces
 * ---------------------------------------------------------------------- */

export interface CampaignBounceCounts {
  hard: number;
  soft: number;
  spam_trap: number;
  total: number;
}

export async function getCampaignBounces(
  campaignId: string,
): Promise<CampaignBounceCounts> {
  const row = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/bounces`,
    ),
  );
  return {
    hard: num(row.hard),
    soft: num(row.soft),
    spam_trap: num(row.spam_trap),
    total: num(row.total),
  };
}

/* -------------------------------------------------------------------------
 * 10. GET /api/v1/campaigns/{id}/engagement
 * ---------------------------------------------------------------------- */

/**
 * Mirrors apps/api/internal/analytics/analytics.go::EngagementPanel. Every
 * rate here is a FRACTION in [0,1]. The trust-signal half is counted, never
 * estimated; `ai_surfacing_score` is the one estimate and must never render
 * without saying so.
 */
export interface CampaignEngagementPanel {
  campaign_id: string;
  /** "all" | "human" | "machine" | "unknown" — the band these counts used. */
  classification_filter: string;
  delivered: number;
  human_unique_opens: number;
  /** FRACTION. Bot-stripped. */
  human_open_rate: number;
  /** FRACTION. Unfiltered, so the caller can show what was stripped. */
  raw_open_rate: number;
  reply_count: number;
  distinct_replyers: number;
  /** FRACTION. */
  reply_rate: number;
  open_decoupled_conversions: number;
  total_attributed_conversions: number;
  bot_signatures_applied: string[];
  /** ESTIMATE, fraction in [0,1]. Never render this as fact. */
  ai_surfacing_score: number;
  ai_surfacing_basis: string[];
  /** "low" | "ok". */
  ai_surfacing_confidence_level: string;
  ai_surfacing_sample_opens: number;
}

export async function getCampaignEngagement(
  campaignId: string,
): Promise<CampaignEngagementPanel> {
  const row = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/engagement`,
    ),
  );
  return {
    campaign_id: str(row.campaign_id),
    classification_filter: str(row.classification_filter),
    delivered: num(row.delivered),
    human_unique_opens: num(row.human_unique_opens),
    human_open_rate: num(row.human_open_rate),
    raw_open_rate: num(row.raw_open_rate),
    reply_count: num(row.reply_count),
    distinct_replyers: num(row.distinct_replyers),
    reply_rate: num(row.reply_rate),
    open_decoupled_conversions: num(row.open_decoupled_conversions),
    total_attributed_conversions: num(row.total_attributed_conversions),
    bot_signatures_applied: strings(row.bot_signatures_applied),
    ai_surfacing_score: num(row.ai_surfacing_score),
    ai_surfacing_basis: strings(row.ai_surfacing_basis),
    ai_surfacing_confidence_level: str(row.ai_surfacing_confidence_level),
    ai_surfacing_sample_opens: num(row.ai_surfacing_sample_opens),
  };
}

/**
 * Whether to render the bot-stripped "Human open rate" instead of the raw
 * one. True only when bot filtering produced genuine signal — at least one
 * human unique open, or at least one signature that actually fired. When it
 * is false the caller shows the RAW rate and discloses that filtering is off,
 * rather than labelling an unfiltered number "human".
 */
export function showsHumanOpenRate(
  panel: Pick<
    CampaignEngagementPanel,
    "human_unique_opens" | "bot_signatures_applied"
  >,
): boolean {
  return (
    panel.human_unique_opens > 0 || panel.bot_signatures_applied.length > 0
  );
}

/**
 * Bot inflation as percentage points between the raw and the human rate.
 * Clamped at 0: inflation can only be non-negative (bots add opens), so a
 * human rate above the raw one is a glitch, not "negative inflation".
 */
export function botInflationPoints(
  panel: Pick<CampaignEngagementPanel, "raw_open_rate" | "human_open_rate">,
): number {
  const delta = (panel.raw_open_rate - panel.human_open_rate) * 100;
  return delta > 0 ? delta : 0;
}

/* -------------------------------------------------------------------------
 * 11. GET /api/v1/campaigns/{id}/benchmark
 * ---------------------------------------------------------------------- */

export interface CampaignBenchmarkMetric {
  name: string;
  /** FRACTION for the `*_rate` metrics. */
  value: number;
  /** FRACTION for the `*_rate` metrics. */
  baseline: number;
  delta: number;
  /** Percent change, or null when the server declined to compute one. */
  delta_pct: number | null;
  percentile: number | null;
  /** "above" | "on_par" | "below"; empty when withheld. */
  verdict: string;
  available: boolean;
  reason: string;
}

export interface CampaignBenchmarkRates {
  recipients: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
  unsubscribe_rate: number;
}

export interface CampaignBenchmark {
  campaign_id: string;
  baseline_days: number;
  baseline_from: string;
  baseline_to: string;
  as_of: string;
  timezone: string;
  baseline_selection: string;
  baseline_sample_size: number;
  minimum_sample_size: number;
  baseline_available: boolean;
  baseline_unavailable_reason: string;
  this: CampaignBenchmarkRates;
  tenant_baseline: CampaignBenchmarkRates;
  metrics: CampaignBenchmarkMetric[];
}

function parseBenchmarkRates(value: unknown): CampaignBenchmarkRates {
  const row = record(value);
  return {
    recipients: num(row.recipients),
    open_rate: num(row.open_rate),
    click_rate: num(row.click_rate),
    bounce_rate: num(row.bounce_rate),
    complaint_rate: num(row.complaint_rate),
    unsubscribe_rate: num(row.unsubscribe_rate),
  };
}

export async function getCampaignBenchmark(
  campaignId: string,
): Promise<CampaignBenchmark> {
  const row = record(
    await api.get<unknown>(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/benchmark`,
    ),
  );
  return {
    campaign_id: str(row.campaign_id),
    baseline_days: num(row.baseline_days),
    baseline_from: str(row.baseline_from),
    baseline_to: str(row.baseline_to),
    as_of: str(row.as_of),
    timezone: str(row.timezone),
    baseline_selection: str(row.baseline_selection),
    baseline_sample_size: num(row.baseline_sample_size),
    minimum_sample_size: num(row.minimum_sample_size),
    baseline_available: bool(row.baseline_available),
    baseline_unavailable_reason: str(row.baseline_unavailable_reason),
    this: parseBenchmarkRates(row.this),
    tenant_baseline: parseBenchmarkRates(row.tenant_baseline),
    metrics: list(row.metrics).map((value) => {
      const metric = record(value);
      return {
        name: str(metric.name),
        value: num(metric.value),
        baseline: num(metric.baseline),
        delta: num(metric.delta),
        delta_pct: optionalNum(metric.delta_pct),
        percentile: optionalNum(metric.percentile),
        verdict: str(metric.verdict),
        available: bool(metric.available),
        reason: str(metric.reason),
      };
    }),
  };
}

/**
 * Whether the benchmark may state a VERDICT ("above" / "below") rather than
 * only descriptive rates. The gateway can answer with metrics while the
 * baseline behind them is too thin to judge against, and a verdict drawn from
 * three comparison campaigns is a coin flip wearing a label.
 */
export function benchmarkCanVerdict(benchmark: CampaignBenchmark): boolean {
  return (
    benchmark.baseline_available &&
    benchmark.baseline_sample_size >= benchmark.minimum_sample_size
  );
}
