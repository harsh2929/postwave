// SPDX-License-Identifier: AGPL-3.0-only
//
// integrations-catalog-api.ts — typed client for the backend integrations
// catalog (GET /api/v1/integrations/catalog). Backend lives in
// apps/api/internal/integrations/{catalog,handlers}.go. This is the surface the
// dashboard "Integration catalog" page renders so the full native catalog is
// discoverable in-product (previously only the SDK/MCP/CLI consumed it).

import { api } from "./api";

export type IntegrationBadge =
  | "native"
  | "partner"
  | "zapier"
  | "webhook"
  | "api_sdk"
  | "migration_only"
  | "planned";

export type IntegrationRuntimeStatus =
  | "available"
  | "partial"
  | "delegated"
  | "planned";

export interface CatalogItem {
  slug: string;
  name: string;
  category: string;
  badge: IntegrationBadge;
  runtime_status: IntegrationRuntimeStatus;
  summary: string;
  capabilities: string[];
  docs_url?: string;
  setup_path?: string;
  native: boolean;
  featured?: boolean;
  phase?: string;
  sources?: string[];
}

export interface IntegrationCategoryRef {
  key: string;
  label: string;
}

export interface IntegrationsCatalog {
  schema_version: string;
  target_public_entries: number;
  target_native_managed: number;
  honest_badges: IntegrationBadge[];
  categories: IntegrationCategoryRef[];
  capabilities: string[];
  items: CatalogItem[];
  counts: Record<string, number>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Keep optional/nullable wire fields from taking down the 600+ item catalog.
 * Some legitimate catalog-only providers publish no capability list, encoded
 * by Go as `null`; the UI contract is the equivalent empty array.
 */
export function normalizeIntegrationsCatalog(
  catalog: IntegrationsCatalog,
): IntegrationsCatalog {
  return {
    ...catalog,
    honest_badges: stringArray(catalog.honest_badges) as IntegrationBadge[],
    categories: Array.isArray(catalog.categories)
      ? catalog.categories.filter(
          (category): category is IntegrationCategoryRef =>
            Boolean(category) &&
            typeof category.key === "string" &&
            typeof category.label === "string",
        )
      : [],
    capabilities: stringArray(catalog.capabilities),
    items: Array.isArray(catalog.items)
      ? catalog.items
          .filter(
            (item): item is CatalogItem =>
              Boolean(item) &&
              typeof item.slug === "string" &&
              typeof item.name === "string",
          )
          .map((item) => ({
            ...item,
            capabilities: stringArray(item.capabilities),
            ...(item.sources !== undefined
              ? { sources: stringArray(item.sources) }
              : {}),
          }))
      : [],
    counts:
      catalog.counts && typeof catalog.counts === "object"
        ? catalog.counts
        : {},
  };
}

export const integrationsCatalogApi = {
  get: (opts?: { signal?: AbortSignal }) =>
    api
      .get<IntegrationsCatalog>("/api/v1/integrations/catalog", {
        ...opts,
        // Catalog data is workspace/admin scoped. Never satisfy it from the
        // URL-only offline cache, and let an authority change abort the sole
        // transport attempt immediately.
        requireOnline: true,
        maxAttempts: 1,
      })
      .then(normalizeIntegrationsCatalog),
};

/** Maps a runtime status to a Badge variant for consistent, theme-aware tone. */
export function runtimeStatusTone(
  status: IntegrationRuntimeStatus,
): "success" | "warning" | "info" | "secondary" {
  switch (status) {
    case "available":
      return "success";
    case "partial":
      return "warning";
    case "delegated":
      return "info";
    default:
      return "secondary";
  }
}

/** Human label for a runtime status. */
export function runtimeStatusLabel(status: IntegrationRuntimeStatus): string {
  switch (status) {
    case "available":
      return "Available";
    case "partial":
      return "Partial";
    case "delegated":
      return "Delegated";
    default:
      return "Planned";
  }
}

/** Human label for an honesty badge. */
export function badgeLabel(badge: IntegrationBadge): string {
  switch (badge) {
    case "native":
      return "Native";
    case "partner":
      return "Partner";
    case "zapier":
      return "Zapier";
    case "webhook":
      return "Webhook";
    case "api_sdk":
      return "API / SDK";
    case "migration_only":
      return "Migration";
    default:
      return "Planned";
  }
}
