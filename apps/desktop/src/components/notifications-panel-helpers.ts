/**
 * Pure helpers used by NotificationsPanel and retained audit-activity tests.
 * Kept in a .ts file (no JSX) so focused tests do not drag the component
 * through the import-analysis transform.
 */

import type { AuditRow } from "../lib/api-client";
export { destinationForNotification } from "../lib/notification-navigation";

/**
 * Rows whose `action` starts with `http.` are generic forensics entries
 * written by the server's AuditMiddleware (e.g. `http.post.api.v1.subscribers`).
 * They have no product-analytics value and would otherwise render in the
 * panel as raw URL paths like "Http post api v1 subscribers". Handlers
 * that DO want a row in the activity feed call db.Audit() directly with
 * a specific action key (`campaign.created`, `subscriber.import.started`).
 *
 * Accepts any row shape that exposes `action` — works for both `AuditRow`
 * (audit-log API) and `AuditEvent` (dashboard-stats recent_audit slice).
 */
export function isUserFacingActivity(row: { action?: string | null }): boolean {
  return !(row.action ?? "").toLowerCase().startsWith("http.");
}

/** Humanise action keys like `campaign.created` → "Campaign created". */
export function prettyAction(row: AuditRow): string {
  const raw = row.action || "Activity";
  if (raw === "segment.decay") return "Segment decay detected";
  if (raw === "segment.definition_changed") return "Segment definition changed";
  const cleaned = raw.replace(/[._-]+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Tiny, dependency-free relative-time formatter. */
export function timeAgo(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

/** Returns true if any of `rows` happened in the last 24 hours. */
export function hasRecentActivity(rows: ReadonlyArray<AuditRow>): boolean {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const r of rows) {
    if (!r.at) continue;
    const t = Date.parse(r.at);
    if (!Number.isNaN(t) && t >= cutoff) return true;
  }
  return false;
}
