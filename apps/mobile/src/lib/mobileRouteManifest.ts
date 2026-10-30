import { labelFor } from "@postwave/nav";
import {
  MOBILE_MORE_SECTION_ORDER,
  RAW_MOBILE_SECONDARY_ROUTES,
  type MobileAccessRole,
  type MobileMoreSection,
  type MobileSecondaryRoute,
} from "@/lib/mobileRouteTable";

// The route TABLE and its types live in mobileRouteTable.ts; this module owns
// the access policy over them. Re-exported so every existing import of
// `@/lib/mobileRouteManifest` keeps working unchanged.
export {
  MOBILE_MORE_SECTION_ORDER,
  type MobileAccessRole,
  type MobileMoreSection,
  type MobileSecondaryRoute,
};

const MOBILE_ROLE_RANK: Record<MobileAccessRole, number> = {
  viewer: 0,
  // Legacy mobile `member` is viewer-equivalent at the API boundary.
  member: 0,
  editor: 2,
  admin: 3,
  owner: 4,
};

export type MobileCapabilityKey =
  | "approvals_decide"
  | "workspace_settings"
  | "notification_settings"
  | "retention_settings"
  | "outbound_webhooks"
  | "api_keys"
  | "voice_labels"
  | "privacy_requests";

export interface MobileCapability {
  minimumRole: MobileAccessRole;
  /** Exact API operations checked against the generated server manifest. */
  apiOperations: readonly { method: string; path: string }[];
}

export const MOBILE_CAPABILITIES: Record<
  MobileCapabilityKey,
  MobileCapability
> = {
  // DECIDING an approval is admin-only; READING the queue is not. The server
  // policy manifest is explicit (GET /api/v1/approvals -> viewer, POST
  // .../approve -> admin), and nav.consistency cross-checks this table against
  // that manifest — so a capability may only group operations that share one
  // role floor.
  approvals_decide: {
    minimumRole: "admin",
    apiOperations: [
      { method: "POST", path: "/api/v1/approvals/{id}/approve" },
      { method: "POST", path: "/api/v1/approvals/{id}/reject" },
    ],
  },
  workspace_settings: {
    minimumRole: "admin",
    apiOperations: [
      { method: "GET", path: "/api/v1/settings/workspace" },
      { method: "PATCH", path: "/api/v1/settings/workspace" },
    ],
  },
  notification_settings: {
    minimumRole: "admin",
    apiOperations: [
      { method: "GET", path: "/api/v1/settings/notifications" },
      { method: "PATCH", path: "/api/v1/settings/notifications" },
      // The test-send sits on the same object at the same admin floor
      // (routeauth manifest: session_minimum_role "admin"), so it belongs to
      // this capability rather than to one of its own.
      { method: "POST", path: "/api/v1/settings/notifications/test" },
    ],
  },
  retention_settings: {
    minimumRole: "admin",
    apiOperations: [
      { method: "GET", path: "/api/v1/settings/privacy" },
      { method: "PATCH", path: "/api/v1/settings/privacy" },
    ],
  },
  outbound_webhooks: {
    minimumRole: "admin",
    apiOperations: [
      { method: "GET", path: "/api/v1/outbound-webhooks" },
      { method: "POST", path: "/api/v1/outbound-webhooks" },
    ],
  },
  // Revoking a leaked key is admin-only server-side. Declaring it here keeps
  // the phone from offering an action that is a guaranteed 403 for anyone else.
  api_keys: {
    minimumRole: "admin",
    apiOperations: [
      { method: "GET", path: "/api/v1/api-keys" },
      { method: "DELETE", path: "/api/v1/api-keys/{id}" },
    ],
  },
  voice_labels: {
    minimumRole: "admin",
    apiOperations: [
      { method: "POST", path: "/api/v1/voice/labels" },
      { method: "DELETE", path: "/api/v1/voice/labels/{id}" },
    ],
  },
  privacy_requests: {
    minimumRole: "admin",
    apiOperations: [
      { method: "GET", path: "/api/v1/privacy/requests" },
      { method: "POST", path: "/api/v1/privacy/export-requests" },
    ],
  },
};

