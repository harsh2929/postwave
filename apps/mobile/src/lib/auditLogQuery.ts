/**
 * lib/auditLogQuery.ts — the audit list's PURE query-building layer: the
 * filter shape, the URL builder, the wire normaliser and the offline-snapshot
 * eligibility rules. Extracted whole from hooks/useAudit.ts when that file
 * crossed the 450-line source budget; hooks/useAudit re-exports everything so
 * no caller moved. Behaviour is pinned by hooks/useAudit.test.ts.
 */
import type { AuditRow } from "@/hooks/useAudit";

export interface AuditFilters {
  /** Canonical wire actor_type, only when the chip maps to exactly one. */
  actorType?: string | undefined;
  /** RFC3339 lower bound. */
  since?: string | undefined;
  /** Substring over the action key (server ILIKE — handlers/audit.go:149). */
  action?: string | undefined;
  /** Exact resource type (server equality). */
  resourceType?: string | undefined;
  /** Substring over the resource id (server ILIKE). */
  resourceId?: string | undefined;
  /** EXACT actor label — the server matches equality, not substring. */
  actorLabel?: string | undefined;
}

export interface AuditPage {
  rows: AuditRow[];
  nextCursor: string | null;
}

/**
 * Build the list URL. `limit` is clamped to the server's accepted range
 * (1..500) so a caller bug can't silently fall back to the server default
 * of 50 and make the "N per page" copy a lie.
 */
export function auditLogPath(
  limit: number,
  cursor?: string | null,
  filters?: AuditFilters,
): string {
  const normalizedLimit =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const qs = new URLSearchParams({ limit: String(normalizedLimit) });
  if (cursor) qs.set("cursor", cursor);
  if (filters?.actorType) qs.set("actor_type", filters.actorType);
  if (filters?.since) qs.set("since", filters.since);
  if (filters?.action) qs.set("action", filters.action);
  if (filters?.resourceType) qs.set("resource_type", filters.resourceType);
  if (filters?.resourceId) qs.set("resource_id", filters.resourceId);
  if (filters?.actorLabel) qs.set("actor_label", filters.actorLabel);
  return `/api/v1/audit?${qs.toString()}`;
}

/** Normalise the list response, tolerating an unvalidated wire shape. */
export function normalizeAuditPage(res: unknown): AuditPage {
  const rows = (res as { rows?: unknown } | null)?.rows;
  const next = (res as { nextCursor?: unknown } | null)?.nextCursor;
  return {
    rows: Array.isArray(rows) ? (rows as AuditRow[]) : [],
    nextCursor: typeof next === "string" && next ? next : null,
  };
}

export interface AuditLogOptions {
  /**
   * Additional caller-side condition, ANDed with the identity gate. The
   * dashboard uses it to make its feed a genuine FALLBACK: the stats payload
   * already carries `recent_audit`, so on any current deployment this query is
   * pure waste — and not cheap waste, since a successful page-one read writes
   * teammate identities into the SecureStore vault.
   */
  enabled?: boolean | undefined;
  /**
   * Stable label for the TIME WINDOW this caller is asking for, e.g. "7d".
   *
   * Without it, adding a default `since` bound to the audit screen silently
   * killed the offline snapshot entirely: eligibility used to be "no filters
   * at all", and once every render carried a `since` that condition could
   * never be true again — so nothing was ever written to the vault and
   * nothing was ever read back. A window is a bound the snapshot can honestly
   * satisfy, so it participates in the vault key instead of disqualifying it;
   * that also stops a 24h capture being served back under an "All" window.
   */
  snapshotKey?: string | undefined;
}

/**
 * May page one of THIS filter set become the offline baseline?
 *
 * An ACTOR-filtered view is a transient investigation and must never be
 * written back as the workspace's cached audit log. A TIME WINDOW is not a
 * disqualifier — it is a bound the cached page genuinely satisfies, and it is
 * carried in the vault slot instead (see `auditSnapshotSlot`).
 *
 * This used to be `!actorType && !since`. Once the screen gained a default
 * 7d window, `since` was set on every render, the condition could never be
 * true again, and the audit log's offline read went silently dead: nothing
 * was written to the vault and nothing was ever read back.
 */
export function isAuditSnapshotEligible(filters?: AuditFilters): boolean {
  // Any advanced facet (action / resource / actor label) is the same kind of
  // transient investigation the actor chip is: page one of "everything that
  // touched campaign 12" must never become the workspace's cached audit log.
  return (
    !filters?.actorType &&
    !filters?.action &&
    !filters?.resourceType &&
    !filters?.resourceId &&
    !filters?.actorLabel
  );
}

/**
 * Vault slot for a snapshot. Window-scoped when the caller names a window, so
 * a 24h capture is never handed back under an "All" window. Callers that ask
 * for no window (the dashboard fallback feed) keep the unsuffixed slot.
 */
export function auditSnapshotSlot(
  limit: number,
  snapshotKey?: string | undefined,
): string {
  return snapshotKey ? `latest-${limit}-${snapshotKey}` : `latest-${limit}`;
}
