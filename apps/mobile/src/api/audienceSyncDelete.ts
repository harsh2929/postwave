/**
 * api/audienceSyncDelete.ts — DELETE /api/v1/audience-syncs/{id}.
 *
 * A NEW MODULE RATHER THAN A FUNCTION IN api/audienceSyncs.ts, because that
 * module's header records DELETE as deliberately absent. Rewriting a recorded
 * decision in place would erase the reasoning; the note stands for the family
 * it was written about (create/edit — the authoring half), and this module
 * carries the one verb the parity register separated out, with its own reason
 * next to it (see lib/audienceSyncDelete's header for the stopping-half
 * argument and the three server facts).
 *
 * AUTHORIZATION, READ OFF THE GUARD ON THE ROUTE rather than off the generated
 * manifest — the same method api/audienceSyncs.ts uses. The route is mounted
 * `r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete(...)`
 * (sync_handlers.go:55). `ScopeWriteSubscribers` is not in `readOnlyScopes`, so
 * the role check runs, and it IS in `editorWriteScopes` (apikeys/middleware.go:
 * 291-294) — owner, admin and editor may delete; viewer and member may not.
 * Minimum role: EDITOR. The generated manifest agrees
 * (`session_minimum_role: "editor"`), and the parity register's "admin in
 * manifest" does not — the manifest and the guard are the evidence.
 *
 * NO If-Match. `optionalAudienceIfMatch` (handlers.go:682-695) accepts an
 * absent header, and the list this screen holds carries no per-row validator to
 * send; the server's run-lease check refuses a mid-delivery delete either way
 * (syncs.go:713). See the lib header, fact 3.
 *
 * 204 No Content on success, so there is nothing to parse — which is why no
 * parser lives in lib for this call.
 */
import { checkedApiResult, rawRequest } from "./request";

export function audienceSyncDeletePath(id: string): string {
  return `/api/v1/audience-syncs/${encodeURIComponent(id)}`;
}

/**
 * Resolves when the server answered 204. Rejects with the tagged error
 * (`status`/`code` re-tagged by `checkedApiResult`) so the caller can branch on
 * 409 `audience_operation_in_progress` versus a 403 versus an already-gone 404
 * — see `deleteSyncErrorMessage`.
 */
export async function deleteAudienceSync(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("DELETE", audienceSyncDeletePath(id)),
  );
}
