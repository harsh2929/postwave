/**
 * Canonical TanStack Query key factory + staleness table — the single
 * source of truth shared by web and desktop (and adaptable by mobile).
 *
 * Before this package, apps/web/src/lib/query-keys.ts and
 * apps/desktop/src/lib/query-keys.ts were copy-pasted (and mobile diverged
 * in key shape), so a key-shape change had to be hand-applied to each — a
 * cross-device cache-correctness hazard. Key shape is
 * `[resource, tenantId, role, ...subkey]` to prevent cross-tenant / cross-
 * role cache leakage; staleTime defaults live here so the strategy table is
 * a single point of edit.
 */

export type RoleKey = string | null;

export const STALE = {
  list: 30_000,
  detail: 10_000,
  dashboard: 60_000,
  reference: 24 * 60 * 60_000,
  authMe: 5 * 60_000,
} as const;

/** Tenant/role-scoped key prefix. `anon`/`unknown` keep keys well-formed
 *  before identity resolves so an unauth'd render can't collide with a
 *  resolved-tenant cache entry. */
export function base(
  resource: string,
  tenantId: string,
  role: RoleKey,
): readonly unknown[] {
  return [resource, tenantId || "anon", role ?? "unknown"] as const;
}

export const qk = {
  dashboard: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("dashboard", tenantId, role), params ?? null] as const,
  dashboardLayout: (tenantId: string, role: RoleKey) =>
    [...base("dashboard-layout", tenantId, role)] as const,
  onboardingProgress: (tenantId: string, role: RoleKey) =>
    [...base("onboarding-progress", tenantId, role)] as const,
  /**
   * Onboarding DECISIONS (GET /api/v1/onboarding/steps) — deliberately a
   * separate key from progress. Progress is derived tenant-wide fact and can
   * be refetched freely; a decision is one person's choice, so it must not
   * ride the same cache entry, and dismissing a surface must not force a
   * re-derivation of every EXISTS probe.
   */
  onboardingDecisions: (tenantId: string, role: RoleKey) =>
    [...base("onboarding-decisions", tenantId, role)] as const,
  notificationFeed: (tenantId: string, role: RoleKey) =>
    [...base("notification-feed", tenantId, role)] as const,

  campaigns: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("campaigns", tenantId, role), params ?? null] as const,
  campaign: (tenantId: string, role: RoleKey, id: string | number) =>
    [...base("campaign", tenantId, role), String(id)] as const,

  subscribers: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("subscribers", tenantId, role), params ?? null] as const,
  subscriber: (tenantId: string, role: RoleKey, id: string | number) =>
    [...base("subscriber", tenantId, role), String(id)] as const,

  segments: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("segments", tenantId, role), params ?? null] as const,
  templates: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("templates", tenantId, role), params ?? null] as const,
  lists: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("lists", tenantId, role), params ?? null] as const,
  tags: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("tags", tenantId, role), params ?? null] as const,
  forms: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("forms", tenantId, role), params ?? null] as const,

  audit: (tenantId: string, role: RoleKey, params?: unknown) =>
    [...base("audit", tenantId, role), params ?? null] as const,
  settings: (tenantId: string, role: RoleKey, scope?: string) =>
    [...base("settings", tenantId, role), scope ?? "root"] as const,

  authMe: () => ["auth-me"] as const,
} as const;

export type QueryKeyFactory = typeof qk;
