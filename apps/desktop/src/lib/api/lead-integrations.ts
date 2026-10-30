import type {
  NativeIntegrationIngestSummary,
  NativeIntegrationRunsResponse,
} from "./crm-integrations";
import type { ApiResult } from "./result";

interface NativeProviderRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type LeadIntegrationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeProviderRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- Native lead capture integrations -------------------------- */

export interface LeadProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface LeadProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: LeadProviderField[];
  optional_settings?: LeadProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface LeadIntegration {
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

export interface LeadIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface LeadDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  cleanup_kind?: string;
  provider_scope_type?: string;
  provider_scope_id?: string;
  provider_webhook_id?: string;
  previous_provider_webhook_id?: string;
  endpoint?: string;
  deleted?: boolean;
  not_found?: boolean;
  skipped?: boolean;
  skip_reason?: string;
  cleanup_reason?: string;
  fields?: string[];
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface LeadDisconnectResponse {
  ok: boolean;
  provider_cleanup?: LeadDisconnectCleanupEvidence;
}

export interface LeadSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  submissions_seen: number;
  subscribers_upserted: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export function createLeadIntegrationsApi(request: LeadIntegrationsRequester) {
  return {
    providers(): Promise<ApiResult<{ items: LeadProviderSpec[] }>> {
      return request<{ items: LeadProviderSpec[] }>(
        "/api/v1/lead-integrations/providers",
      );
    },
    list(): Promise<ApiResult<{ items: LeadIntegration[] }>> {
      return request<{ items: LeadIntegration[] }>("/api/v1/lead-integrations");
    },
    create(input: LeadIntegrationInput): Promise<ApiResult<LeadIntegration>> {
      return request<LeadIntegration>("/api/v1/lead-integrations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    sync(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<LeadSyncSummary>> {
      return request<LeadSyncSummary>(
        `/api/v1/lead-integrations/${encodeURIComponent(id)}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    backfill(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<LeadSyncSummary>> {
      return request<LeadSyncSummary>(
        `/api/v1/lead-integrations/${encodeURIComponent(id)}/backfill`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    ingest(
      id: string,
      input: Record<string, unknown>,
    ): Promise<ApiResult<NativeIntegrationIngestSummary>> {
      return request<NativeIntegrationIngestSummary>(
        `/api/v1/lead-integrations/${encodeURIComponent(id)}/ingest`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    pause(id: string): Promise<ApiResult<LeadIntegration>> {
      return request<LeadIntegration>(
        `/api/v1/lead-integrations/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
    },
    disconnect(id: string): Promise<ApiResult<LeadDisconnectResponse>> {
      return request<LeadDisconnectResponse>(
        `/api/v1/lead-integrations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    runs(
      id: string,
      limit = 25,
    ): Promise<ApiResult<NativeIntegrationRunsResponse>> {
      return request<NativeIntegrationRunsResponse>(
        `/api/v1/lead-integrations/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`,
      );
    },
  };
}
