import type { ApiResult } from "./result";

interface CrmRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type CrmRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: CrmRequestOptions,
) => Promise<ApiResult<T>>;

type ApiUrlBuilder = (path: string) => string;

export interface NativeIntegrationRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface NativeIntegrationRunsResponse {
  items: NativeIntegrationRun[];
}

export interface NativeIntegrationIngestSummary {
  integration_id?: string;
  run_id?: string;
  status: string;
  rows_failed?: number;
  error_message?: string;
  [key: string]: unknown;
}

export interface CRMProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface CRMProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: CRMProviderField[];
  optional_settings?: CRMProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface CRMIntegration {
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

export interface CRMIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface CRMSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  contacts_seen: number;
  contacts_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface CRMDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  endpoint?: string;
  provider_webhook_ids?: string[];
  deleted_provider_webhook_ids?: string[];
  oauth_revocation_status?: string;
  oauth_token_type?: string;
  oauth_revoked?: boolean;
  oauth_revocation_skipped?: boolean;
  oauth_revocation_skip_reason?: string;
  credential_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface CRMDisconnectResponse {
  ok: boolean;
  provider_cleanup?: CRMDisconnectCleanupEvidence;
  hubspot_oauth_revocation?: Record<string, unknown>;
  pipedrive_oauth_revocation?: Record<string, unknown>;
  salesforce_oauth_revocation?: Record<string, unknown>;
}

export interface CRMOAuthAvailability {
  available?: boolean;
  configured?: boolean;
  requires_session?: boolean;
  start_url?: string;
}

export function createCrmIntegrationsApi(
  request: CrmRequester,
  apiUrl: ApiUrlBuilder,
) {
  return {
    oauthAvailability(
      provider: string,
    ): Promise<ApiResult<CRMOAuthAvailability>> {
      return request<CRMOAuthAvailability>(
        `/api/v1/crm/${encodeURIComponent(provider)}/oauth/availability`,
      );
    },
    oauthStartUrl(
      provider: string,
      query: Record<string, string | number | boolean | null | undefined> = {},
    ): string {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        params.set(key, String(value));
      }
      const encoded = params.toString();
      return apiUrl(
        `/api/v1/crm/${encodeURIComponent(provider)}/oauth/start${encoded ? `?${encoded}` : ""}`,
      );
    },
    providers(): Promise<ApiResult<{ items: CRMProviderSpec[] }>> {
      return request<{ items: CRMProviderSpec[] }>("/api/v1/crm/providers");
    },
    list(): Promise<ApiResult<{ items: CRMIntegration[] }>> {
      return request<{ items: CRMIntegration[] }>("/api/v1/crm/integrations");
    },
    create(input: CRMIntegrationInput): Promise<ApiResult<CRMIntegration>> {
      return request<CRMIntegration>("/api/v1/crm/integrations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    sync(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<CRMSyncSummary>> {
      return request<CRMSyncSummary>(
        `/api/v1/crm/integrations/${encodeURIComponent(id)}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    backfill(
      id: string,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<CRMSyncSummary>> {
      return request<CRMSyncSummary>(
        `/api/v1/crm/integrations/${encodeURIComponent(id)}/backfill`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    pause(id: string): Promise<ApiResult<CRMIntegration>> {
      return request<CRMIntegration>(
        `/api/v1/crm/integrations/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
    },
    disconnect(id: string): Promise<ApiResult<CRMDisconnectResponse>> {
      return request<CRMDisconnectResponse>(
        `/api/v1/crm/integrations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    runs(
      id: string,
      limit = 25,
    ): Promise<ApiResult<NativeIntegrationRunsResponse>> {
      return request<NativeIntegrationRunsResponse>(
        `/api/v1/crm/integrations/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`,
      );
    },
  };
}
