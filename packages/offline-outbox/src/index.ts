/**
 * @postwave/offline-outbox — the shared, non-drifting CORE of the offline
 * mutation outbox.
 *
 * Web (apps/web/src/lib/outbox.ts + offline-store.ts) and desktop
 * (apps/desktop/src/lib/…) each own a full outbox engine — storage
 * (IndexedDB vs encrypted vault), the replay/drain loop, and dead-letter UX.
 * Those legitimately differ per surface and stay put. But three things were
 * byte-for-byte identical yet hand-maintained in both (a change had to be
 * applied twice or silently drift): the replay-status union, the attempt
 * budget, and the dead-letter predicate — plus the common OfflineMutation
 * field set. Those move here so they cannot diverge.
 *
 * `isTerminalStatus` is ALSO reconciled here. It looked like a behavioural
 * drift (web's copy returned `failed` as terminal, desktop's did not), but
 * verify-first showed web's copy had ZERO call sites — its drain loop already
 * treats a non-exhausted `failed` item as resumable (it retries on the next
 * drain), identical to desktop. So the correct, non-drifting semantics are
 * desktop's, matching both drain loops; web's local definition was simply
 * dead and inconsistent with its own behaviour. Only `decorrelatedJitter` /
 * retry-delay math stays per-surface for now.
 */

/** The replay lifecycle of a queued mutation (identical on web + desktop). */
export type OfflineReplayStatus =
  | "pending"
  | "replaying"
  | "conflict"
  | "failed"
  | "dead-letter";

/**
 * Per-drain attempt budget. After this many failed attempts in a single
 * drain, an item is moved to `dead-letter` (hard-terminal). Identical on both
 * surfaces.
 */
export const OUTBOX_MAX_ATTEMPTS = 6;

/**
 * The fields every queued mutation carries, regardless of surface. Each client
 * extends this with its own surface-specific fields (web: `query`,
 * `conflictStatus`, `retryableAt`; desktop: `retryAfterMs`, `identity`,
 * journal labels) — so a change to a COMMON field now happens once, here,
 * instead of being hand-mirrored (the drift hazard). The persisted journal
 * still stores each surface's full shape, so adopting this changes no stored
 * format.
 */
export interface OfflineMutationCore {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey: string;
  baseVersion?: string;
  queuedAt: string;
  expiresAt?: string;
  attempts: number;
  status: OfflineReplayStatus;
  lastError?: string;
  resource?: string;
  /**
   * The context epoch in force when this write was QUEUED.
   *
   * Optional because a record persisted by a build that predates the field
   * cannot have one, and because the client may not have seen a response
   * carrying the header yet (cold start, or queued while offline from boot).
   * `isStaleContext` treats an absent value on EITHER side as "cannot tell"
   * and does not refuse — discarding the queue because the answer is unknown
   * would destroy exactly the work the queue exists to protect.
   */
  contextEpoch?: string;
}

/**
 * Whether a mutation is hard-terminal (dead-lettered): explicitly parked, or
 * a `failed` item that has burned the whole attempt budget. Byte-identical to
 * both surfaces' prior local copies. Parameterised on the two fields it reads
 * so either client's fuller `OfflineMutation` satisfies it structurally.
 */
export function isDeadLetter(item: {
  status: OfflineReplayStatus;
  attempts: number;
}): boolean {
  return (
    item.status === "dead-letter" ||
    (item.attempts >= OUTBOX_MAX_ATTEMPTS && item.status === "failed")
  );
}

/**
 * Statuses the replay loop never re-attempts. `conflict` needs a human
 * decision and `dead-letter` has burned the attempt budget; both park an item.
 * `failed` is deliberately NOT terminal — a transiently-failed item keeps
 * retrying on later drains while `attempts < OUTBOX_MAX_ATTEMPTS` (this matches
 * what BOTH surfaces' drain loops actually do).
 */
export function isTerminalStatus(status: OfflineReplayStatus): boolean {
  return status === "conflict" || status === "dead-letter";
}

export {
  isSuppressedByTombstone,
  resourceFromPath,
  type Tombstone,
  type TombstoneCandidate,
} from "./tombstone.js";

export {
  type CacheEpochDecision,
  type ContextScopedMutation,
  decideCacheForEpoch,
  isStaleContext,
  STALE_CONTEXT_MESSAGE,
} from "./context-epoch.js";

// The fixture every replay engine must run through its own replay path. Shipped
// from the package surface rather than a test file so the engines can actually
// import it — see the header of conformance.ts.
export {
  conformanceCases,
  conformanceItem,
  DEFAULT_BINDING,
  failureScenarios,
  minutesAgo,
  partitionByShape,
  scriptedReplay,
  SHAPES_NO_ENGINE_QUEUES,
  type ConformanceBinding,
  type ConformanceCase,
  type ConformanceShape,
  type FailureScenario,
  type InjectedOutcome,
} from "./conformance.js";
