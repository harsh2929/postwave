// SPDX-License-Identifier: AGPL-3.0-only
//
// integrations-surface-api.ts — one generic client for every owning-surface
// integration API. The active land-only surfaces (review / loyalty /
// subscription / analytics) expose a byte-identical webhook-ingest contract.
// Marketing exposes only the common provider/integration lifecycle: it has no
// generic webhook-ingest routes. Keep those factories separate so a future
// surface cannot accidentally acquire callable methods for unmounted routes.
// CRM keeps its own client (crm-api.ts) because it adds managed-OAuth helpers;
// catalog-connect-map.ts adapts it into the same SurfaceClient shape.

import { api } from "./api";

export type AuthMode =
  | "oauth"
  | "oauth_ref"
  | "api_key"
  | "api_key_ref"
  | "api_token_ref"
  | "api_signature_ref"
  | "write_key_ref"
  | "project_token_ref"
  | string;

export interface ProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface ProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: AuthMode;
  managed: boolean;
  runtime_status: string;
  /** "postwave_*_ingest" marks a webhook-ingest (push-only) provider. */
  sync_model?: string;
  capabilities: string[];
  required_settings: ProviderField[];
  optional_settings?: ProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface SurfaceIntegration {
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

export interface IntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface IngestProviderOption {
  provider: string;
  name: string;
  category: string;
  push_only: boolean;
  docs_url?: string;
}

export interface IngestEndpoint {
  integration_id: string;
  provider: string;
  provider_name: string;
  name: string;
  status: string;
  push_only?: boolean;
  ingest_path: string;
  ingest_url?: string;
  ingest_token: string;
  created_at: string;
  updated_at: string;
}

interface ItemsEnvelope<T> {
  items: T[];
}

/**
 * Common surface contract the connect router programs against. CRM satisfies
 * the core; the ingest-* methods exist only on surfaces that mount generic
 * webhook provisioning (review / loyalty / subscription / analytics).
 */
export interface SurfaceClient {
  providers(options?: SurfaceRequestOptions): Promise<ProviderSpec[]>;
  list(options?: SurfaceRequestOptions): Promise<SurfaceIntegration[]>;
  create(
    input: IntegrationInput,
    options?: SurfaceRequestOptions,
  ): Promise<SurfaceIntegration>;
  sync(id: string, options?: SurfaceRequestOptions): Promise<unknown>;
  pause(id: string, options?: SurfaceRequestOptions): Promise<unknown>;
  disconnect(id: string, options?: SurfaceRequestOptions): Promise<unknown>;
  oauthAvailability?: (
    provider: string,
    options?: SurfaceRequestOptions,
  ) => Promise<OAuthAvailability>;
  oauthStartUrl?: (provider: string) => string;
  ingestProviders?: (
    options?: SurfaceRequestOptions,
  ) => Promise<IngestProviderOption[]>;
  ingestEndpoints?: (
    options?: SurfaceRequestOptions,
  ) => Promise<IngestEndpoint[]>;
  provisionIngest?: (
    body: { provider: string; name?: string },
    options?: SurfaceRequestOptions,
  ) => Promise<IngestEndpoint>;
  rotateIngest?: (
    id: string,
    options?: SurfaceRequestOptions,
  ) => Promise<IngestEndpoint>;
}

export interface SurfaceRequestOptions {
  signal?: AbortSignal;
}

export interface OAuthAvailability {
  available?: boolean;
  configured?: boolean;
  requires_session?: boolean;
  start_url?: string;
}

export function managedOAuthAvailable(
  availability: OAuthAvailability,
): boolean {
  return availability.available ?? availability.configured ?? true;
}

type IntegrationSurfaceBase =
  | "/api/v1/review-integrations"
  | "/api/v1/loyalty-integrations"
  | "/api/v1/subscription-integrations"
  | "/api/v1/analytics-integrations"
  | "/api/v1/marketing-integrations";

type IngestIntegrationSurfaceBase = Exclude<
  IntegrationSurfaceBase,
  "/api/v1/marketing-integrations"
>;

function makeIntegrationSurfaceApi(
  base: IntegrationSurfaceBase,
): SurfaceClient {
  const readOptions = (options?: SurfaceRequestOptions) => ({
    ...options,
    requireOnline: true,
    maxAttempts: 1,
  });
  const writeOptions = (options?: SurfaceRequestOptions) => ({
    ...options,
    requireOnline: true,
    maxAttempts: 1,
  });
  return {
    providers: (options) =>
      api
        .get<
          ItemsEnvelope<ProviderSpec>
        >(`${base}/providers`, readOptions(options))
        .then((r) => (Array.isArray(r.items) ? r.items : [])),
    list: (options) =>
      api
        .get<ItemsEnvelope<SurfaceIntegration>>(base, readOptions(options))
        .then((r) => (Array.isArray(r.items) ? r.items : [])),
    create: (input, options) =>
      api.post<SurfaceIntegration>(base, input, writeOptions(options)),
    sync: (id, options) =>
      api.post(
        `${base}/${encodeURIComponent(id)}/sync`,
        {},
        writeOptions(options),
      ),
    pause: (id, options) =>
      api.post(
        `${base}/${encodeURIComponent(id)}/pause`,
        {},
        writeOptions(options),
      ),
    disconnect: (id, options) =>
      api.delete(`${base}/${encodeURIComponent(id)}`, writeOptions(options)),
  };
}

function makeIngestIntegrationSurfaceApi(
  base: IngestIntegrationSurfaceBase,
): SurfaceClient {
  return {
    ...makeIntegrationSurfaceApi(base),
    ingestProviders: (options) =>
      api
        .get<ItemsEnvelope<IngestProviderOption>>(
          `${base}/webhook-ingest/providers`,
          {
            ...options,
            requireOnline: true,
            maxAttempts: 1,
          },
        )
        .then((r) => (Array.isArray(r.items) ? r.items : [])),
    ingestEndpoints: (options) =>
      api
        .get<ItemsEnvelope<IngestEndpoint>>(`${base}/webhook-ingest`, {
          ...options,
          requireOnline: true,
          maxAttempts: 1,
        })
        .then((r) => (Array.isArray(r.items) ? r.items : [])),
    provisionIngest: (body, options) =>
      api.post<IngestEndpoint>(`${base}/webhook-ingest`, body, {
        ...options,
        requireOnline: true,
        maxAttempts: 1,
      }),
    rotateIngest: (id, options) =>
      api.post<IngestEndpoint>(
        `${base}/webhook-ingest/${encodeURIComponent(id)}/rotate`,
        {},
        { ...options, requireOnline: true, maxAttempts: 1 },
      ),
  };
}

export const reviewSurfaceApi = makeIngestIntegrationSurfaceApi(
  "/api/v1/review-integrations",
);
export const loyaltySurfaceApi = makeIngestIntegrationSurfaceApi(
  "/api/v1/loyalty-integrations",
);
export const subscriptionSurfaceApi = makeIngestIntegrationSurfaceApi(
  "/api/v1/subscription-integrations",
);
export const analyticsSurfaceApi = makeIngestIntegrationSurfaceApi(
  "/api/v1/analytics-integrations",
);
export const marketingSurfaceApi = makeIntegrationSurfaceApi(
  "/api/v1/marketing-integrations",
);

/** True when the provider connects via webhook ingest rather than an outbound pull. */
export function isIngestSpec(spec: Pick<ProviderSpec, "sync_model">): boolean {
  return (
    typeof spec.sync_model === "string" && spec.sync_model.endsWith("_ingest")
  );
}
