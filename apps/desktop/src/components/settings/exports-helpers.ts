/**
 * exports-helpers — pure logic for the Settings "Data exports"
 * section (#34, POST/GET /api/v1/exports).
 *
 * Wire facts (apps/api/internal/exports): statuses are
 * queued → running → ready | failed; the signed download_url is only
 * populated once status='ready' and expires (expires_at, 24h TTL).
 */

import type { TenantExportRow } from "../../lib/api-client";

/** Mirrors exports.SupportedResources server-side — keep in sync. */
export const EXPORT_INCLUDE_OPTIONS: Array<{
  key: string;
  label: string;
  description: string;
}> = [
  { key: "subscribers", label: "Subscribers", description: "Every subscriber row" },
  { key: "campaigns", label: "Campaigns", description: "Every campaign" },
  { key: "automations", label: "Automations", description: "Every automation" },
  { key: "audit_log", label: "Audit log", description: "Last 365 days of audit rows" },
  { key: "lists", label: "Lists", description: "Lists + memberships" },
  { key: "tags", label: "Tags", description: "Tags + memberships" },
  { key: "events", label: "Events", description: "Last 90 days of subscriber events" },
  // "Take everything" resources (no lock-in) — mirror the server's
  // SupportedResources so the granular picker can select them individually,
  // not only via one-click "Export everything".
  { key: "templates", label: "Templates", description: "Email templates you own" },
  { key: "segments", label: "Segments", description: "Saved audience segments" },
  { key: "forms", label: "Forms", description: "Signup / opt-in forms" },
  { key: "suppressions", label: "Suppressions", description: "Suppression list entries" },
  { key: "consent", label: "Consent", description: "Consent records + provenance" },
];

/** Badge tone per export status. Unknown statuses render neutrally. */
export function exportStatusTone(status: string): string {
  switch (status) {
    case "ready":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "warning";
    case "queued":
      return "";
    default:
      return "";
  }
}

/** True when the row carries a live signed download URL. */
export function isDownloadReady(
  row: Pick<TenantExportRow, "status" | "download_url">,
): boolean {
  return row.status === "ready" && Boolean(row.download_url);
}

/** True when the signed URL has passed its expiry. */
export function isDownloadExpired(
  row: Pick<TenantExportRow, "expires_at">,
  now: Date = new Date(),
): boolean {
  if (!row.expires_at) return false;
  const t = new Date(row.expires_at).getTime();
  return Number.isFinite(t) && t < now.getTime();
}

/** "subscribers, campaigns +2 more" style include summary. */
export function summarizeInclude(include: string[], max = 3): string {
  if (include.length === 0) return "everything";
  if (include.length <= max) return include.join(", ");
  return `${include.slice(0, max).join(", ")} +${include.length - max} more`;
}

export function fmtExportBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
