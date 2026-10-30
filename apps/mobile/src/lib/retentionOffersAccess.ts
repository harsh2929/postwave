import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type { AuthMode } from "@/store/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type RetentionOffersQuerySurface =
  | "list"
  | "funnel"
  | "winback-settings"
  | "tier-names";

export interface RetentionOffersAccessIdentity {
  gateEnabled: boolean;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
  mode: AuthMode | null;
  viewerMode: boolean;
}

/**
 * Exact mobile admission policy for the four admin reads.
 *
 * A deep link can bypass navigation discovery, so every query asks this
 * predicate independently. API-key mode fails closed because mobile does not
 * know the key's scopes; viewer mode fails even if a stale profile still says
 * owner/admin. A malformed cached tenant id also issues no request.
 */
export function canLoadRetentionOffers(
  identity: RetentionOffersAccessIdentity,
): boolean {
  return (
    identity.gateEnabled &&
    identity.viewerMode === false &&
    typeof identity.tenantId === "string" &&
    identity.tenantId === identity.tenantId.trim() &&
    UUID_RE.test(identity.tenantId) &&
    canAccessMinimumRole("admin", identity.effectiveRole, identity.mode)
  );
}

/** Every authorization-relevant identity fact participates in cache identity. */
export function retentionOffersQueryKey(
  surface: RetentionOffersQuerySurface,
  identity: RetentionOffersAccessIdentity,
) {
  return [
    "retention-offers",
    surface,
    identity.tenantId?.toLowerCase() ?? "no-tenant",
    identity.userId ?? "no-user",
    identity.effectiveRole?.trim().toLowerCase() ?? "no-role",
    identity.mode ?? "no-mode",
    identity.viewerMode ? "viewer-mode" : "member-mode",
  ] as const;
}
