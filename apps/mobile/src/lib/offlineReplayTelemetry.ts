/**
 * lib/offlineReplayTelemetry.ts — release-health for the offline write queue.
 *
 * Split out of lib/offlineMutations.ts so the generic entity-write executor
 * (lib/offlineEntityWrite.ts, NATIVE#1) reports through exactly the same
 * event and error taxonomy as the three original hand-written mutations,
 * instead of growing a second one.
 *
 * `source` is a bounded slug, never a path: telemetry.ts's SAFE_STRING_VALUE
 * allowlist would drop anything containing a slash anyway, and a queued path
 * can carry an entity id.
 */
import { EVENTS } from "@postwave/telemetry";

import type { OfflineMutationAuthScope } from "./offlineMutationContract";
import { track } from "./telemetry";

const MAX_REPLAY_DURATION_MS = 24 * 60 * 60 * 1000;

/** Map a replay error onto the operational category the dashboards use. */
export function offlineReplayErrorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (
    code === "missing_scope" ||
    code === "expired" ||
    code === "identity_mismatch" ||
    code === "not_queueable"
  ) {
    return code;
  }
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403) return "authorization";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500) return "server";
  return "unknown";
}

export function trackOfflineReplay(
  source: string,
  outcome: "success" | "failure",
  auth: OfflineMutationAuthScope,
  error?: unknown,
): void {
  const duration = Math.max(0, Date.now() - auth.queuedAt);
  track(EVENTS.MOBILE_OFFLINE_REPLAY_COMPLETED, {
    source,
    outcome,
    duration_ms: Math.min(duration, MAX_REPLAY_DURATION_MS),
    ...(outcome === "failure"
      ? { error_code: offlineReplayErrorCode(error) }
      : {}),
  });
}
