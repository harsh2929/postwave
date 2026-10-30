// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Centralized TanStack Query key factories — now sourced from the shared
 * @postwave/query-contract package so web, desktop, and mobile share ONE
 * canonical key factory + staleness table and the cache key shape
 * (`[resource, tenantId, role, ...subkey]`) cannot drift between clients.
 *
 * This file is a thin re-export: the bodies previously duplicated here have
 * been deleted in favor of the package. Call sites are unchanged — they keep
 * importing `qk`, `STALE`, `base`, and `RoleKey` from `@/lib/query-keys`.
 *
 * Web-only keys (none today) should be composed here on top of `base` from
 * the package rather than forked into a divergent copy.
 */

import { base, type RoleKey } from "@postwave/query-contract";

export { qk, STALE, base, type RoleKey } from "@postwave/query-contract";

/**
 * Web-only flow-builder query keys, composed on the shared `base` so they carry
 * the same `[resource, tenantId, role, …]` tenant/role scoping as every other
 * key.
 *
 * Scope note, because the previous version of this comment overstated it: only
 * the flow LIST is scoped here. `flow-editor.tsx` still reads `["flow", id]`,
 * `["flow-versions", id]` and `["flow-runs", id]` directly — it has no
 * tenant/role in scope to build a scoped key from — so `detail`, `versions`
 * and `runs` factories were exported, never adopted, and are removed rather
 * than left standing as evidence of a migration that did not happen.
 *
 * That is not a cross-tenant leak today: QueryProvider rebuilds the whole
 * QueryClient whenever the server-resolved identity changes and clears the old
 * one on unmount, so an un-scoped key cannot outlive the tenant that filled
 * it. Key scoping is the second layer, not the only one.
 *
 * `catalog` is deliberately un-scoped: the node catalogue is static platform
 * metadata, identical for every tenant.
 */
export const flowKeys = {
  list: (tenantId: string, role: RoleKey) =>
    [...base("flows", tenantId, role)] as const,
  catalog: () => ["flow-catalog"] as const,
};

/**
 * Web-only Tags-page keys, composed on the shared `base` so every read the
 * page makes is tenant/role scoped. `tags` itself lives in `qk`; these are
 * its satellites (groups, usage/orphan taxonomy, typeahead, and the per-tag
 * detail projections) that no other client keys today.
 */
export const tagKeys = {
  groups: (tenantId: string, role: RoleKey) =>
    [...base("tag-groups", tenantId, role)] as const,
  taxonomy: (tenantId: string, role: RoleKey) =>
    [...base("tag-taxonomy", tenantId, role)] as const,
  suggest: (tenantId: string, role: RoleKey, q: string) =>
    [...base("tag-suggest", tenantId, role), q] as const,
  history: (tenantId: string, role: RoleKey, tagId: string) =>
    [...base("tag-history", tenantId, role), tagId] as const,
  membership: (
    tenantId: string,
    role: RoleKey,
    tagId: string,
    days: number,
  ) => [...base("tag-membership", tenantId, role), tagId, days] as const,
  subscribers: (tenantId: string, role: RoleKey, tagName: string) =>
    [...base("tag-subscribers", tenantId, role), tagName] as const,
};

/**
 * Web-only list-detail keys, composed on the shared `base` so they carry the
 * same tenant/role scoping as every other key.
 *
 * `detail` sits under the `lists` resource on purpose: the gateway mounts no
 * GET-by-id, so the detail record is derived from the catalogue read, and one
 * `invalidateQueries({ queryKey: base("lists", …) })` after a PATCH refreshes
 * both the index and the open workspace.
 */
export const listKeys = {
  detail: (tenantId: string, role: RoleKey, id: number) =>
    [...base("lists", tenantId, role), "detail", String(id)] as const,
  members: (tenantId: string, role: RoleKey, id: number, params?: unknown) =>
    [
      ...base("list-members", tenantId, role),
      String(id),
      params ?? null,
    ] as const,
  /** One resource per analytics facet so a card can be refetched alone. */
  analytics: (
    tenantId: string,
    role: RoleKey,
    id: number,
    facet: string,
    params?: unknown,
  ) =>
    [
      ...base("list-analytics", tenantId, role),
      String(id),
      facet,
      params ?? null,
    ] as const,
  activity: (tenantId: string, role: RoleKey, id: number, limit: number) =>
    [...base("list-activity", tenantId, role), String(id), limit] as const,
  webhooks: (tenantId: string, role: RoleKey, id: number) =>
    [...base("list-webhooks", tenantId, role), String(id)] as const,
  webhookDeliveries: (
    tenantId: string,
    role: RoleKey,
    id: number,
    webhookId: string,
  ) =>
    [
      ...base("list-webhook-deliveries", tenantId, role),
      String(id),
      webhookId,
    ] as const,
  suppressions: (
    tenantId: string,
    role: RoleKey,
    id: number,
    params?: unknown,
  ) =>
    [
      ...base("list-suppressions", tenantId, role),
      String(id),
      params ?? null,
    ] as const,
  mergeFields: (tenantId: string, role: RoleKey, id: number) =>
    [...base("list-merge-fields", tenantId, role), String(id)] as const,
  forms: (tenantId: string, role: RoleKey, id: number) =>
    [...base("list-forms", tenantId, role), String(id)] as const,
  automations: (tenantId: string, role: RoleKey, id: number) =>
    [...base("list-automations", tenantId, role), String(id)] as const,
  inboxReality: (tenantId: string, role: RoleKey, id: number, limit: number) =>
    [...base("list-inbox-reality", tenantId, role), String(id), limit] as const,
  /** `GET /api/v1/list-health` scores by subscriber TAG, not list id. */
  health: (tenantId: string, role: RoleKey, tag: string, windowDays: number) =>
    [...base("list-health", tenantId, role), tag, windowDays] as const,
};
