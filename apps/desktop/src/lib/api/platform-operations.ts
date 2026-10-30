/** Platform usage, billing, governance, discovery, and search APIs. */

import type { ApiResult } from "./result";

type PlatformRequest = <T>(
  path: string,
  init?: RequestInit,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    maxResponseTextBytes?: number;
  },
) => Promise<ApiResult<T>>;

// The generated contract is currently ~4.2 MiB. Keep this endpoint above the
// ordinary 2 MiB JSON ceiling while retaining a finite, testable upper bound.
export const OPENAPI_SPEC_MAX_RESPONSE_TEXT_BYTES = 8 * 1024 * 1024;

export interface APIUsageSummary {
  window_days: number;
  since: string;
  total_sends: number;
  total_cost_cents: number;
  active_keys: number;
  avg_sends_per_day: number;
  avg_cost_cents_per_day: number;
  projected_30d_sends: number;
  projected_30d_cost_cents: number;
  [extra: string]: unknown;
}

export interface APIUsageKeyRow {
  id: string;
  label: string;
  prefix: string;
  actor_type: string;
  sends: number;
  cost_cents: number;
  last_active_period?: string;
  [extra: string]: unknown;
}

export interface PlanSummaryResource {
  resource: string;
  current: number;
  limit: number;
  /** 0–100; may exceed 100 when over the cap. */
  percent: number;
  exceeded: boolean;
}

/** Honest server projection; the UI must continue to label it as an estimate. */
export interface PlanSendsProjection {
  current: number;
  limit: number;
  as_of: string;
  period_start: string;
  period_end: string;
  avg_per_day: number;
  days_elapsed: number;
  days_in_period: number;
  projected_end_of_period: number;
  projected_exceed_date: string | null;
  on_track_to_exceed: boolean;
}

export interface PlanSummary {
  tier: string;
  current_period_end?: string;
  resources: PlanSummaryResource[];
  sends_projection: PlanSendsProjection;
}

/** The cost service intentionally uses camelCase wire keys. */
export interface CostAggregateRow {
  apiKeyId?: string | null;
  actorType?: string | null;
  kind?: string | null;
  day?: string | null;
  cents: number;
  quantity: number;
  count: number;
}

export interface CostLedgerEntry {
  id: number;
  tenantId: string;
  apiKeyId?: string | null;
  actorType?: string | null;
  kind: string;
  cents: number;
  quantity: number;
  at: string;
  metadata: Record<string, unknown>;
}

export interface FeatureFlag {
  id: string;
  key: string;
  value: string;
  note?: string;
  tenant_id?: string;
  is_default: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RegionInfo {
  region: string;
  sdk_host: string;
  is_eu: boolean;
}

export interface CurrentRegionInfo {
  region: string;
  is_eu: boolean;
  is_us: boolean;
  sdk_host: string;
  postmark_base: string;
  mailgun_base: string;
  ses_region: string;
}

export interface GlobalSearchResult {
  /** list | segment | suppression | subscriber */
  type: string;
  id: string;
  title: string;
  detail?: string;
}

export function createPlatformOperationsApis(request: PlatformRequest) {
  const apiUsageApi = {
    summary(days?: number): Promise<ApiResult<APIUsageSummary>> {
      const query = days == null ? "" : `?days=${days}`;
      return request<APIUsageSummary>(`/api/v1/api-usage/summary${query}`);
    },
    keys(days?: number): Promise<
      ApiResult<{
        window_days: number;
        since: string;
        keys: APIUsageKeyRow[];
        count: number;
      }>
    > {
      const query = days == null ? "" : `?days=${days}`;
      return request(`/api/v1/api-usage/keys${query}`);
    },
    timeseries(days?: number): Promise<
      ApiResult<{
        window_days: number;
        points: Array<{ date: string; sends: number; cost_cents: number }>;
      }>
    > {
      const query = days == null ? "" : `?days=${days}`;
      return request(`/api/v1/api-usage/timeseries${query}`);
    },
  };

  const billingApi = {
    planSummary(): Promise<ApiResult<PlanSummary>> {
      return request<PlanSummary>("/api/v1/billing/plan-summary");
    },
  };

  const costsApi = {
    aggregate(opts: { since?: string; by?: string[] } = {}): Promise<
      ApiResult<{
        rows: CostAggregateRow[];
        buckets: CostAggregateRow[];
        since: string;
        group_by: string;
      }>
    > {
      const params = new URLSearchParams();
      if (opts.since) params.set("since", opts.since);
      if (opts.by?.length) params.set("by", opts.by.join(","));
      const query = params.toString();
      return request(`/api/v1/costs${query ? `?${query}` : ""}`);
    },
    ledger(
      opts: { since?: string; cursor?: string; limit?: number } = {},
    ): Promise<ApiResult<{ rows: CostLedgerEntry[]; nextCursor?: string }>> {
      const params = new URLSearchParams();
      if (opts.since) params.set("since", opts.since);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      const query = params.toString();
      return request(`/api/v1/costs/ledger${query ? `?${query}` : ""}`);
    },
  };

  const featureFlagsApi = {
    list(): Promise<ApiResult<{ flags: FeatureFlag[]; count: number }>> {
      return request("/api/v1/feature-flags");
    },
    upsert(input: {
      key: string;
      value: string;
      note?: string;
    }): Promise<ApiResult<{ id: string; key: string; value: string }>> {
      return request("/api/v1/feature-flags", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    remove(key: string): Promise<ApiResult<void>> {
      return request(`/api/v1/feature-flags/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
    },
    resolve(
      key: string,
    ): Promise<ApiResult<{ key: string; value: string; source: string }>> {
      return request(
        `/api/v1/feature-flags/${encodeURIComponent(key)}/resolve`,
      );
    },
  };

  const regionsApi = {
    list(): Promise<ApiResult<{ regions: RegionInfo[] }>> {
      return request("/api/regions");
    },
    current(): Promise<ApiResult<CurrentRegionInfo>> {
      return request("/api/regions/current");
    },
  };

  const openApiSpecApi = {
    get(): Promise<ApiResult<Record<string, unknown>>> {
      return request(
        "/api/v1/openapi.json",
        {},
        {
          timeoutMs: 20_000,
          maxResponseTextBytes: OPENAPI_SPEC_MAX_RESPONSE_TEXT_BYTES,
        },
      );
    },
  };

  const searchApi = {
    global(
      query: string,
      options: { limit?: number; signal?: AbortSignal } = {},
    ): Promise<ApiResult<{ query: string; results: GlobalSearchResult[] }>> {
      const params = new URLSearchParams({ q: query });
      if (options.limit != null) params.set("limit", String(options.limit));
      return request(
        `/api/v1/search?${params.toString()}`,
        {},
        {
          signal: options.signal,
        },
      );
    },
  };

  return {
    apiUsageApi,
    billingApi,
    costsApi,
    featureFlagsApi,
    openApiSpecApi,
    regionsApi,
    searchApi,
  };
}
