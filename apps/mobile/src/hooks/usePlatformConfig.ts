/**
 * hooks/usePlatformConfig.ts — the four read queries behind the Settings
 * screen's "Platform configuration" card.
 *
 * All four follow the same policy, which is why they share a file:
 *  - gated by useOnlineQueryGate, per the app's offline-first rule;
 *  - a long staleTime, because these are configuration surfaces that change
 *    on the order of months, not a live feed;
 *  - NO retry on a hidden status. A 403/404/501 is a final answer about
 *    entitlement or deployment, so retrying it twice only delays hiding the
 *    row (the same reasoning as useQuery in SecurityPolicySection).
 */
import { useQuery } from "@tanstack/react-query";

import {
  getFeatureFlags,
  getFirewallSettings,
  getIdentifierTransforms,
  getTenantRegion,
  PlatformConfigError,
} from "@/api/platformConfig";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isPlatformSurfaceHidden } from "@/lib/platformConfig";

/** Configuration, not telemetry — five minutes is already generous. */
const STALE_MS = 5 * 60_000;

/** True when the error means "this reader may not see it" / "not deployed". */
export function isHiddenPlatformError(error: unknown): boolean {
  return (
    error instanceof PlatformConfigError &&
    isPlatformSurfaceHidden(error.status)
  );
}

function retryPolicy(count: number, error: unknown): boolean {
  return !isHiddenPlatformError(error) && count < 2;
}

export function useTenantRegionQuery() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-tenant-region", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    retry: retryPolicy,
    queryFn: getTenantRegion,
  });
}

export function useFeatureFlagsQuery() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-feature-flags", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    retry: retryPolicy,
    queryFn: getFeatureFlags,
  });
}

export function useFirewallSettingsQuery() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-firewall-settings", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    retry: retryPolicy,
    queryFn: getFirewallSettings,
  });
}

export function useIdentifierTransformsQuery() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-identifier-transforms", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    retry: retryPolicy,
    queryFn: getIdentifierTransforms,
  });
}
