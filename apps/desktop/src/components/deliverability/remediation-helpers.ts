/**
 * remediation-helpers — pure logic behind the "What Moosewave caught"
 * auto-remediation row (#38 spam-trap guard, #39 soft-bounce recovery,
 * #40 intelligent retry).
 *
 * Kept out of the .tsx cards so the node-environment vitest suite can
 * import it without a JSX transform.
 */

import type { IntelligentRetryEvent } from "../../lib/api-client";

/**
 * Badge class per intelligent-retry status. Statuses mirror
 * apps/api/internal/intelligent_retry (pending → retrying → retried /
 * failed, plus the two operator verdicts ready / dismissed).
 */
export function retryStatusBadgeClass(status: string): string {
  switch (status) {
    case "retried":
      return "badge success";
    case "ready":
    case "retrying":
      return "badge accent";
    case "failed":
      return "badge danger";
    case "pending":
      return "badge warning";
    case "dismissed":
    default:
      return "badge";
  }
}

/**
 * Which operator actions are legal for a retry event. Mirrors the
 * server transitions: mark-ready / dismiss both write the status
 * unconditionally, but offering them on terminal rows (retried /
 * failed) would let an operator clobber history, and re-dismissing a
 * dismissed row is a no-op — so the UI only offers verdicts on rows
 * the worker hasn't resolved yet.
 */
export function retryActionsFor(status: string): {
  markReady: boolean;
  dismiss: boolean;
} {
  switch (status) {
    case "pending":
      return { markReady: true, dismiss: true };
    case "ready":
      return { markReady: false, dismiss: true };
    case "dismissed":
      return { markReady: true, dismiss: false };
    default:
      // retrying / retried / failed are worker-owned states.
      return { markReady: false, dismiss: false };
  }
}

/**
 * Replaces one event row by id (the mark-ready / dismiss endpoints
 * return the updated row). Pure + id-targeted so every other row is
 * left untouched; unknown ids return the array unchanged.
 */
export function replaceRetryEvent(
  rows: IntelligentRetryEvent[],
  updated: IntelligentRetryEvent,
): IntelligentRetryEvent[] {
  let hit = false;
  const next = rows.map((r) => {
    if (r.id === updated.id) {
      hit = true;
      return updated;
    }
    return r;
  });
  return hit ? next : rows;
}

/** "2026-06-11T08:00:00Z" → locale date+time, or "—" for bad input. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
