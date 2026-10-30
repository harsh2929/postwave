import type { ApiResult } from "./result";

interface NativeProviderRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type AnalyticsIntegrationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeProviderRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- Native analytics/CDP integrations ------------------------- */

export interface AnalyticsProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface AnalyticsProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  capabilities: string[];
  required_settings: AnalyticsProviderField[];
  optional_settings?: AnalyticsProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface AnalyticsIntegration {
  id: string;
  provider: string;
  name: string;
  status: string;
  scopes: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
  sync_cursor?: string;
  last_sync_at?: string | null;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface AnalyticsIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface AnalyticsProfileInput {
  source_id?: string;
  email: string;
  user_id?: string;
  anonymous_id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  traits?: Record<string, unknown>;
  updated_at?: string;
}

export interface AnalyticsEventInput {
  source_id?: string;
  email: string;
  user_id?: string;
  anonymous_id?: string;
  event_name: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface AnalyticsSyncRequest {
  run_mode?: string;
  profiles?: AnalyticsProfileInput[];
  events?: AnalyticsEventInput[];
  cursor?: string;
}

export interface AnalyticsSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  profiles_seen: number;
  profiles_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface AnalyticsSyncRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  profiles_seen: number;
  profiles_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface AnalyticsSyncRunsResponse {
  items: AnalyticsSyncRun[];
}

export function createAnalyticsIntegrationsApi(
  request: AnalyticsIntegrationsRequester,
) {
  return {
    providers(): Promise<ApiResult<{ items: AnalyticsProviderSpec[] }>> {
      return request<{ items: AnalyticsProviderSpec[] }>(
        "/api/v1/analytics-integrations/providers",
      );
    },
    list(): Promise<ApiResult<{ items: AnalyticsIntegration[] }>> {
      return request<{ items: AnalyticsIntegration[] }>(
        "/api/v1/analytics-integrations",
      );
    },
    create(
      input: AnalyticsIntegrationInput,
    ): Promise<ApiResult<AnalyticsIntegration>> {
      return request<AnalyticsIntegration>("/api/v1/analytics-integrations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    sync(
      id: string,
      input: AnalyticsSyncRequest = {},
    ): Promise<ApiResult<AnalyticsSyncSummary>> {
      return request<AnalyticsSyncSummary>(
        `/api/v1/analytics-integrations/${encodeURIComponent(id)}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    backfill(
      id: string,
      input: AnalyticsSyncRequest = {},
    ): Promise<ApiResult<AnalyticsSyncSummary>> {
      return request<AnalyticsSyncSummary>(
        `/api/v1/analytics-integrations/${encodeURIComponent(id)}/backfill`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    ingest(
      id: string,
      input: AnalyticsEventInput,
    ): Promise<ApiResult<AnalyticsSyncSummary>> {
      return request<AnalyticsSyncSummary>(
        `/api/v1/analytics-integrations/${encodeURIComponent(id)}/ingest`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    pause(id: string): Promise<ApiResult<AnalyticsIntegration>> {
      return request<AnalyticsIntegration>(
        `/api/v1/analytics-integrations/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
    },
    disconnect(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/analytics-integrations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    runs(
      id: string,
      limit = 25,
    ): Promise<ApiResult<AnalyticsSyncRunsResponse>> {
      return request<AnalyticsSyncRunsResponse>(
        `/api/v1/analytics-integrations/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`,
      );
    },
  };
}
