/**
 * hooks/useIntegrationsEcosystem.ts — coverage / readiness / curated stacks.
 *
 * ONE REPORT AT A TIME. The panel is a three-way segmented control and each
 * hook takes the tab it belongs to as `wanted`, so opening the section fetches
 * one report rather than three. All three are recomputed server-side from the
 * whole catalog on every call, and the register's own note on this row is that
 * their value on a phone is reference material — not a reason to spend three
 * round trips before the reader has chosen one.
 *
 * ROLE-GATED on admin (the manifest's reviewed value) as well as online-gated:
 * a viewer's 403 would otherwise render as an ecosystem with no coverage.
 *
 * STALENESS is an hour, for the same reason the catalog's is: the reports are
 * derived from Go source plus release holds, so they change with a deploy.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchIntegrationsCoverage,
  fetchIntegrationsReadiness,
  fetchIntegrationsStacks,
} from "@/api/integrationsEcosystem";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  CoverageView,
  ReadinessView,
  StacksView,
} from "@/lib/integrationsEcosystem";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const REPORT_STALE_MS = 3_600_000;

function useReportGate(wanted: boolean) {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return {
    tenantId: gate.tenantId,
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead && wanted,
  };
}

export function useIntegrationsCoverage(wanted: boolean) {
  const { tenantId, enabled } = useReportGate(wanted);
  return useQuery<CoverageView>({
    queryKey: ["integrations", "coverage", tenantId],
    enabled,
    staleTime: REPORT_STALE_MS,
    queryFn: fetchIntegrationsCoverage,
  });
}

export function useIntegrationsReadiness(wanted: boolean) {
  const { tenantId, enabled } = useReportGate(wanted);
  return useQuery<ReadinessView>({
    queryKey: ["integrations", "readiness", tenantId],
    enabled,
    staleTime: REPORT_STALE_MS,
    queryFn: fetchIntegrationsReadiness,
  });
}

export function useIntegrationsStacks(wanted: boolean) {
  const { tenantId, enabled } = useReportGate(wanted);
  return useQuery<StacksView>({
    queryKey: ["integrations", "stacks", tenantId],
    enabled,
    staleTime: REPORT_STALE_MS,
    queryFn: fetchIntegrationsStacks,
  });
}
