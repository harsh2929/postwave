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

type LoyaltyIntegrationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeProviderRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- Native loyalty integrations ------------------------------- */

export interface LoyaltyProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface LoyaltyProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  capabilities: string[];
  required_settings: LoyaltyProviderField[];
  optional_settings?: LoyaltyProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface LoyaltyIntegration {
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

export interface LoyaltyIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface LoyaltyDisconnectCleanupEvidence {
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
  account_id?: string;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface LoyaltyDisconnectResponse {
  ok: boolean;
  provider_cleanup?: LoyaltyDisconnectCleanupEvidence;
}

export interface LoyaltyProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export interface LoyaltySyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  members_seen: number;
  members_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export function createLoyaltyIntegrationsApi(
  request: LoyaltyIntegrationsRequester,
) {
  return {
    providers(): Promise<ApiResult<{ items: LoyaltyProviderSpec[] }>> {
      return request<{ items: LoyaltyProviderSpec[] }>(
        "/api/v1/loyalty-integrations/providers",
      );
    },
    list(): Promise<ApiResult<{ items: LoyaltyIntegration[] }>> {
      return request<{ items: LoyaltyIntegration[] }>(
        "/api/v1/loyalty-integrations",
      );
    },
    create(
      input: LoyaltyIntegrationInput,
    ): Promise<ApiResult<LoyaltyIntegration>> {
      return request<LoyaltyIntegration>("/api/v1/loyalty-integrations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    sync(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<LoyaltySyncSummary>> {
      return request<LoyaltySyncSummary>(
        `/api/v1/loyalty-integrations/${encodeURIComponent(id)}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    backfill(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<LoyaltySyncSummary>> {
      return request<LoyaltySyncSummary>(
        `/api/v1/loyalty-integrations/${encodeURIComponent(id)}/backfill`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    ingest(
      id: string,
      input: Record<string, unknown>,
    ): Promise<ApiResult<NativeIntegrationIngestSummary>> {
      return request<NativeIntegrationIngestSummary>(
        `/api/v1/loyalty-integrations/${encodeURIComponent(id)}/ingest`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    pause(id: string): Promise<ApiResult<LoyaltyIntegration>> {
      return request<LoyaltyIntegration>(
        `/api/v1/loyalty-integrations/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
    },
    disconnect(id: string): Promise<ApiResult<LoyaltyDisconnectResponse>> {
      return request<LoyaltyDisconnectResponse>(
        `/api/v1/loyalty-integrations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    acknowledgeProviderCleanup(
      id: string,
      input: LoyaltyProviderCleanupAcknowledgementInput,
    ): Promise<ApiResult<LoyaltyDisconnectResponse>> {
      return request<LoyaltyDisconnectResponse>(
        `/api/v1/loyalty-integrations/${encodeURIComponent(id)}/provider-cleanup/acknowledge`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    runs(
      id: string,
      limit = 25,
    ): Promise<ApiResult<NativeIntegrationRunsResponse>> {
      return request<NativeIntegrationRunsResponse>(
        `/api/v1/loyalty-integrations/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`,
      );
    },
  };
}
