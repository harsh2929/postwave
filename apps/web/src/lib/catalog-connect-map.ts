// SPDX-License-Identifier: AGPL-3.0-only
//
// catalog-connect-map.ts — maps a catalog item's category to the owning-surface
// client that actually creates/connects integrations. The catalog facade itself
// only delegates; real credential writes go to these surfaces. CRM is adapted
// into the SurfaceClient shape (it carries extra managed-OAuth helpers).

import { crmApi } from "./crm-api";
import { api } from "./api";
import { SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE } from "./support-integration-operational-availability";
import {
  connectSupportIntegration,
  listSupportProviders,
  type SupportIntegration,
  type SupportIntegrationInput,
  type SupportProviderSpec,
} from "./support-integrations-api";
import {
  analyticsSurfaceApi,
  loyaltySurfaceApi,
  marketingSurfaceApi,
  reviewSurfaceApi,
  subscriptionSurfaceApi,
  type ProviderSpec,
  type SurfaceClient,
  type SurfaceIntegration,
} from "./integrations-surface-api";

// CRM's client predates the generic factory and lives at /api/v1/crm/* (not
// /api/v1/crm-integrations). Adapt it to the common contract; its create()
// requires a credentials_ref, so default it for the OAuth path.
const crmSurface: SurfaceClient = {
  providers: (options) => crmApi.providers(options) as Promise<ProviderSpec[]>,
  list: (options) => crmApi.list(options) as Promise<SurfaceIntegration[]>,
  create: (input, options) =>
    crmApi.create(
      {
        provider: input.provider,
        name: input.name,
        status: input.status,
        scopes: input.scopes,
        credentials_ref: input.credentials_ref ?? "",
        settings: input.settings,
      },
      options,
    ) as Promise<SurfaceIntegration>,
  sync: (id, options) => crmApi.sync(id, options),
  pause: (id, options) => crmApi.pause(id, options),
  disconnect: (id, options) => crmApi.disconnect(id, options),
  oauthAvailability: (provider, options) =>
    crmApi.oauthAvailability(provider, options),
  oauthStartUrl: (provider) => crmApi.oauthStartUrl(provider),
};

const commerceSurface: SurfaceClient = {
  providers: async (options) => {
    const res = await api.get<{ items: ProviderSpec[] }>(
      "/api/v1/commerce/providers",
      { ...options, requireOnline: true, maxAttempts: 1 },
    );
    return res.items;
  },
  list: async (options) => {
    const rows = await api.get<
      Array<
        Omit<SurfaceIntegration, "name"> & {
          name?: string;
          shop_domain?: string;
        }
      >
    >("/api/v1/commerce/integrations", {
      ...options,
      requireOnline: true,
      maxAttempts: 1,
    });
    return rows.map((row) => ({
      ...row,
      name: row.name || row.shop_domain || row.provider,
    }));
  },
  create: (input, options) =>
    api.post<SurfaceIntegration>(
      "/api/v1/commerce/integrations",
      {
        provider: input.provider,
        status: input.status,
        scopes: input.scopes,
        shop_domain: stringSetting(input.settings, "shop_domain"),
        settings: input.settings,
        credential_ref: input.credentials_ref,
      },
      { ...options, requireOnline: true, maxAttempts: 1 },
    ),
  sync: (id, options) =>
    api.post(
      `/api/v1/commerce/integrations/${encodeURIComponent(id)}/sync`,
      {},
      { ...options, requireOnline: true, maxAttempts: 1 },
    ),
  pause: (id, options) =>
    api.post(
      `/api/v1/commerce/integrations/${encodeURIComponent(id)}/pause`,
      {},
      { ...options, requireOnline: true, maxAttempts: 1 },
    ),
  disconnect: (id, options) =>
    api.delete(`/api/v1/commerce/integrations/${encodeURIComponent(id)}`, {
      ...options,
      requireOnline: true,
      maxAttempts: 1,
    }),
};

