/**
 * hooks/useAudit.ts — the audit log feed and its investigation context.
 *
 * Backed by GET /api/v1/audit on the gateway. Three things changed the
 * character of this hook from "recent 100 rows" to an investigation
 * surface:
 *
 *   1. PAGINATION. The server returns `nextCursor` and accepts `cursor`;
 *      mobile ignored both and hard-capped at 100, so an incident two
 *      hours old on a busy tenant was simply unreachable from a phone.
 *   2. SERVER-SIDE NARROWING. `since` and single-value `actor_type` are
 *      pushed to the query, so "everything today" means it — instead of
 *      narrowing an arbitrary recent window client-side. Multi-value
 *      chips deliberately stay client-side because the server's actor
 *      filter is exact equality and would silently drop the other values.
 *   3. PROVENANCE. The extra wire fields (redactedFields, legalHold,
 *      hasEncryptedMetadata, sessionId) are surfaced, because a silently
 *      masked value read as truth is a compliance failure.
 *
 * Page one remains offline-snapshot-backed: the audit log is the surface
 * most likely to be consulted away from connectivity.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { normalizeAuditStats, type AuditStats } from "@/lib/auditStats";
import { loadOfflineCapableSnapshot } from "../lib/offlineSnapshots";
import {
  vaultGetJSON,
  vaultScopeForClient,
  vaultSetJSON,
} from "@/lib/secureVault";

export type AuditRow = {
  id: number;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  actorType: string;
  actorLabel?: string | null;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata: Record<string, unknown>;
  at: string;
  /**
   * Dotted JSONPaths the redactor pulled out of metadata at write time.
   * The PATH NAMES are non-sensitive; the values never reach the wire.
   * Non-empty means what you are reading has been masked.
   */
  redactedFields?: string[];
  /** A metadata_encrypted side-blob exists; revealing it needs audit:read_pii. */
  hasEncryptedMetadata?: boolean;
  /** Row is under legal hold — retention rules do not apply to it. */
  legalHold?: boolean;
  retentionOverrideDays?: number | null;
  /** Groups agent events into one AIVS session. */
  sessionId?: string;
};

export {
  auditLogPath,
  auditSnapshotSlot,
  isAuditSnapshotEligible,
  normalizeAuditPage,
} from "@/lib/auditLogQuery";
export type { AuditFilters, AuditLogOptions, AuditPage } from "@/lib/auditLogQuery";
import {
  auditSnapshotSlot,
  isAuditSnapshotEligible,
  auditLogPath,
  normalizeAuditPage,
  type AuditFilters,
  type AuditLogOptions,
  type AuditPage,
} from "@/lib/auditLogQuery";

/**
 * useAuditLog — page one is snapshot-backed, subsequent pages are network
 * only (a cache of page 7 of an ad-hoc filter is not worth a vault write,
 * and would age into a confusing partial history).
 */
export function useAuditLog(
  limit = 100,
  filters?: AuditFilters,
  { enabled = true, snapshotKey }: AuditLogOptions = {},
) {
  const gate = useOnlineQueryGate();
  const vaultScope =
    gate.baseUrl && gate.tenantId && gate.userId && gate.effectiveRole
      ? vaultScopeForClient({
          baseUrl: gate.baseUrl,
          tenantId: gate.tenantId,
          userId: gate.userId,
          role: gate.effectiveRole,
        })
      : null;
  const actorType = filters?.actorType ?? null;
  const since = filters?.since ?? null;
  const snapshotEligible = isAuditSnapshotEligible(filters);
  const snapshotSlot = auditSnapshotSlot(limit, snapshotKey);

  return useInfiniteQuery({
    queryKey: [
      "audit",
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      limit,
      actorType,
      since,
      // The advanced facets are part of the request, so they are part of the
      // key — two investigations must never share one cache entry.
      filters?.action ?? null,
      filters?.resourceType ?? null,
      filters?.resourceId ?? null,
      filters?.actorLabel ?? null,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled: enabled && gate.canReadOfflineSnapshots && Boolean(vaultScope),
    networkMode: "always",
    initialPageParam: null as string | null,
    getNextPageParam: (last: AuditPage) => last.nextCursor,
    queryFn: async ({ pageParam }): Promise<AuditPage> => {
      const cursor = pageParam as string | null;
      const fetchPage = async (): Promise<AuditPage> => {
        const { client } = getClient();
        const res = await client.request<unknown>(
          "GET",
          auditLogPath(limit, cursor, filters),
        );
        return normalizeAuditPage(res);
      };
      if (cursor || !snapshotEligible) {
        // Later pages have nothing cached to fall back to; let the query
        // error so the list footer can offer a retry rather than silently
        // ending the history.
        return fetchPage();
      }
      return loadOfflineCapableSnapshot({
        canUseNetwork: gate.enabled,
        loadNetwork: fetchPage,
        readSnapshot: async () => {
          const cached = await vaultGetJSON<AuditRow[] | AuditPage>(
            "audit",
            snapshotSlot,
            vaultScope ? { scope: vaultScope } : {},
          );
          if (!cached) return null;
          // Older builds stored a bare row array under this key.
          return Array.isArray(cached)
            ? { rows: cached, nextCursor: null }
            : cached;
        },
        writeSnapshot: (page) =>
          vaultSetJSON("audit", snapshotSlot, page, {
            ...(vaultScope ? { scope: vaultScope } : {}),
          }),
        networkAvailable: isProbablyOnline,
        unavailableMessage: "No saved audit snapshot is available offline.",
      });
    },
  });
}

/** GET /api/v1/audit/my-scopes — ungated, so it always answers. */
export type AuditScopes = {
  scopes: string[];
  auditScopes: string[];
  isAdmin: boolean;
};

/**
 * useAuditScopes — the audit list itself is behind RequireScope(audit:read),
 * so a user without it gets a bare 403 that renders as a generic "something
 * went wrong" and gets reported as a bug. This endpoint is deliberately
 * ungated (server/audit_operations.go mounts it with no With(...)), so it
 * can answer "you lack audit:read" even when nothing else will.
 */
export function useAuditScopes() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-scopes", gate.tenantId, gate.userId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AuditScopes | null> => {
      const { client } = getClient();
      const res = await client.request<Partial<AuditScopes> | null>(
        "GET",
        "/api/v1/audit/my-scopes",
      );
      if (!res) return null;
      return {
        scopes: Array.isArray(res.scopes) ? res.scopes : [],
        auditScopes: Array.isArray(res.auditScopes) ? res.auditScopes : [],
        isAdmin: Boolean(res.isAdmin),
      };
    },
  });
}

