/**
 * lib/offlineEntityWrite.ts — the GENERIC offline write (NATIVE#1).
 *
 * The queue used to hold exactly three hand-written mutations: a campaign
 * subject edit and two sequence writes. Every other edit in the app — creating
 * a list or a tag, adding someone to a list, editing a segment or a form
 * draft — simply failed while offline, on the one device that is offline most
 * often. Desktop has queued generically against a table of route shapes since
 * its first offline pass (apps/desktop/src/lib/offline-store.ts).
 *
 * Renaming a tag and editing a subscriber are NOT on that list: both PATCHes
 * need a strong If-Match the server checks before anything else, and a queued
 * record carries none, so lib/offlineQueueSafety keeps them online-only.
 *
 * This is the mobile equivalent: ONE registered mutation whose variables carry
 * the verb, path and body, so a screen adds offline support by passing a
 * stable mutationKey and `offlineSafeMutationMeta` rather than by adding code
 * here.
 *
 * The safety argument, in order:
 *
 *   1. `isQueueableMutation` (lib/offlineQueueSafety.ts) is re-checked HERE,
 *      at replay time, not only when the screen enqueued. A queued record is
 *      written to encrypted disk and rehydrated by a possibly-newer build, so
 *      the executor cannot trust that it was produced under today's rules.
 *   2. `assertCurrentAuthScope` re-proves origin + tenant + principal + role
 *      (lib/offlineMutationScope.ts).
 *   3. `operationId` travels as the Idempotency-Key, so a replay that races a
 *      successful earlier attempt cannot double-apply.
 *
 * A record that fails any of these is recorded as a visible failure rather
 * than dropped: the whole point of the queue is that work is never lost
 * silently.
 */
import { isSuppressedByTombstone } from "@postwave/offline-outbox";
import type { QueryClient } from "@tanstack/react-query";

import {
  entityWriteLabel,
  safeInvalidateRoots,
  type EntityWriteVars,
} from "./offlineEntityWriteContract";
import { OFFLINE_MUTATION_KEYS } from "./offlineMutationContract";
import { recordOfflineMutationFailure } from "./offlineMutationFailures";
import {
  assertCurrentAuthScope,
  assertOperationId,
  OfflineMutationReplayError,
} from "./offlineMutationScope";
import { isQueueableMutation, normalizeQueuePath } from "./offlineQueueSafety";
import { readTombstones } from "./tombstones";
import { trackOfflineReplay } from "./offlineReplayTelemetry";

/**
 * Replay one queued entity write. Exported for tests; production callers go
 * through the registered mutation default.
 */
export async function executeEntityWrite(vars: EntityWriteVars) {
  const { client } = assertCurrentAuthScope(vars.auth);
  assertOperationId(vars.operationId);
  const path = normalizeQueuePath(vars.path);
  if (path === null || !isQueueableMutation(vars.method, path, vars.body)) {
    throw new OfflineMutationReplayError(
      "not_queueable",
      "This queued change is no longer eligible to sync automatically. Review and submit it again.",
    );
  }
  // The target was deleted after this write was queued. Replaying it recreates
  // a record the user deleted and watched go — from a device they are not
  // looking at, and under an erasure request, after a documented deletion.
  //
  // Recorded as a visible outcome rather than thrown as a failure: nothing went
  // wrong and there is nothing to retry. The rule itself lives in
  // @postwave/offline-outbox, shared with web and desktop, because three copies
  // of "should this still be sent" is how three engines come to disagree about
  // a deleted record.
  if (
    vars.queuedAt !== undefined &&
    isSuppressedByTombstone(
      { method: vars.method, path, queuedAt: vars.queuedAt },
      await readTombstones(),
    )
  ) {
    throw new OfflineMutationReplayError(
      "target_deleted",
      "This change was not applied because the record was deleted.",
    );
  }

  // Send the NORMALISED path, never the raw one, so what was validated is
  // exactly what is requested.
  return client.request(vars.method, path, {
    ...(vars.body === undefined ? {} : { body: vars.body }),
    idempotencyKey: vars.operationId,
  });
}

/**
 * Register the generic queue. Called from registerOfflineMutationDefaults so
 * there remains exactly one place the root layout has to run before the
 * persister rehydrates and resumes paused mutations.
 */
export function registerEntityWriteMutationDefaults(qc: QueryClient): void {
  qc.setMutationDefaults(OFFLINE_MUTATION_KEYS.entityWrite, {
    // REPLAY IS SERIAL. Without a scope, `resumePausedMutations()` fires every
    // queued write at once (`Promise.all` over the paused set, mutationCache.js)
    // because `canRun` returns true unconditionally for an unscoped mutation.
    // Two queued edits to the SAME record then race, and the loser is silently
    // overwritten — a lost update on the device that is offline most often.
    //
    // Web and desktop avoid this with per-resource FIFO buckets in their drain
    // loops. Mobile has no drain loop to bucket, and `scope.id` must be static
    // here (it is read off the mutation's own options, which cannot see the
    // variables), so the safe choice is ONE scope for every offline entity
    // write: strictly first-in-first-out across the whole queue.
    //
    // The cost is that unrelated records no longer replay in parallel. That is
    // the right trade for a queue whose entire purpose is not losing work, and
    // it is strictly stronger than what web and desktop guarantee.
    scope: { id: "postwave-offline-entity-write" },
    mutationFn: executeEntityWrite,
    onSuccess: (_data, vars: EntityWriteVars) => {
      trackOfflineReplay("entity_write", "success", vars.auth);
      for (const root of safeInvalidateRoots(vars.invalidateRoots)) {
        void qc.invalidateQueries({ queryKey: [root] });
      }
    },
    onError: (error, vars: EntityWriteVars) => {
      trackOfflineReplay("entity_write", "failure", vars.auth, error);
      void recordOfflineMutationFailure({
        auth: vars.auth,
        kind: "entity_write",
        label: entityWriteLabel(vars),
        operationId: vars.operationId,
        error,
      });
    },
  });
}

export {
  entityWriteLabel,
  safeInvalidateRoots,
  type EntityWriteMethod,
  type EntityWriteVars,
} from "./offlineEntityWriteContract";
