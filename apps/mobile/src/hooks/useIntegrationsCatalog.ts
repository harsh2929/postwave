/**
 * hooks/useIntegrationsCatalog.ts — TanStack wiring for the catalog browser.
 *
 * `wanted` is the section's expanded state. The catalog is ~614 rows and the
 * integrations screen answers its own question ("is anything failing?")
 * without them, so it is not fetched until the operator opens the browser —
 * and the screen's pull-to-refresh does not drag it down either.
 *
 * ROLE-GATED as well as online-gated: the route is admin in the manifest, so
 * asking as a viewer would spend a request on a guaranteed 403 and then render
 * an empty catalog, which reads as "there is nothing to connect".
 *
 * STALENESS is an hour. The catalog is assembled from Go source at request
 * time (integrations.CatalogItems) with no tenant input beyond release holds,
 * so it can only change with a deploy.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchIntegrationsCatalog } from "@/api/integrationsCatalog";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { IntegrationsCatalog } from "@/lib/integrationsCatalog";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const CATALOG_STALE_MS = 3_600_000;

export function useIntegrationsCatalog(wanted: boolean) {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery<IntegrationsCatalog>({
    queryKey: ["integrations", "catalog", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead && wanted,
    staleTime: CATALOG_STALE_MS,
    queryFn: fetchIntegrationsCatalog,
  });
}
