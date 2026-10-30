/**
 * Centralized TanStack Query key factories — desktop surface.
 *
 * The key factory + staleness table are no longer defined here: they are
 * the canonical contract owned by `@postwave/query-contract`, shared 1:1
 * by web/desktop/mobile so the cache-key SHAPE
 * (`[resource, tenantId, role, ...subkey]`) can never drift between
 * clients. Drift here was a real cross-device cache-correctness hazard
 * (a key-shape change had to be hand-applied to each copy); re-exporting
 * the single source of truth removes that hazard.
 *
 * Key-shape recap (see the package for the authoritative docs):
 *   - shape is ALWAYS [resource, tenantId, role, ...subkey] so cached
 *     data can never leak across tenant/role boundaries.
 *   - staleTime defaults (`STALE`) live alongside the factory so the
 *     strategy table is a single point of edit:
 *       lists 30s · details 10s · dashboard 60s · reference 24h · auth-me 5m
 *
 * Call sites are unchanged: `import { qk } from "@/lib/query-keys"`
 * (and `STALE` / `RoleKey`) keep working because they're re-exported
 * below.
 *
 * Desktop-only keys: there are none today — the desktop's needs are a
 * 1:1 subset of the shared contract. If a desktop-only key is ever
 * needed, compose it here WITHOUT mutating the shared `qk` object, e.g.:
 *
 *   import { base, qk as sharedQk } from "@postwave/query-contract";
 *   export const qk = {
 *     ...sharedQk,
 *     desktopOnlyThing: (tenantId: string, role: RoleKey) =>
 *       [...base("desktop-only-thing", tenantId, role)] as const,
 *   } as const;
 *
 * so the shared keys stay identical across surfaces and the desktop
 * addition is additive-only.
 */

export {
  type RoleKey,
  type QueryKeyFactory,
  STALE,
  base,
  qk,
} from "@postwave/query-contract";
