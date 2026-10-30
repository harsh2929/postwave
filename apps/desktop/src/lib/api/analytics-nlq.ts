import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type AnalyticsNlqRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

type AnalyticsNlqRequestOptions = NativeFacadeRequestOptions;
export type AnalyticsNlqQueryOptions = Pick<
  NativeFacadeRequestOptions,
  "signal"
>;

/* ---------- R6 Analytics NLQ + anomaly brief (nql pkg) --------------- */

export interface AnalyticsNlqParams {
  window_days: number;
  limit: number;
}

export interface AnalyticsNlqTrace {
  reasoning: string;
  prompt_tokens: number;
  response_tokens: number;
  summary_tokens: number;
  generated_at: string;
}

/** POST /api/v1/analytics/nlq response (nql.analyticsNLQResponse). */
export interface AnalyticsNlqResponse {
  question: string;
  /** "table" → render columns/rows; "summary" → render summary_text. */
  answer_kind: "table" | "summary";
  template: string;
  params: AnalyticsNlqParams;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  summary_text: string;
  trace: AnalyticsNlqTrace;
}

export type AnomalyBriefMetric =
  | "opens"
  | "clicks"
  | "bounces"
  | "complaints"
  | "unsubscribes"
  | "revenue";

/** Whitelist mirror of nql.AnomalyMetricIDs() — keep in sync. */
export const ANOMALY_BRIEF_METRICS: ReadonlyArray<AnomalyBriefMetric> = [
  "opens",
  "clicks",
  "bounces",
  "complaints",
  "unsubscribes",
  "revenue",
];

/** Currency provenance for revenue anomaly evidence. Revenue responses always
 * include this object; count-metric responses omit it. A null currency is only
 * valid when the combined comparison horizon has no monetary conversions. */
export interface AnomalyBriefRevenueScope {
  currency: string | null;
  monetary_conversion_count: number;
  /** Number of distinct non-dominant currencies excluded from all revenue
   * totals, daily points, and campaign rows in this brief. */
  excluded_currency_count: number;
}

export interface AnomalyBriefAggregates {
  metric: AnomalyBriefMetric;
  window_days: number;
  current_total: number;
  previous_total: number;
  daily: Array<{ day: string; value: number }>;
  top_campaigns: Array<{
    campaign_id: string;
    campaign_name: string;
    value: number;
  }>;
  revenue_scope?: AnomalyBriefRevenueScope;
}

export interface AnomalyBriefResponse {
  metric: AnomalyBriefMetric;
  window_days: number;
  summary: string;
  probable_causes: string[];
  suggested_actions: string[];
  aggregates: AnomalyBriefAggregates;
  trace: AnalyticsNlqTrace;
}

export function createAnalyticsNlqApi(
  request: AnalyticsNlqRequester,
  llmRequestOptions: AnalyticsNlqRequestOptions,
) {
  return {
    /** POST /api/v1/analytics/nlq `{question}` — LLM-backed (60s budget,
     *  fire-once). 503 nlq_unavailable when no ANTHROPIC_API_KEY; 429
     *  cost_cap_exceeded when the tenant's daily token budget is spent. */
    query(
      question: string,
      options: AnalyticsNlqQueryOptions = {},
    ): Promise<ApiResult<AnalyticsNlqResponse>> {
      return request<AnalyticsNlqResponse>(
        "/api/v1/analytics/nlq",
        { method: "POST", body: JSON.stringify({ question }) },
        { ...llmRequestOptions, ...options },
      );
    },
    /** POST /api/v1/analytics/anomaly-brief `{metric,window_days,context?}` —
     *  metric MUST be in {@link ANOMALY_BRIEF_METRICS} (else 422
     *  invalid_metric). LLM-backed (60s budget, fire-once). */
    anomalyBrief(input: {
      metric: AnomalyBriefMetric;
      window_days: number;
      context?: string;
    }): Promise<ApiResult<AnomalyBriefResponse>> {
      return request<AnomalyBriefResponse>(
        "/api/v1/analytics/anomaly-brief",
        { method: "POST", body: JSON.stringify(input) },
        llmRequestOptions,
      );
    },
  };
}
