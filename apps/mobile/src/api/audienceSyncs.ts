/**
 * api/audienceSyncs.ts — transport for reverse-ETL audience syncs.
 *
 * Every route below was read off the chi mount at
 * `apps/api/internal/audience_destinations/sync_handlers.go::MountSyncRoutes`
 * (lines 41-59), and its authorization off the GUARD ON THE ROUTE rather than
 * off the generated manifest:
 *
 *   GET  /api/v1/audience-syncs            RequireScope(read:subscribers)  → {items:[Sync]}
 *   GET  /api/v1/audience-syncs/{id}/runs  RequireScope(read:subscribers)  → {items:[SyncRun]}
 *   POST /api/v1/audience-syncs/{id}/run   RequireScope(write:subscribers) → 200 SyncRun
 *
 * WHAT THAT MEANS FOR ROLES, traced through `apikeys.RequireScope`
 * (apikeys/middleware.go:183-225) rather than assumed:
 *   - `ScopeReadSubscribers` is in the `readOnlyScopes` allowlist
 *     (middleware.go:332-337), so `requireAdminRoleForScopes` is false and ANY
 *     authenticated dashboard session clears the reads — viewer included.
 *   - `ScopeWriteSubscribers` is NOT read-only, so the role check runs; it is
 *     in `editorWriteScopes` (middleware.go:291-294), so owner, admin AND
 *     editor may run a sync, and viewer/member may not. Minimum role: editor.
 *
 * DELIBERATELY NOT HERE, each for a reason rather than for time:
 *   - POST /audience-syncs (create): authoring a sync means picking a source
 *     list or segment, a destination type, an HTTPS receiver URL and an HMAC
 *     signing secret — a keyboard-and-clipboard job whose validation
 *     (`validateCreate`, syncs.go:244) rejects nine distinct shapes. A phone is
 *     the wrong device and a half-validated form here would just teach people
 *     the errors.
 *   - PATCH /{id}: the destination block round-trips a MASKED config, and the
 *     write path must strip the "••••" sentinel or it overwrites a real stored
 *     credential with four bullets (`stripMaskedConfigKeys`, syncs.go:418). A
 *     mobile editor that got that wrong would silently destroy a credential.
 *   - DELETE /{id}: cascades every run in the ledger with no undo anywhere in
 *     the API, and is not a thing anyone needs to do from a phone.
 *   - GET /{id}: the list already returns the FULL sync row —
 *     `syncSelectColumns` is shared verbatim by `ListSyncs` and `GetSync`
 *     (syncs.go:434, :465) — so a per-row detail fetch would cost a request and
 *     return bytes we already hold.
 *
 * Parsing lives in lib/audienceSyncs so it is unit-testable in the node vitest
 * environment; this module is only URLs and envelopes.
 */
import {
  parseRunNowResult,
  parseSyncList,
  parseSyncRunList,
  type AudienceSync,
  type AudienceSyncRun,
} from "@/lib/audienceSyncs";

import { checkedApiResult, rawRequest } from "./request";

export const AUDIENCE_SYNCS_PATH = "/api/v1/audience-syncs";

export function audienceSyncPath(id: string): string {
  return `${AUDIENCE_SYNCS_PATH}/${encodeURIComponent(id)}`;
}

export function audienceSyncRunsPath(id: string): string {
  return `${audienceSyncPath(id)}/runs`;
}

export function audienceSyncRunNowPath(id: string): string {
  return `${audienceSyncPath(id)}/run`;
}

export async function fetchAudienceSyncs(): Promise<AudienceSync[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", AUDIENCE_SYNCS_PATH),
  );
  return parseSyncList(res.data);
}

/**
 * `ListSyncRuns` calls `GetSync` first (sync_handlers.go:205), so a deleted
 * sync 404s here rather than answering an empty list — an empty list would read
 * as "this sync has never run", which is a different and wrong claim. The
 * handler comment says exactly that.
 */
export async function fetchAudienceSyncRuns(
  id: string,
): Promise<AudienceSyncRun[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", audienceSyncRunsPath(id)),
  );
  return parseSyncRunList(res.data);
}

/**
 * 200 with the CLOSED run row — the run executes INLINE in the handler under a
 * sixty-second bound, so this promise resolving means "the run is over", not
 * "a run has started". A FAILED run resolves too, with `status:"failed"`, so
 * every caller must read the returned row (see lib/audienceSyncRunNow).
 *
 * The `idempotencyKey` is passed explicitly rather than left to the SDK's
 * auto-mint so that a caller-level retry — a user tapping again after the
 * client's thirty-second timeout — converges on the SAME server-side operation
 * (`manualOperationKey`, operation_safety.go:40) instead of opening a second
 * delivery to the destination.
 */
export async function runAudienceSyncNow(
  id: string,
  idempotencyKey: string,
): Promise<AudienceSyncRun | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", audienceSyncRunNowPath(id), undefined, {
      idempotencyKey,
    }),
  );
  return parseRunNowResult(res.data);
}
