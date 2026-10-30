/**
 * lib/offlinePersistenceHealth.ts — the encrypted offline queue's budget
 * (NATIVE#45).
 *
 * `secureQueryPersister` chunks the dehydrated client into 40 × 1800-byte
 * SecureStore slots. Past that budget it threw BEFORE touching the manifest —
 * so the previously persisted slot survived untouched, on-disk state FROZE,
 * and every subsequent queued edit was lost on process kill with no banner, no
 * telemetry and no log. `PersistQueryClientProvider` swallows the rejection.
 * Very reachable with `sequenceSave`, which persists a whole `steps[]`
 * snapshot per save.
 *
 * Two changes live here:
 *   1. `trimPersistedMutations` — evict the OLDEST queued mutations until the
 *      payload fits, so the newest edits keep persisting instead of the whole
 *      slot freezing. Pure, so the eviction order is unit-tested.
 *   2. a health record the offline banner / diagnostics screen can read, so an
 *      eviction or a hard overflow is something the user is TOLD about.
 */

export interface OfflinePersistenceHealth {
  /** Queued mutations evicted by the most recent persist, oldest-first. */
  droppedMutations: number;
  /** Persist attempts that could not be written at all. */
  overflows: number;
  /** Size of the payload that last exceeded the budget. */
  lastBytes: number;
  /** The budget it exceeded. */
  limitBytes: number;
  lastAt: number | null;
}

const INITIAL: OfflinePersistenceHealth = {
  droppedMutations: 0,
  overflows: 0,
  lastBytes: 0,
  limitBytes: 0,
  lastAt: null,
};

let health: OfflinePersistenceHealth = INITIAL;
const listeners = new Set<() => void>();

function commit(next: OfflinePersistenceHealth): void {
  health = next;
  for (const listener of [...listeners]) listener();
}

export function getOfflinePersistenceHealth(): OfflinePersistenceHealth {
  return health;
}

export function subscribeOfflinePersistenceHealth(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record that N queued mutations were evicted to fit the budget. */
export function reportOfflinePersistenceEviction(input: {
  dropped: number;
  bytes: number;
  limitBytes: number;
  now?: number;
}): void {
  if (input.dropped <= 0) return;
  commit({
    ...health,
    droppedMutations: health.droppedMutations + input.dropped,
    lastBytes: input.bytes,
    limitBytes: input.limitBytes,
    lastAt: input.now ?? Date.now(),
  });
}

/** Record that a persist could not be written even after evicting everything. */
export function reportOfflinePersistenceOverflow(input: {
  bytes: number;
  limitBytes: number;
  now?: number;
}): void {
  commit({
    ...health,
    overflows: health.overflows + 1,
    lastBytes: input.bytes,
    limitBytes: input.limitBytes,
    lastAt: input.now ?? Date.now(),
  });
}

export function resetOfflinePersistenceHealth(): void {
  commit(INITIAL);
}

/**
 * Drop the OLDEST entries until `measure(kept)` fits `maxBytes`.
 *
 * Oldest-first because a queued write's value decays: the edit a user made
 * twenty minutes ago is the one most likely already superseded, and the one
 * whose expiry window is closest. Returns everything dropped so the caller can
 * report it rather than losing work silently.
 */
export function trimPersistedMutations<T>(
  mutations: readonly T[],
  measure: (kept: readonly T[]) => number,
  maxBytes: number,
): { kept: T[]; dropped: number } {
  const kept = [...mutations];
  let dropped = 0;
  while (kept.length > 0 && measure(kept) > maxBytes) {
    kept.shift();
    dropped += 1;
  }
  return { kept, dropped };
}
