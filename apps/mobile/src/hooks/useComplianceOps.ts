/**
 * hooks/useComplianceOps.ts — the DSAR clock and the maintenance banner.
 *
 * Both are admin reads with no writes attached, so unlike the rest of this
 * program's additions they are ordinary cached queries. They still do NOT
 * retry: a workspace with no SAR history or no maintenance schedule answers
 * 4xx, and that answer will not change on a second attempt.
 */
import { useQuery } from "@tanstack/react-query";

import {
  listMaintenanceWindows,
  listSarRequests,
} from "@/api/complianceOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type {
  MaintenanceWindowLike,
  SarRequestLike,
} from "@/lib/complianceOps";

export function useSarRequests() {
  const gate = useOnlineQueryGate();
  // Both routes are ScopeAdmin server-side. Gating the query rather than
  // discovering the boundary through a 403 keeps a viewer's screen free of an
  // error they can do nothing about.
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery({
    queryKey: ["sar-requests", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead,
    staleTime: 60_000,
    retry: false,
    queryFn: (): Promise<SarRequestLike[]> => listSarRequests(),
  });
}

export function useMaintenanceWindows() {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery({
    queryKey: ["maintenance-windows", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead,
    // Shorter than the DSAR queue: a window opening is the thing this exists to
    // catch, and a five-minute-stale "no maintenance" is the wrong answer at
    // exactly the moment it matters.
    staleTime: 30_000,
    retry: false,
    queryFn: (): Promise<MaintenanceWindowLike[]> => listMaintenanceWindows(),
  });
}
