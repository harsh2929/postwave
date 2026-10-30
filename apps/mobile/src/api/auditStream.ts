/**
 * api/auditStream.ts — the audit log's live tail, as a TRIGGER.
 *
 * `GET /api/v1/audit/stream` seeds a cursor from the current max id and then
 * emits `event: audit` once per row created after that, every two seconds
 * (apps/api/internal/handlers/audit_extras.go).
 *
 * ── WHO CAN ACTUALLY OPEN IT ───────────────────────────────────────────────
 * The routeauth manifest says `exposure: authenticated` with
 * `session_minimum_role: viewer`, and that is NOT the binding gate. The route
 * is mounted `router.With(gates.raw, …)` where
 * `gates.raw = apikeys.RequireAllScopes(ScopeAuditRead, ScopeAuditReadPII)`
 * (apps/api/internal/server/audit_operations.go), and a presented stream token
 * makes the request API-KEY authenticated (`middleware.WithAPIKeyAuth` +
 * `WithScopes(claims.Scopes)`, internal/apikeys/middleware.go). Stream-token
 * scopes are `[admin]` for owner/admin and otherwise `[read:reports,
 * read:subscribers]` (internal/apikeys/stream_tokens.go), and the mint route
 * is not an audit-RBAC path, so no audit scope is injected there.
 *
 * Net: for a non-owner/non-admin this route answers 403 — permanently, since
 * a fresh token of the same scopes cannot change it. The mobile audit tab has
 * no minimumRole, so those readers DO reach this code. That is exactly why
 * `connectSse` treats an authorization refusal as terminal rather than
 * retrying it: without that, every such reader mints a stream token and eats a
 * 403 every ≤30s for as long as the screen is open. The 20s poll in
 * hooks/useAuditTail is the fallback, and it is untouched by any of this.
 *
 * WHAT IT DELIBERATELY IS NOT USED FOR: rows, or counts. The stream is
 * TENANT-WIDE — it applies none of the actor/window filters the audit screen is
 * showing — so a frame means "something happened in this workspace", never
 * "something matching your filter happened". Counting frames would put a
 * number on screen that the list below it contradicts. hooks/useAuditTail uses
 * a frame only to re-run the filter-aware probe sooner than the 20s poll would.
 *
 * AND NOT EVERY FRAME EVEN MEANS THAT. Reads of the audit surface are
 * themselves audited, and the stream re-emits those meta-rows — including the
 * ones this very tail just wrote. `auditStreamFrameTriggersProbe` drops them;
 * see lib/auditTail for the loop it closes.
 */
import { auditStreamFrameTriggersProbe } from "@/lib/auditTail";

import { connectSse, type SseDisconnect, type SseStatus } from "./sseConnect";
import { buildStreamRequest } from "./streamCredentials";

export const AUDIT_STREAM_PATH = "/api/v1/audit/stream";

export interface AuditStreamHandlers {
  /** A row was written somewhere in this workspace. Carries no payload on
   *  purpose: nothing downstream is allowed to render it. */
  onActivity: () => void;
  onStatus?: (status: SseStatus) => void;
  /** Injectable jitter source; exposed for tests. */
  random?: () => number;
  /** Watchdog window; exposed for tests. */
  stallTimeoutMs?: number;
}

/**
 * The per-investigation status stream —
 * `GET /api/v1/audit/investigations/{id}/stream` (audit_investigations.go)
 * emits `event: hello` at connect and one named event per status transition.
 *
 * Used exactly as the tail stream above is: a TRIGGER, never a payload. A
 * transition frame re-reads the investigations list, which is the projection
 * the sheet actually renders — acting on the frame body would hand an
 * unvalidated wire shape to a render path. The same mount gate as the list
 * (`gates.raw`) governs it, and stream-token scope refusals are terminal in
 * `connectSse`, so a reader whose token cannot open it falls silently back to
 * pull-to-refresh instead of minting a 403 every 30 seconds.
 */
export function connectInvestigationStream(
  investigationId: string,
  handlers: AuditStreamHandlers,
): SseDisconnect {
  return connectSse({
    label: "audit-investigation-stream",
    buildRequest: () =>
      buildStreamRequest(
        `/api/v1/audit/investigations/${encodeURIComponent(investigationId)}/stream`,
      ),
    onFrame: (frame) => {
      // `hello` is the connect handshake, not a transition.
      if (frame.event.trim() === "hello") return;
      handlers.onActivity();
    },
    ...(handlers.onStatus ? { onStatus: handlers.onStatus } : {}),
    ...(handlers.random ? { random: handlers.random } : {}),
    ...(handlers.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: handlers.stallTimeoutMs }
      : {}),
  });
}

export function connectAuditStream(
  handlers: AuditStreamHandlers,
): SseDisconnect {
  return connectSse({
    label: "audit-stream",
    buildRequest: () => buildStreamRequest(AUDIT_STREAM_PATH),
    onFrame: (frame) => {
      // `event: hello` is the cursor seed the server sends at connect. It
      // describes history, not an arrival, so it must not trigger anything —
      // and neither may a row this surface's own reads produced.
      if (!auditStreamFrameTriggersProbe(frame)) return;
      handlers.onActivity();
    },
    ...(handlers.onStatus ? { onStatus: handlers.onStatus } : {}),
    ...(handlers.random ? { random: handlers.random } : {}),
    ...(handlers.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: handlers.stallTimeoutMs }
      : {}),
  });
}