export const MOBILE_SECONDARY_ROUTES: readonly MobileSecondaryRoute[] =
  RAW_MOBILE_SECONDARY_ROUTES.map((route) => {
    const canonical = route.navKey ? labelFor(route.navKey) : undefined;
    return canonical && canonical !== route.label
      ? { ...route, label: canonical }
      : route;
  });

export function normalizeMobileAccessRole(
  role: string | undefined | null,
): MobileAccessRole | null {
  const normalized = role?.trim().toLowerCase();
  if (
    normalized === "viewer" ||
    normalized === "member" ||
    normalized === "editor" ||
    normalized === "admin" ||
    normalized === "owner"
  ) {
    return normalized;
  }
  return null;
}

export function canAccessMobileSecondaryRoute(
  route: MobileSecondaryRoute,
  role: string | undefined | null,
  mode?: "api_key" | "session" | null,
): boolean {
  // The mobile login response does not expose API-key scopes. Default deny
  // editor/admin UI instead of rendering controls that may issue predictable
  // 403s; read-only routes remain discoverable and the API still enforces the
  // key's exact read scope.
  if (mode === "api_key") return !route.minimumRole;
  if (!route.minimumRole) return true;
  const actual = normalizeMobileAccessRole(role);
  if (!actual) return false;
  return MOBILE_ROLE_RANK[actual] >= MOBILE_ROLE_RANK[route.minimumRole];
}

export function canAccessMobileCapability(
  capability: MobileCapabilityKey,
  role: string | undefined | null,
  mode?: "api_key" | "session" | null,
): boolean {
  return canAccessMinimumRole(
    MOBILE_CAPABILITIES[capability].minimumRole,
    role,
    mode,
  );
}

export function canAccessMinimumRole(
  minimumRole: MobileAccessRole,
  role: string | undefined | null,
  mode?: "api_key" | "session" | null,
): boolean {
  if (mode === "api_key") return minimumRole === "viewer";
  const actual = normalizeMobileAccessRole(role);
  if (!actual) return false;
  return MOBILE_ROLE_RANK[actual] >= MOBILE_ROLE_RANK[minimumRole];
}

/** Resolve an Expo pathname (route groups included or omitted) to policy. */
export function mobileSecondaryRouteForPath(
  pathname: string,
): MobileSecondaryRoute | null {
  const normalized = normalizeMobilePath(pathname);
  // MOST SPECIFIC WINS. This used to return the FIRST row whose path was a prefix,
  // which silently shadowed any nested route that owns a row of its own: with both
  // `/sms` and `/sms/suppressions` declared, the opt-outs screen resolved to the
  // inbox row and inherited ITS policy. That was invisible while neither row had a
  // `minimumRole` and became a bug the moment one did. Both are exact-admin today,
  // but they remain distinct policy rows: a future change to either route family
  // must not silently bleed into the other through prefix ordering.
  //
  // An exact match is the longest possible match, so ordering by candidate length
  // covers both cases with one rule.
  let best: MobileSecondaryRoute | null = null;
  let bestLength = -1;
  for (const route of MOBILE_SECONDARY_ROUTES) {
    const candidate = normalizeMobilePath(route.route);
    const matches =
      normalized === candidate || normalized.startsWith(`${candidate}/`);
    if (matches && candidate.length > bestLength) {
      best = route;
      bestLength = candidate.length;
    }
  }
  return best;
}

function normalizeMobilePath(pathname: string): string {
  const withoutGroup = pathname.trim().replace(/^\/\(tabs\)/, "");
  const withLeadingSlash = withoutGroup.startsWith("/")
    ? withoutGroup
    : `/${withoutGroup}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

export function routesForMoreSection(
  section: MobileMoreSection,
): readonly MobileSecondaryRoute[] {
  return MOBILE_SECONDARY_ROUTES.filter(
    (route) => route.moreSection === section,
  );
}
