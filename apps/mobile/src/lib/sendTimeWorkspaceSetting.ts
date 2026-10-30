/**
 * lib/sendTimeWorkspaceSetting.ts — the workspace default for send-time
 * optimization on NEW campaigns.
 *
 * GET/PUT /api/v1/settings/send-time-optimization (apps/api/internal/settings/
 * send_time_optimization.go) — both ADMIN in the routeauth manifest, which is
 * the same floor the whole send-time screen already carries, so the toggle
 * lands there without adding a role seam. Wire shape is {enabled: bool} both
 * ways (PUT takes a pointer — the body must carry the field explicitly).
 */

export function readSendTimeSetting(data: unknown): boolean | null {
  if (!data || typeof data !== "object") return null;
  const enabled = (data as { enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : null;
}
