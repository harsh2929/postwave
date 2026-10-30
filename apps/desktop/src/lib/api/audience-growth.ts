import { apiRequest, type ApiResult } from "../api-client";

/** One daily snapshot on the audience series. */
export interface AudienceGrowthPoint {
  date: string;
  evaluated_at: string;
  total: number;
  added: number;
  unsubbed: number;
  lapsed: number;
}

export type AudienceGrowthUnavailableMetric = "added" | "unsubbed" | "lapsed";

export const AUDIENCE_GROWTH_METRIC_CONTRACT_VERSION =
  "verified-exact-ledger-v2" as const;

/** Delta compares newest vs oldest total in the window. */
export interface AudienceGrowthResponse {
  days: number;
  series: AudienceGrowthPoint[];
  /** Closed semantic version; legacy heuristic snapshots must fail parsing. */
  metric_contract_version: typeof AUDIENCE_GROWTH_METRIC_CONTRACT_VERSION;
  /** Placeholder-valued flows that must not be charted as observed facts. */
  unavailable_metrics: AudienceGrowthUnavailableMetric[];
  /** Verified lower-bound flows whose source coverage is not exhaustive. */
  partial_metrics: AudienceGrowthUnavailableMetric[];
  total_added: number;
  total_unsubbed: number;
  delta: number;
  delta_pct: number;
  /** Explains an empty or short cold-start series. */
  note?: string;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validTimestamp(value: string): number | null {
  if (
    value.trim() !== value ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
      value,
    ) ||
    !validDateKey(value.slice(0, 10))
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > Date.now() + 5 * 60 * 1_000) {
    return null;
  }
  return parsed;
}

/**
 * Validate the API payload at the network boundary. TypeScript interfaces do
 * not protect the renderer from a successful but incomplete JSON response.
 */
export function isAudienceGrowthResponse(
  value: unknown,
): value is AudienceGrowthResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<AudienceGrowthResponse>;
  if (
    !Number.isSafeInteger(response.days) ||
    (response.days as number) < 1 ||
    (response.days as number) > 365 ||
    !nonNegativeSafeInteger(response.total_added) ||
    !nonNegativeSafeInteger(response.total_unsubbed) ||
    !Number.isSafeInteger(response.delta) ||
    !finiteNumber(response.delta_pct) ||
    response.metric_contract_version !==
      AUDIENCE_GROWTH_METRIC_CONTRACT_VERSION ||
    !Array.isArray(response.series) ||
    response.series.length > (response.days as number) ||
    !Array.isArray(response.unavailable_metrics) ||
    !Array.isArray(response.partial_metrics) ||
    (response.note !== undefined &&
      (typeof response.note !== "string" ||
        response.note.length > 1_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/u.test(
          response.note,
        )))
  ) {
    return false;
  }
  const unavailableMetrics = new Set<AudienceGrowthUnavailableMetric>();
  for (const metric of response.unavailable_metrics) {
    if (
      !["added", "unsubbed", "lapsed"].includes(metric) ||
      unavailableMetrics.has(metric)
    ) {
      return false;
    }
    unavailableMetrics.add(metric);
  }
  const partialMetrics = new Set<AudienceGrowthUnavailableMetric>();
  for (const metric of response.partial_metrics) {
    if (
      !["added", "unsubbed", "lapsed"].includes(metric) ||
      partialMetrics.has(metric) ||
      unavailableMetrics.has(metric)
    ) {
      return false;
    }
    partialMetrics.add(metric);
  }
  if (
    (unavailableMetrics.size > 0 || partialMetrics.size > 0) &&
    (typeof response.note !== "string" || response.note.trim() === "")
  ) {
    return false;
  }
  let previousDate = "";
  let previousEvaluation = Number.NEGATIVE_INFINITY;
  let summedAdded = 0;
  let summedUnsubbed = 0;
  for (const point of response.series) {
    const evaluatedAt =
      point &&
      typeof point === "object" &&
      typeof point.evaluated_at === "string"
        ? validTimestamp(point.evaluated_at)
        : null;
    if (
      !point ||
      typeof point !== "object" ||
      typeof point.date !== "string" ||
      !validDateKey(point.date) ||
      point.date <= previousDate ||
      evaluatedAt === null ||
      evaluatedAt <= previousEvaluation ||
      !nonNegativeSafeInteger(point.total) ||
      !nonNegativeSafeInteger(point.added) ||
      !nonNegativeSafeInteger(point.unsubbed) ||
      !nonNegativeSafeInteger(point.lapsed)
    ) {
      return false;
    }
    if (new Date(evaluatedAt).toISOString().slice(0, 10) !== point.date) {
      return false;
    }
    if (
      (unavailableMetrics.has("added") && point.added !== 0) ||
      (unavailableMetrics.has("unsubbed") && point.unsubbed !== 0) ||
      (unavailableMetrics.has("lapsed") && point.lapsed !== 0)
    ) {
      return false;
    }
    previousDate = point.date;
    previousEvaluation = evaluatedAt;
    summedAdded += point.added;
    summedUnsubbed += point.unsubbed;
    if (
      !Number.isSafeInteger(summedAdded) ||
      !Number.isSafeInteger(summedUnsubbed)
    ) {
      return false;
    }
  }
  if (
    unavailableMetrics.size !== 1 ||
    !unavailableMetrics.has("lapsed") ||
    partialMetrics.size !== 1 ||
    !partialMetrics.has("unsubbed") ||
    summedAdded !== response.total_added ||
    summedUnsubbed !== response.total_unsubbed ||
    (unavailableMetrics.has("added") && response.total_added !== 0) ||
    (unavailableMetrics.has("unsubbed") && response.total_unsubbed !== 0)
  ) {
    return false;
  }
  const expectedDelta =
    response.series.length < 2
      ? 0
      : response.series.at(-1)!.total - response.series[0]!.total;
  if (response.delta !== expectedDelta) return false;
  const expectedDeltaPct =
    response.series.length < 2 || response.series[0]!.total === 0
      ? 0
      : (expectedDelta / response.series[0]!.total) * 100;
  const percentTolerance = Math.max(
    1e-9,
    Math.abs(expectedDeltaPct) * Number.EPSILON * 16,
  );
  return Math.abs(response.delta_pct - expectedDeltaPct) <= percentTolerance;
}

export const audienceGrowthApi = {
  /** GET /api/v1/subscribers/growth?days=. */
  async get(
    opts: { days?: number; signal?: AbortSignal } = {},
  ): Promise<ApiResult<AudienceGrowthResponse>> {
    if (
      opts.days !== undefined &&
      (!Number.isSafeInteger(opts.days) || opts.days < 1 || opts.days > 365)
    ) {
      return {
        error: {
          kind: "http",
          status: 400,
          code: "invalid_audience_growth_window",
          message:
            "Audience growth window must be a whole number from 1 to 365 days.",
        },
      };
    }
    const qs =
      opts.days != null ? `?days=${encodeURIComponent(String(opts.days))}` : "";
    const result = await apiRequest<unknown>(
      `/api/v1/subscribers/growth${qs}`,
      {},
      opts.signal ? { signal: opts.signal } : {},
    );
    if (result.error) return result;
    if (!isAudienceGrowthResponse(result.data)) {
      return {
        error: {
          kind: "parse",
          message: "Audience growth response was malformed.",
        },
      };
    }
    if (opts.days !== undefined && result.data.days !== opts.days) {
      return {
        error: {
          kind: "parse",
          code: "invalid_audience_growth_window_response",
          message:
            "Audience growth returned a different window than requested. The previous verified snapshot was kept; retry the request.",
        },
      };
    }
    return { data: result.data };
  },
};
