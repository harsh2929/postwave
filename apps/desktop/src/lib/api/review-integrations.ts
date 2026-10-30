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

type ReviewIntegrationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeProviderRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- Native review integrations -------------------------------- */

export interface ReviewProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface ReviewProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: ReviewProviderField[];
  optional_settings?: ReviewProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface ReviewIntegration {
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

export interface ReviewIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface ReviewDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  completed_actions?: string[];
  operator_notes?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  tokenized_ingest_token_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface ReviewDisconnectResponse {
  ok: boolean;
  provider_cleanup?: ReviewDisconnectCleanupEvidence;
}

export interface ReviewProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export interface ReviewSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  reviews_seen: number;
  reviews_imported: number;
  profiles_upserted: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export function createReviewIntegrationsApi(
  request: ReviewIntegrationsRequester,
) {
  return {
    providers(): Promise<ApiResult<{ items: ReviewProviderSpec[] }>> {
      return request<{ items: ReviewProviderSpec[] }>(
        "/api/v1/review-integrations/providers",
      );
    },
    list(): Promise<ApiResult<{ items: ReviewIntegration[] }>> {
      return request<{ items: ReviewIntegration[] }>(
        "/api/v1/review-integrations",
      );
    },
    create(
      input: ReviewIntegrationInput,
    ): Promise<ApiResult<ReviewIntegration>> {
      return request<ReviewIntegration>("/api/v1/review-integrations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    sync(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<ReviewSyncSummary>> {
      return request<ReviewSyncSummary>(
        `/api/v1/review-integrations/${encodeURIComponent(id)}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    backfill(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<ReviewSyncSummary>> {
      return request<ReviewSyncSummary>(
        `/api/v1/review-integrations/${encodeURIComponent(id)}/backfill`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    ingest(
      id: string,
      input: Record<string, unknown>,
    ): Promise<ApiResult<NativeIntegrationIngestSummary>> {
      return request<NativeIntegrationIngestSummary>(
        `/api/v1/review-integrations/${encodeURIComponent(id)}/ingest`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    pause(id: string): Promise<ApiResult<ReviewIntegration>> {
      return request<ReviewIntegration>(
        `/api/v1/review-integrations/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
    },
    disconnect(id: string): Promise<ApiResult<ReviewDisconnectResponse>> {
      return request<ReviewDisconnectResponse>(
        `/api/v1/review-integrations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    acknowledgeProviderCleanup(
      id: string,
      input: ReviewProviderCleanupAcknowledgementInput,
    ): Promise<ApiResult<ReviewDisconnectResponse>> {
      return request<ReviewDisconnectResponse>(
        `/api/v1/review-integrations/${encodeURIComponent(id)}/provider-cleanup/acknowledge`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    runs(
      id: string,
      limit = 25,
    ): Promise<ApiResult<NativeIntegrationRunsResponse>> {
      return request<NativeIntegrationRunsResponse>(
        `/api/v1/review-integrations/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`,
      );
    },
  };
}