function stringSetting(
  settings: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const raw = settings?.[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export interface CatalogSurface {
  /** owning-surface key (used for labels / routing) */
  key: string;
  label: string;
  client: SurfaceClient;
  /**
   * sync_model marking this surface as webhook-ingest-capable for ANY provider
   * (the backend ProvisionIngest accepts any sanitized slug). When set, the
   * catalog detail route gives a non-curated/long-tail provider an ingest spec
   * so ConnectPanel offers the "Provision ingest endpoint" flow instead of the
   * credential form (which 422s for an unknown provider). Omitted for crm
   * (OAuth/credentials) and analytics (per-provider CDP token keys — its
   * ProvisionIngest rejects unknown providers, so it must stay on credentials).
   */
  ingestSyncModel?: string;
}

// Catalog category keys are defined in apps/api/internal/integrations/catalog.go.
const CATEGORY_TO_SURFACE: Record<string, CatalogSurface> = {
  crm: { key: "crm", label: "CRM", client: crmSurface },
  reviews: {
    key: "review",
    label: "Reviews",
    client: reviewSurfaceApi,
    ingestSyncModel: "postwave_review_ingest",
  },
  loyalty: {
    key: "loyalty",
    label: "Loyalty",
    client: loyaltySurfaceApi,
    ingestSyncModel: "postwave_loyalty_ingest",
  },
  subscriptions: {
    key: "subscription",
    label: "Subscriptions",
    client: subscriptionSurfaceApi,
    ingestSyncModel: "postwave_subscription_ingest",
  },
  analytics: {
    key: "analytics",
    label: "Analytics",
    client: analyticsSurfaceApi,
  },
  marketing: {
    key: "marketing",
    label: "Marketing",
    client: marketingSurfaceApi,
  },
  // payments / events (webinars) / cms tools land as profile + event via the
  // generic analytics webhook ingest (any provider). Route them to the analytics
  // surface with the generic ingest sync_model so ConnectPanel offers provisioning.
  payments: {
    key: "analytics",
    label: "Payments",
    client: analyticsSurfaceApi,
    ingestSyncModel: "postwave_analytics_ingest",
  },
  events: {
    key: "analytics",
    label: "Events",
    client: analyticsSurfaceApi,
    ingestSyncModel: "postwave_analytics_ingest",
  },
  cms: {
    key: "analytics",
    label: "CMS",
    client: analyticsSurfaceApi,
    ingestSyncModel: "postwave_analytics_ingest",
  },
};

export function surfaceForCategory(category: string): CatalogSurface | null {
  return CATEGORY_TO_SURFACE[category] ?? null;
}

/**
 * A category whose connect verb exists on web but is release-held. It never
 * becomes a CatalogSurface (the spec-driven ConnectPanel would offer live
 * lifecycle verbs); instead the detail route mounts the named dialog, which
 * renders desktop's held control with the reason and the static catalog.
 */
export interface HeldConnectSurface {
  key: string;
  label: string;
  holdCode: string;
  /** Component under src/components/integrations that renders the verb. */
  dialog: "SupportProviderConnectDialog";
  providers: (signal?: AbortSignal) => Promise<SupportProviderSpec[]>;
  connect: (
    input: SupportIntegrationInput,
    options?: { signal?: AbortSignal },
  ) => Promise<SupportIntegration>;
}

const HELD_CATEGORY_CONNECT: Record<string, HeldConnectSurface> = {
  // Desktop parity platform-91: customer_service rows resolve to the support
  // connect dialog, whose submit stays disabled with the hold reason until
  // SUPPORT_INTEGRATION_RUNTIME_AVAILABLE is qualified.
  customer_service: {
    key: "support",
    label: "Support",
    holdCode: SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
    dialog: "SupportProviderConnectDialog",
    providers: listSupportProviders,
    connect: connectSupportIntegration,
  },
};

export function heldConnectSurfaceForCatalogItem(item: {
  category: string;
}): HeldConnectSurface | null {
  return HELD_CATEGORY_CONNECT[item.category] ?? null;
}

export function surfaceForCatalogItem(item: {
  category: string;
  sources?: string[];
}): CatalogSurface | null {
  // Support-provider runtime is release-held. Catalog rows remain discoverable,
  // but must never be routed through commerce or a generic ingest surface;
  // they resolve through heldConnectSurfaceForCatalogItem instead.
  if (item.category === "customer_service") return null;
  if (item.sources?.includes("commerce")) {
    return { key: "commerce", label: "Commerce", client: commerceSurface };
  }
  return surfaceForCategory(item.category);
}

export function isConnectableCatalogItem(item: {
  category: string;
  sources?: string[];
}): boolean {
  return surfaceForCatalogItem(item) !== null;
}

export function isConnectableCategory(category: string): boolean {
  return category in CATEGORY_TO_SURFACE;
}

// INTG-029: shared provider-matching helpers + the deduped fan-out roster for
// the "Your integrations" connected view. Kept React-free so they stay
// unit-testable and importable from the pure hook/filter layer.

/**
 * Canonical provider/slug key: lowercase, strip non-alphanumerics. Mirrors the
 * catalog detail route's private normalize so the catalog (keyed by item.slug)
 * and a surface's connections (keyed by integration.provider) join reliably.
 */
export function normalizeProvider(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when two provider/slug strings refer to the same integration. */
export function providersMatch(a: string, b: string): boolean {
  return a === b || normalizeProvider(a) === normalizeProvider(b);
}

export interface SurfaceListClient {
  key: string;
  client: SurfaceClient;
}

/**
 * Every distinct connectable surface list()-client, deduped by client object
 * identity (analytics/payments/events/cms all share one client) plus commerce
 * (which is never in CATEGORY_TO_SURFACE). Exactly 7 entries. Deduping is
 * essential — without it /api/v1/analytics-integrations would fire 4× and
 * commerce connections would never appear. Used by useConnectedIntegrations.
 */
export const CONNECTABLE_SURFACE_CLIENTS: SurfaceListClient[] = (() => {
  const out: SurfaceListClient[] = [];
  const seen = new Set<SurfaceClient>();
  for (const surface of Object.values(CATEGORY_TO_SURFACE)) {
    if (seen.has(surface.client)) continue;
    seen.add(surface.client);
    out.push({ key: surface.key, client: surface.client });
  }
  out.push({ key: "commerce", client: commerceSurface });
  return out;
})();
