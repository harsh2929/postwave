// SPDX-License-Identifier: AGPL-3.0-only
//
// CRM integrations lifecycle client. Mirrors the desktop full-lifecycle UI;
// web previously had status-only commerce. Backend routes
// (apps/api/internal/crm_integrations/handlers.go::MountRoutes):
//
//   GET    /api/v1/crm/providers                       (admin) provider specs
//   GET    /api/v1/crm/integrations                    (admin) list
//   POST   /api/v1/crm/integrations                    (admin) create/connect
//   GET    /api/v1/crm/integrations/{id}               (admin)
//   POST   /api/v1/crm/integrations/{id}/sync          (admin)
//   POST   /api/v1/crm/integrations/{id}/pause         (admin)
//   DELETE /api/v1/crm/integrations/{id}               (admin) disconnect
//   GET    /api/v1/crm/integrations/{id}/runs          (admin)
//   GET    /api/v1/crm/{provider}/oauth/availability   (read)
//   GET    /api/v1/crm/{provider}/oauth/start          (admin) -> redirect
//
// Managed OAuth providers (hubspot/salesforce/pipedrive/…) are connected by
// sending the operator to the server's /oauth/start endpoint (a 302 to the
// provider). Vault-ref providers are created with a credentials_ref.

import { api } from "./api";

export interface CrmProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface CrmProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  capabilities: string[];
  required_settings: CrmProviderField[];
  optional_settings?: CrmProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface CrmIntegration {
  id: string;
  tenant_id?: string;
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

export interface CrmIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref: string;
  settings?: Record<string, unknown>;
}

interface ItemsEnvelope<T> {
  items: T[];
}

export interface CrmRequestOptions {
  signal?: AbortSignal;
}

function readOptions(options?: CrmRequestOptions) {
  return { ...options, requireOnline: true, maxAttempts: 1 };
}

function writeOptions(options?: CrmRequestOptions) {
  return { ...options, requireOnline: true, maxAttempts: 1 };
}

/** OAuth availability — whether managed OAuth is configured server-side. */
export interface CrmOAuthAvailability {
  available: boolean;
  configured?: boolean;
  requires_session?: boolean;
  start_url?: string;
}

interface CrmOAuthAvailabilityWire {
  available?: boolean;
  configured?: boolean;
  requires_session?: boolean;
  start_url?: string;
}

export function normalizeCrmOAuthAvailability(
  raw: CrmOAuthAvailabilityWire,
): CrmOAuthAvailability {
  return {
    ...raw,
    available: raw.available ?? raw.configured ?? true,
  };
}

export const crmApi = {
  providers: (options?: CrmRequestOptions): Promise<CrmProviderSpec[]> =>
    api
      .get<
        ItemsEnvelope<CrmProviderSpec>
      >("/api/v1/crm/providers", readOptions(options))
      .then((r) => (Array.isArray(r.items) ? r.items : [])),

  list: (options?: CrmRequestOptions): Promise<CrmIntegration[]> =>
    api
      .get<
        ItemsEnvelope<CrmIntegration>
      >("/api/v1/crm/integrations", readOptions(options))
      .then((r) => (Array.isArray(r.items) ? r.items : [])),

  create: (
    input: CrmIntegrationInput,
    options?: CrmRequestOptions,
  ): Promise<CrmIntegration> =>
    api.post<CrmIntegration>(
      "/api/v1/crm/integrations",
      input,
      writeOptions(options),
    ),

  sync: (id: string, options?: CrmRequestOptions): Promise<unknown> =>
    api.post<unknown>(
      `/api/v1/crm/integrations/${encodeURIComponent(id)}/sync`,
      {},
      writeOptions(options),
    ),

  pause: (id: string, options?: CrmRequestOptions): Promise<unknown> =>
    api.post<unknown>(
      `/api/v1/crm/integrations/${encodeURIComponent(id)}/pause`,
      {},
      writeOptions(options),
    ),

  resume: (id: string, options?: CrmRequestOptions): Promise<unknown> =>
    api.post<unknown>(
      `/api/v1/crm/integrations/${encodeURIComponent(id)}/resume`,
      {},
      writeOptions(options),
    ),

  disconnect: (id: string, options?: CrmRequestOptions): Promise<unknown> =>
    api.delete<unknown>(
      `/api/v1/crm/integrations/${encodeURIComponent(id)}`,
      writeOptions(options),
    ),

  oauthAvailability: (
    provider: string,
    options?: CrmRequestOptions,
  ): Promise<CrmOAuthAvailability> =>
    api
      .get<CrmOAuthAvailabilityWire>(
        `/api/v1/crm/${encodeURIComponent(provider)}/oauth/availability`,
        readOptions(options),
      )
      .then(normalizeCrmOAuthAvailability),

  /**
   * Absolute URL the browser navigates to in order to start managed OAuth.
   * The server endpoint 302-redirects to the provider's consent screen, so we
   * send the operator there with a full-page navigation (not fetch).
   */
  oauthStartUrl: (provider: string): string => {
    return `/api/v1/crm/${encodeURIComponent(provider)}/oauth/start`;
  },
};
