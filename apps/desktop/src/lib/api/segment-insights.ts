import type { ApiErr, ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type SegmentInsightsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

interface SegmentDownloadController {
  signal: AbortSignal;
  dispose: () => void;
}

interface SegmentInsightsDependencies {
  apiUrl: (path: string) => string;
  createDownloadController: (
    callerSignal?: AbortSignal | null,
  ) => SegmentDownloadController;
  errorFromResponse: (response: Response) => Promise<ApiErr["error"]>;
  getApiKey: () => string | null;
  nativeFetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  normalizeApiKey: (key: string | null | undefined) => string | null;
  transportError: (error: unknown) => ApiErr["error"];
}

/* ---------- R11 Segment insights (segments/overlap.go + growth.go) --- */

/** segments.OverlapResponse — jaccard ∈ [0,1]. */
export interface SegmentOverlapResponse {
  a: string;
  b: string;
  a_count: number;
  b_count: number;
  intersection: number;
  jaccard: number;
}

export interface SegmentGrowthPoint {
  /** YYYY-MM-DD snapshot_date. */
  date: string;
  evaluated_at: string;
  count: number;
}

/** segments.GrowthResponse — delta/delta_pct compare newest vs oldest
 *  point in the window (zero-valued when < 2 points). */
export interface SegmentGrowthResponse {
  segment_id: string;
  days: number;
  series: SegmentGrowthPoint[];
  delta: number;
  delta_pct: number;
  /** Explains an empty/short series (no snapshots yet). */
  note?: string;
}

/* ---------- SUB-031 Segment growth report (segments/growth_report.go) -
 * Goes beyond the single-net-delta /growth endpoint: one row per day
 * carrying running size + the adds/drops that produced it, plus the
 * anomaly events the decay radar detected, correlated onto the matching
 * snapshot_date. CSV export variant streams the same series. */

/** segments.GrowthReportPoint — running count + per-day churn. capped_*
 *  disclose when a day hit the membership-log per-direction cap. */
export interface SegmentGrowthReportPoint {
  date: string; // YYYY-MM-DD snapshot_date
  count: number;
  adds: number;
  drops: number;
  capped_adds?: boolean;
  capped_drops?: boolean;
  /** Change in count vs the previous reported day (0 on the first). */
  delta: number;
  /** size_cliff / zero_match / everyone_match / … when a decay event
   *  landed on this day; absent otherwise. */
  anomaly_kind?: string;
}

/** segments.GrowthReportAnomaly — top-level marker for a correlated
 *  decay event so the chart can render it without re-scanning the series. */
export interface SegmentGrowthReportAnomaly {
  date: string;
  anomaly_kind: string;
  prior_count: number;
  new_count: number;
  leaver_count: number;
  entrant_count: number;
}

/** segments.GrowthReportResponse — JSON shape of the growth report. */
export interface SegmentGrowthReportResponse {
  segment_id: string;
  days: number;
  series: SegmentGrowthReportPoint[];
  anomalies: SegmentGrowthReportAnomaly[];
  total_adds: number;
  total_drops: number;
  net_delta: number;
  net_pct: number;
  /** Explains an empty series (no snapshots yet). */
  note?: string;
}

export function createSegmentInsightsApi(
  request: SegmentInsightsRequester,
  dependencies: SegmentInsightsDependencies,
) {
  return {
    /** GET /api/v1/segments/overlap?a=&b= (both segment ids required). */
    overlap(a: string, b: string): Promise<ApiResult<SegmentOverlapResponse>> {
      const params = new URLSearchParams({ a, b });
      return request<SegmentOverlapResponse>(
        `/api/v1/segments/overlap?${params.toString()}`,
      );
    },
    /** GET /api/v1/segments/{id}/growth?days= (default 90, clamp 1..365;
     *  a trailing "d" is tolerated: "30d" == 30). */
    growth(
      id: string,
      opts: { days?: number } = {},
    ): Promise<ApiResult<SegmentGrowthResponse>> {
      const qs =
        opts.days != null
          ? `?days=${encodeURIComponent(String(opts.days))}`
          : "";
      return request<SegmentGrowthResponse>(
        `/api/v1/segments/${encodeURIComponent(id)}/growth${qs}`,
      );
    },
    /** GET /api/v1/segments/{id}/growth/report?days= (SUB-031). */
    growthReport(
      id: string,
      opts: { days?: number } = {},
    ): Promise<ApiResult<SegmentGrowthReportResponse>> {
      const qs =
        opts.days != null
          ? `?days=${encodeURIComponent(String(opts.days))}`
          : "";
      return request<SegmentGrowthReportResponse>(
        `/api/v1/segments/${encodeURIComponent(id)}/growth/report${qs}`,
      );
    },
    /**
     * GET /api/v1/segments/{id}/growth/report.csv (SUB-031). Returns the
     * raw CSV blob + the server-suggested filename from Content-Disposition.
     * Caller triggers the actual save (anchor click via createObjectURL).
     */
    async growthReportCSV(
      id: string,
      opts: { days?: number; signal?: AbortSignal } = {},
    ): Promise<ApiResult<{ blob: Blob; filename: string }>> {
      const dl = dependencies.createDownloadController(opts.signal);
      try {
        const qs =
          opts.days != null
            ? `?days=${encodeURIComponent(String(opts.days))}`
            : "";
        const path = `/api/v1/segments/${encodeURIComponent(id)}/growth/report.csv${qs}`;
        const headers: Record<string, string> = { Accept: "text/csv" };
        const key = dependencies.normalizeApiKey(dependencies.getApiKey());
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await dependencies.nativeFetch(dependencies.apiUrl(path), {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: dl.signal,
        });
        if (!res.ok) {
          return { error: await dependencies.errorFromResponse(res) };
        }
        const cd = res.headers.get("Content-Disposition") ?? "";
        const m = /filename="([^"]+)"/.exec(cd);
        const filename =
          m?.[1] ??
          `segment-growth-report-${new Date().toISOString().slice(0, 10)}.csv`;
        const blob = await res.blob();
        return { data: { blob, filename } };
      } catch (err) {
        return { error: dependencies.transportError(err) };
      } finally {
        dl.dispose();
      }
    },
  };
}
