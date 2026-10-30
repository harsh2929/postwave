/**
 * A queued write belongs to the context it was made in.
 *
 * Every surface queues writes while offline and replays them on reconnect. The
 * replay authenticates as whoever is signed in NOW — which is usually the same
 * person in the same workspace with the same role, and occasionally is not:
 *
 *   - an admin demotes the user to viewer while their laptop is shut. On
 *     reconnect the queued edit replays and either fails confusingly or, if the
 *     server's check is coarser than the UI's, succeeds as an action they are
 *     no longer allowed to take.
 *   - the user switches workspace. The queued write carries an absolute path
 *     with an id from the OLD workspace, and the id space does not overlap, so
 *     it either 404s or — worse where ids are guessable — lands somewhere.
 *   - the user signs out and a colleague signs in on the same machine. The
 *     queue is per-identity on every surface, so this is mostly handled; what
 *     is not handled is the same identity whose ROLE or PLAN changed.
 *
 * The server stamps `X-Postwave-Context-Epoch` on every response — one value
 * that moves whenever what the caller may see or do changes. Recording it on
 * the mutation and comparing at replay turns "is this still the same context?"
 * into a string comparison, instead of each surface re-deriving an answer from
 * role, tenant and plan separately and disagreeing about it.
 *
 * WHY REFUSE RATHER THAN RETRY. A context change is not transient. Retrying
 * cannot fix it, and a queue that keeps a permanently-unreplayable item alive
 * eventually burns its attempt budget and reports a failure whose cause has
 * scrolled away. The write is surfaced to the person instead — it is their
 * work, and only they can decide whether it still applies.
 */

/** The fields the rule reads. Every surface's fuller mutation type satisfies it. */
export interface ContextScopedMutation {
  /**
   * The epoch in force when this write was QUEUED. Undefined on records
   * persisted by a build that predates the field, which are deliberately not
   * refused: the rule needs both sides to compare, and refusing on a missing
   * value would discard work for a context that may not have changed at all.
   */
  contextEpoch?: string;
}

/**
 * Whether a queued mutation was made in a context the caller has since left.
 *
 * Both sides must be present and different. An absent current epoch means the
 * client has not yet seen a response carrying one — at boot, or offline — and
 * treating "not yet known" as "changed" would discard the entire queue on every
 * cold start, which is exactly the work the queue exists to protect.
 */
export function isStaleContext(
  mutation: ContextScopedMutation,
  currentEpoch: string | undefined | null,
): boolean {
  const queued = mutation.contextEpoch;
  if (!queued || !currentEpoch) return false;
  return queued !== currentEpoch;
}

/**
 * The message a person sees when their queued work is refused for this reason.
 *
 * Deliberately not "something went wrong": nothing did. Their permissions or
 * workspace changed while the work was waiting, which is a fact about their
 * account rather than a failure of the app, and the sentence has to say so or
 * the only available reading is "it broke".
 */
export const STALE_CONTEXT_MESSAGE =
  "This change was made before your workspace or permissions changed, so it was not applied. Review it and submit again if it still applies.";

/**
 * What to do with a PERSISTED cache when a response arrives carrying an epoch.
 *
 * This is a different question from `isStaleContext`, and conflating them is
 * what left a real hole. That rule governs QUEUED WRITES and must never refuse
 * on an unknown — discarding work because the answer is not yet known is worse
 * than replaying it. This rule governs a CACHE, where the safe default is the
 * opposite: a cache is disposable, and serving one answer computed under
 * permissions the person no longer has is the failure being prevented.
 *
 * THE CASE IT EXISTS FOR. Every surface persists its query cache across
 * restarts, keyed by a buster built from app version + user id + tenant id. A
 * demotion changes NONE of those, so the buster is byte-identical and the
 * pre-demotion cache rehydrates and paints. The in-memory epoch is undefined at
 * that moment, so the first response's epoch is a FIRST SIGHTING — deliberately
 * not treated as a change — and nothing clears. The two rules that are each
 * correct on their own ("don't clear on first sighting", "don't persist the
 * epoch") combine to guarantee the widest-gap case is never caught.
 *
 * Comparing against the epoch the PERSISTED CACHE was written under closes it
 * without weakening either: the queue still refuses nothing on an unknown, and
 * a cache whose provenance cannot be established is simply dropped.
 */
export interface CacheEpochDecision {
  /** True when the persisted cache was built under a different context. */
  clearCache: boolean;
  /** The value to persist for next launch. */
  persist: string;
}

export function decideCacheForEpoch(
  persisted: string | undefined | null,
  observed: string,
): CacheEpochDecision {
  const seen = (persisted ?? "").trim();
  const now = observed.trim();
  // Nothing observed: say nothing, change nothing. An unauthenticated response
  // carries no epoch, and treating that as evidence would clear on every
  // public request.
  if (!now) return { clearCache: false, persist: seen };
  // FIRST EVER LAUNCH, or a cache written before this field existed. There is
  // no evidence the cache is stale — but there is also none that it is fresh.
  // Not clearing is the deliberate choice: a build that adds this field would
  // otherwise wipe every user's cache exactly once, which looks like a bug and
  // teaches nothing. From here on the provenance is known.
  if (!seen) return { clearCache: false, persist: now };
  return { clearCache: seen !== now, persist: now };
}