/**
 * Can this actor read the audit log?
 *
 * Returns null while unknown, so a screen never renders a permission
 * verdict it has not received. Admins pass regardless: the server's
 * ScopeAdmin implies the audit scopes, and the session-auth branch of
 * MyScopes reports isAdmin from the workspace role.
 */
export function hasAuditReadScope(
  scopes: AuditScopes | null | undefined,
): boolean | null {
  if (!scopes) return null;
  if (scopes.isAdmin) return true;
  return scopes.auditScopes.includes("audit:read");
}

/** Does the actor see un-masked PII in metadata? */
export function hasAuditPiiScope(
  scopes: AuditScopes | null | undefined,
): boolean {
  if (!scopes) return false;
  return scopes.isAdmin || scopes.auditScopes.includes("audit:read_pii");
}

export type AuditCheckpoint = {
  checkpoint_id?: string;
  tree_size?: number;
  upto_audit_id?: number;
  root_hash?: string;
  root_kid?: string;
  anchored_at?: string;
};

/**
 * useAuditCheckpoint — the tamper-evidence claim.
 *
 * The backend maintains a Merkle-anchored append-only log; that is what
 * makes this an audit log rather than a table of strings. The endpoint is
 * admin-scoped and 404s with `no_checkpoint` before the first anchor, so
 * BOTH are normal answers meaning "no banner", not errors.
 */
export function useAuditCheckpoint() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-checkpoint", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<AuditCheckpoint | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<AuditCheckpoint | null>(
          "GET",
          "/api/v1/audit/checkpoint/latest",
        );
        return res ?? null;
      } catch (err) {
        const status = errorStatus(err);
        if (status === 404 || status === 403 || status === 501) return null;
        throw err;
      }
    },
  });
}

/**
 * useAuditStats — the per-day activity series behind the "is today normal?"
 * line above the feed. GET /api/v1/audit/stats sits behind the same
 * audit:read scope as the list (server/audit_operations.go:41), so anyone who
 * can see the log can see its shape.
 *
 * `since` is the SAME bound the list sends, so the summary and the feed can
 * never describe different windows. A 403/404/501 degrades to null — the
 * summary is an enrichment above an audit log, and losing it must never take
 * the log with it.
 *
 * `staleTime` is deliberately long: three server-side COUNTs over audit_log is
 * the most expensive request this screen makes, and an activity baseline that
 * moves every minute was never the point.
 */
export function useAuditStats(since?: string | undefined, enabled = true) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-stats", gate.tenantId, since ?? null],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AuditStats | null> => {
      const { client } = getClient();
      const qs = since ? `?since=${encodeURIComponent(since)}` : "";
      try {
        const res = await client.request<unknown>("GET", `/api/v1/audit/stats${qs}`);
        return normalizeAuditStats(res);
      } catch (err) {
        const status = errorStatus(err);
        if (status === 403 || status === 404 || status === 501) return null;
        throw err;
      }
    },
  });
}

export type AuditAnomaly = {
  auditId: number;
  score: number;
  bucket: "high" | "med" | "low" | string;
  action?: string;
  actorLabel?: string;
  actorType?: string;
  dominantType?: string;
  mitreTechniques?: string[];
  createdAt?: string;
};

/**
 * useRecentAuditAnomalies — the server-side UEBA assessment over the last
 * 24h. On a phone the machine should pick the rows worth reading rather
 * than the human scanning a hundred verbs. Degrades to null (no badges,
 * the client-side severity classifier still applies) rather than erroring
 * the list, since scoring is an enrichment.
 */
export function useRecentAuditAnomalies(limit = 50) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-anomalies", gate.tenantId, limit],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<AuditAnomaly[]> => {
      const { client } = getClient();
      try {
        const res = await client.request<{ items?: AuditAnomaly[] } | null>(
          "GET",
          `/api/v1/audit/anomalies/recent?limit=${encodeURIComponent(String(limit))}`,
        );
        return Array.isArray(res?.items) ? res.items : [];
      } catch (err) {
        const status = errorStatus(err);
        if (status === 403 || status === 404 || status === 501) return [];
        throw err;
      }
    },
  });
}

/** Map anomaly rows to their audit id for O(1) row lookup. */
export function anomalyIndex(
  rows: readonly AuditAnomaly[] | undefined,
): Map<number, AuditAnomaly> {
  const out = new Map<number, AuditAnomaly>();
  for (const row of rows ?? []) {
    if (typeof row.auditId === "number") out.set(row.auditId, row);
  }
  return out;
}

function errorStatus(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    return Number((err as { status?: unknown }).status) || 0;
  }
  return 0;
}
