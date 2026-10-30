/**
 * lib/auditAdvancedFilters.ts — the server-pushed narrowing fields beyond the
 * time window and the actor chip.
 *
 * `GET /api/v1/audit` has always accepted four more facets than mobile sent
 * (apps/api/internal/handlers/audit.go:147-151):
 *
 *   action        — ILIKE substring over the action key
 *   resource_type — exact match
 *   resource_id   — ILIKE substring
 *   actor_label   — exact match
 *
 * Desktop pushes all four (audit-operations.ts) while mobile narrowed only the
 * loaded pages client-side, so "every event touching subscriber X" meant paging
 * the whole history to the phone first. These are now real query params.
 *
 * Two properties are load-bearing:
 *
 *  - AN ADVANCED FILTER SET IS A TRANSIENT INVESTIGATION. It disqualifies the
 *    offline vault snapshot exactly as the actor chip does — a cached page of
 *    "everything that touched campaign 12" must never be served back as the
 *    workspace's audit log (see isAuditSnapshotEligible in hooks/useAudit).
 *  - EXACT VS SUBSTRING IS DISCLOSED, NOT GUESSED. `resource_type` and
 *    `actor_label` are exact equality on the server; a truncated value silently
 *    matches nothing. The sheet's field copy states which is which so an empty
 *    result reads as "no rows", not as a UI bug.
 *
 * Import-free of react-native so the node vitest environment can assert every
 * decision here.
 */

/** The four server facets, all optional, empty string meaning "not set". */
export interface AuditAdvancedFilters {
  /** Substring over the action key (server ILIKE). */
  action: string;
  /** Exact resource type, e.g. "campaign". */
  resourceType: string;
  /** Substring over the resource id (server ILIKE). */
  resourceId: string;
  /** EXACT actor label — a partial label matches nothing. */
  actorLabel: string;
}

export const EMPTY_AUDIT_ADVANCED_FILTERS: AuditAdvancedFilters = {
  action: "",
  resourceType: "",
  resourceId: "",
  actorLabel: "",
};

/** Trim every field; the server treats "" as absent, so we never send padding. */
export function normalizeAuditAdvancedFilters(
  input: AuditAdvancedFilters,
): AuditAdvancedFilters {
  return {
    action: input.action.trim(),
    resourceType: input.resourceType.trim(),
    resourceId: input.resourceId.trim(),
    actorLabel: input.actorLabel.trim(),
  };
}

/** How many facets are actually set (drives the chip's "(n)" badge). */
export function countAuditAdvancedFilters(
  input: AuditAdvancedFilters,
): number {
  const n = normalizeAuditAdvancedFilters(input);
  return [n.action, n.resourceType, n.resourceId, n.actorLabel].filter(Boolean)
    .length;
}

export function hasAuditAdvancedFilters(input: AuditAdvancedFilters): boolean {
  return countAuditAdvancedFilters(input) > 0;
}

/**
 * One sentence naming what the server was asked to narrow by — read by the
 * filter bar's disclosure line and by the export sheet's scope sentence, so
 * the screen and the CSV can never describe different windows.
 */
export function describeAuditAdvancedFilters(
  input: AuditAdvancedFilters,
): string | null {
  const n = normalizeAuditAdvancedFilters(input);
  const parts: string[] = [];
  if (n.action) parts.push(`action contains “${n.action}”`);
  if (n.resourceType) parts.push(`resource type ${n.resourceType}`);
  if (n.resourceId) parts.push(`resource id contains “${n.resourceId}”`);
  if (n.actorLabel) parts.push(`actor ${n.actorLabel}`);
  if (parts.length === 0) return null;
  return `Server-filtered to ${parts.join(", ")}.`;
}
