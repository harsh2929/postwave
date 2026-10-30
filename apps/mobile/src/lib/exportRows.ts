/**
 * lib/exportRows.ts — PURE presentation rules for tenant data exports
 * (GET /api/v1/exports).
 *
 * The whole point of putting this surface on a phone is the signed download
 * URL: on a desktop it is a link, but on a phone it is directly actionable —
 * hand it to Safari or the share sheet and the bundle lands in Files. That
 * makes getting the "can I actually download this right now?" question right
 * the only thing that matters, and it is a three-way question the desktop
 * helper answers with two independent booleans that call sites have to combine
 * correctly every time:
 *
 *   status='ready' AND download_url present AND expires_at in the future.
 *
 * A row whose 24h signed URL has lapsed must NOT render a download affordance
 * that 403s — it has to say the URL expired and that a fresh export is needed.
 * That ordering (expired beats ready) is the bug this module exists to prevent,
 * so it is expressed once, here, and tested.
 *
 * Import-free by construction so it runs in the node vitest environment.
 *
 * Wire facts (apps/api/internal/exports/exports.go:175-280): every nullable
 * column is flattened to "" by derefStr, so absent values arrive as empty
 * strings rather than null. statuses are queued → running → ready | failed.
 */

export interface TenantExportRow {
  id: string;
  status: string;
  include: string[];
  requested_by_email: string;
  bytes_total: number;
  rows_total: number;
  /** "" until status='ready'. Signed, 24h TTL. */
  download_url: string;
  /** "" until status='ready'. */
  expires_at: string;
  /** "" unless status='failed'. */
  error: string;
  created_at: string;
}

export type ExportTone = "success" | "danger" | "warning" | "neutral";

export type ExportDownloadState =
  /** Still being built server-side. */
  | { kind: "pending" }
  /** The worker gave up; `reason` is the server's message (may be ""). */
  | { kind: "failed"; reason: string }
  /** Signed URL is live — open it. */
  | { kind: "ready"; url: string }
  /** Bundle was built but the signed URL has lapsed; re-request. */
  | { kind: "expired" }
  /** status='ready' with no URL. Shouldn't happen; never render a dead tap. */
  | { kind: "unavailable" };

export function exportStatusTone(status: string): ExportTone {
  switch (status) {
    case "ready":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "warning";
    default:
      return "neutral";
  }
}

export function exportDownloadState(
  row: Pick<TenantExportRow, "status" | "download_url" | "expires_at" | "error">,
  now: Date = new Date(),
): ExportDownloadState {
  if (row.status === "failed") return { kind: "failed", reason: row.error };
  if (row.status !== "ready") return { kind: "pending" };
  // Expiry is checked BEFORE the URL is offered: a lapsed signed URL still
  // looks perfectly valid in the payload and 403s on tap.
  const expiresAt = Date.parse(row.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
    return { kind: "expired" };
  }
  const url = row.download_url.trim();
  if (!url) return { kind: "unavailable" };
  return { kind: "ready", url };
}

/**
 * Only http(s) URLs are handed to Linking.
 *
 * The server writes `download_url` verbatim from object storage, which is a
 * presigned https URL in production but a `file://` path in dev/self-hosted
 * filesystem mode. Opening a file:// URL from the app is at best a no-op and at
 * worst a surprising local-file read, so the row says "not available on this
 * device" instead of offering a tap that does something unexplained.
 */
export function isOpenableDownloadUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith("https://") || trimmed.startsWith("http://");
}

/** "subscribers, campaigns +2 more" — matches the desktop summary. */
export function summarizeInclude(
  include: readonly string[] | undefined,
  max = 3,
): string {
  const rows = (include ?? []).filter((v) => typeof v === "string" && v);
  if (rows.length === 0) return "everything";
  if (rows.length <= max) return rows.join(", ");
  return `${rows.slice(0, max).join(", ")} +${rows.length - max} more`;
}

/**
 * The single sentence a row shows under its title. Kept beside the state
 * machine so "expired" can never be described as "ready to download".
 */
export function exportStateLabel(state: ExportDownloadState): string {
  switch (state.kind) {
    case "ready":
      return "Tap to download";
    case "pending":
      return "Still building — pull to refresh";
    case "expired":
      return "Download link expired — request a new export";
    case "unavailable":
      return "No download link on this deployment";
    case "failed":
      return state.reason ? `Failed: ${state.reason}` : "Export failed";
  }
}
