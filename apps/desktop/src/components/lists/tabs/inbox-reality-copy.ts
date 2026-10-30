/**
 * inbox-reality-copy — pure formatting for the list detail "Inbox
 * reality" tab (full-surface wiring #46).
 *
 * Wire shape (GET /api/v1/lists/{id}/inbox-reality → {list_id, items}):
 * one row per seed-list placement test —
 * `{test_id, subject?, created_at, status, total_seeds, inbox, spam,
 *   missing, inbox_pct}`. Note this is seed placement (inbox vs spam
 * vs missing), NOT open/click engagement — the copy below says so.
 *
 * Honesty invariants under test:
 *   - inbox_pct is only rendered for completed tests with seeds; a
 *     pending test shows "—", never a fake 0%.
 *   - the seed split always sums what the server reported and labels
 *     any unaccounted seeds rather than hiding them.
 */

import type { ListInboxRealityRow } from "../../../lib/api-client";

/** Badge class for a test status, mirroring the app's badge palette. */
export function statusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
      return "badge success";
    case "failed":
    case "error":
      return "badge danger";
    default:
      // pending / running / partial — neutral.
      return "badge";
  }
}

/**
 * Inbox-placement percentage label. The Go handler computes inbox_pct
 * from reported seeds; a test with zero seeds (or one still pending
 * with no reports) has nothing honest to show.
 */
export function inboxPctLabel(row: ListInboxRealityRow): string {
  if (row.total_seeds <= 0) return "—";
  if (row.inbox + row.spam + row.missing === 0) return "—";
  if (!Number.isFinite(row.inbox_pct)) return "—";
  return `${Math.round(row.inbox_pct)}%`;
}

/** "12 inbox · 3 spam · 1 missing (16 seeds)" — always sums the wire. */
export function seedSplitLabel(row: ListInboxRealityRow): string {
  if (row.total_seeds <= 0) return "No seeds reported";
  const parts = [
    `${row.inbox.toLocaleString()} inbox`,
    `${row.spam.toLocaleString()} spam`,
    `${row.missing.toLocaleString()} missing`,
  ];
  const accounted = row.inbox + row.spam + row.missing;
  const unreported = row.total_seeds - accounted;
  if (unreported > 0) {
    parts.push(`${unreported.toLocaleString()} not yet reported`);
  }
  return `${parts.join(" · ")} (${row.total_seeds.toLocaleString()} seed${row.total_seeds === 1 ? "" : "s"})`;
}
