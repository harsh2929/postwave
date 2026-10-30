import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type ReportingRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- KLV-12 reporting: blocked products ----------------------- */

/**
 * BlockedProduct mirrors reporting.BlockedProduct (apps/api/internal/
 * reporting/export.go), built by BlockedProductSummary. It tells the
 * report UI WHICH gating Klaviyo-parity initiative a not-yet-shipped
 * metric is waiting on — so dashboards show "deliverability breakdowns
 * need KLV-14" instead of an empty pane.
 *
 * Field names match the Go json tags 1:1:
 *   product_area, initiative, blocked_note, metrics, statuses.
 * `metrics` and `statuses` are positional companions (statuses[i] is the
 * runtime_status of metrics[i]).
 */
export interface BlockedProduct {
  /** Metric product area, e.g. "deliverability", "flow", "sms". */
  product_area: string;
  /** Gating register initiative, e.g. "KLV-14-deliverability-routing-…". */
  initiative: string;
  /** Human-readable reason the area's metrics aren't available yet. */
  blocked_note: string;
  /** Metric keys waiting on this initiative. */
  metrics: string[];
  /** Per-metric runtime_status ("planned" / "partial"), aligned to metrics. */
  statuses: string[];
}

/** GET /api/v1/reporting/blocked-products response. The handler wraps the
 *  array in `{schema_version, items}` (verified in reporting.go), NOT a
 *  bare array. */
export interface BlockedProductsResponse {
  schema_version: string;
  items: BlockedProduct[];
}

/* ---------- KLV-12 reporting: metric registry + report builder ------- */

/** One available report metric (reporting.MetricDefinition). runtime_status
 *  ∈ supported|partial|planned — only "supported" returns real data; the
 *  others are gated on a product (see {@link BlockedProduct}). */
export interface ReportMetricDefinition {
  key: string;
  label: string;
  product_area: string;
  source: string;
  aggregation: string;
  value_type: string;
  dimensions?: string[];
  runtime_status: string;
  help?: string;
}

export interface ReportMetricRegistryResponse {
  schema_version: string;
  items: ReportMetricDefinition[];
}

/** A selected metric in a report request (reporting.MetricSpec). */
export interface ReportMetricSpec {
  key: string;
  alias?: string;
  aggregation?: string;
}

export interface ReportTimeRange {
  preset?: string;
  from?: string;
  to?: string;
}

/** POST body for preview / save (reporting.ReportRequest). */
export interface ReportRequest {
  name?: string;
  description?: string;
  product_area?: string;
  status?: string;
  metrics: ReportMetricSpec[];
  dimensions?: string[];
  filters?: Record<string, unknown>;
  time_range?: ReportTimeRange;
  visualization?: string;
  schedule?: Record<string, unknown>;
}

export interface ReportDefinition {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  product_area: string;
  status: string;
  metrics: ReportMetricSpec[];
  dimensions: string[];
  filters: Record<string, unknown>;
  time_range: ReportTimeRange;
  visualization: string;
  schedule?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** POST /reporting/preview response (reporting.PreviewResponse). 422 when
 *  invalid — `valid:false` + `errors`. Rows are column→value maps. */
export interface ReportPreviewResponse {
  schema_version: string;
  valid: boolean;
  rows: Array<Record<string, unknown>>;
  metrics: ReportMetricDefinition[];
  warnings?: string[];
  errors?: string[];
}

export interface ReportRun {
  id: string;
  tenant_id: string;
  definition_id?: string;
  status: string;
  request?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  rows_total: number;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
}

export function createReportingApi(request: ReportingRequester) {
  return {
    /** GET /api/v1/reporting/blocked-products → `{schema_version, items}`
     *  (the handler WRAPS the array — verified in reporting.go — it is NOT a
     *  bare array), one entry per gated product area (reporting read scope). */
    blockedProducts(): Promise<ApiResult<BlockedProductsResponse>> {
      return request<BlockedProductsResponse>(
        "/api/v1/reporting/blocked-products",
      );
    },
    /** GET /api/v1/reporting/metric-registry → `{schema_version, items}`. */
    metricRegistry(): Promise<ApiResult<ReportMetricRegistryResponse>> {
      return request<ReportMetricRegistryResponse>(
        "/api/v1/reporting/metric-registry",
      );
    },
    /** POST /api/v1/reporting/preview — runs the report inline. 422 with
     *  `{valid:false, errors}` when the request is invalid (read scope). */
    preview(req: ReportRequest): Promise<ApiResult<ReportPreviewResponse>> {
      return request<ReportPreviewResponse>("/api/v1/reporting/preview", {
        method: "POST",
        body: JSON.stringify(req),
      });
    },
    /** GET /api/v1/reporting/definitions?status= → `{items}`. */
    listDefinitions(
      status?: string,
    ): Promise<ApiResult<{ items: ReportDefinition[] }>> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return request<{ items: ReportDefinition[] }>(
        `/api/v1/reporting/definitions${qs}`,
      );
    },
    /** GET /api/v1/reporting/definitions/{id}. */
    getDefinition(id: string): Promise<ApiResult<ReportDefinition>> {
      return request<ReportDefinition>(
        `/api/v1/reporting/definitions/${encodeURIComponent(id)}`,
      );
    },
    /** POST /api/v1/reporting/definitions — save (admin scope). */
    upsertDefinition(req: ReportRequest): Promise<ApiResult<ReportDefinition>> {
      return request<ReportDefinition>("/api/v1/reporting/definitions", {
        method: "POST",
        body: JSON.stringify(req),
      });
    },
    /** POST /api/v1/reporting/definitions/{id}/runs — execute (admin scope). */
    runDefinition(id: string): Promise<ApiResult<ReportRun>> {
      return request<ReportRun>(
        `/api/v1/reporting/definitions/${encodeURIComponent(id)}/runs`,
        { method: "POST", body: "{}" },
      );
    },
    /** GET /api/v1/reporting/runs → `{items}`. */
    listRuns(): Promise<ApiResult<{ items: ReportRun[] }>> {
      return request<{ items: ReportRun[] }>("/api/v1/reporting/runs");
    },
    /** GET /api/v1/reporting/runs/{id}. */
    getRun(id: string): Promise<ApiResult<ReportRun>> {
      return request<ReportRun>(
        `/api/v1/reporting/runs/${encodeURIComponent(id)}`,
      );
    },
  };
}
