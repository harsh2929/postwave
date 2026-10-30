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

type SubscriptionIntegrationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeProviderRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- Native subscription and shipping integrations ------------- */

export interface SubscriptionProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface SubscriptionProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: SubscriptionProviderField[];
  optional_settings?: SubscriptionProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface SubscriptionIntegration {
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

export interface SubscriptionIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface SubscriptionDisconnectCleanupEvidence {
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
  provider_webhook_id?: string;
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  tokenized_ingest_token_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface SubscriptionDisconnectResponse {
  ok: boolean;
  provider_cleanup?: SubscriptionDisconnectCleanupEvidence;
}

export interface SubscriptionProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export interface SubscriptionSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  subscriptions_seen: number;
  subscriptions_upserted: number;
  shipments_seen: number;
  shipments_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export function createSubscriptionIntegrationsApi(
  request: SubscriptionIntegrationsRequester,
) {
  return {
    providers(): Promise<ApiResult<{ items: SubscriptionProviderSpec[] }>> {
      return request<{ items: SubscriptionProviderSpec[] }>(
        "/api/v1/subscription-integrations/providers",
      );
    },
    list(): Promise<ApiResult<{ items: SubscriptionIntegration[] }>> {
      return request<{ items: SubscriptionIntegration[] }>(
        "/api/v1/subscription-integrations",
      );
    },
    create(
      input: SubscriptionIntegrationInput,
    ): Promise<ApiResult<SubscriptionIntegration>> {
      return request<SubscriptionIntegration>(
        "/api/v1/subscription-integrations",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
    },
    sync(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<SubscriptionSyncSummary>> {
      return request<SubscriptionSyncSummary>(
        `/api/v1/subscription-integrations/${encodeURIComponent(id)}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    backfill(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<SubscriptionSyncSummary>> {
      return request<SubscriptionSyncSummary>(
        `/api/v1/subscription-integrations/${encodeURIComponent(id)}/backfill`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    ingest(
      id: string,
      input: Record<string, unknown>,
    ): Promise<ApiResult<NativeIntegrationIngestSummary>> {
      return request<NativeIntegrationIngestSummary>(
        `/api/v1/subscription-integrations/${encodeURIComponent(id)}/ingest`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    pause(id: string): Promise<ApiResult<SubscriptionIntegration>> {
      return request<SubscriptionIntegration>(
        `/api/v1/subscription-integrations/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
    },
    disconnect(id: string): Promise<ApiResult<SubscriptionDisconnectResponse>> {
      return request<SubscriptionDisconnectResponse>(
        `/api/v1/subscription-integrations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    acknowledgeProviderCleanup(
      id: string,
      input: SubscriptionProviderCleanupAcknowledgementInput,
    ): Promise<ApiResult<SubscriptionDisconnectResponse>> {
      return request<SubscriptionDisconnectResponse>(
        `/api/v1/subscription-integrations/${encodeURIComponent(id)}/provider-cleanup/acknowledge`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    runs(
      id: string,
      limit = 25,
    ): Promise<ApiResult<NativeIntegrationRunsResponse>> {
      return request<NativeIntegrationRunsResponse>(
        `/api/v1/subscription-integrations/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`,
      );
    },
  };
}
