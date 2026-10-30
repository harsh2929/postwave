/**
 * serialQueue — run async tasks that share a key strictly one at a time,
 * in submission order.
 *
 * Why this exists: PATCH /api/v1/subscribers/{id} treats `tags` as a
 * FULL-ARRAY REPLACE. Tapping "Add" twice in quick succession fires two
 * overlapping PATCHes computed from two different bases, and whichever
 * response the server commits LAST wins. Add "a" then "b" fast enough and
 * the first request can land second, silently wiping "b".
 *
 * An optimistic cache update fixes the *base* (the second PATCH is
 * computed from `[a]` rather than `[]`), but it cannot fix *ordering* —
 * two in-flight full-replace writes to the same row are a lost-update
 * race no matter what the client renders. Serialising per subscriber id
 * makes the last write the last one the user asked for.
 *
 * Deliberately dependency-free (no react-native, no timers) so it is unit
 * testable under the node environment.
 */

export type SerialQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Create an isolated queue. Tasks sharing a `key` are chained; different
 * keys are independent and may overlap freely.
 *
 * A rejected task never poisons its chain: the next task still runs, and
 * the rejection is delivered only to its own caller.
 */
export function createSerialQueue(): SerialQueue {
  // Tail promise per key. Resolved values are dropped so a long chain
  // never retains task results.
  const tails = new Map<string, Promise<void>>();

  return function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    // `previous` is already swallowed below, so `.then` here always runs.
    const run = previous.then(task);
    // The chain tail must never reject — otherwise one failed tag write
    // would reject every queued write behind it.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    // Drop the entry once the chain drains so a long session browsing
    // thousands of subscribers doesn't leak one promise per id.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/**
 * The app-wide queue for subscriber row writes. Every mutation that does a
 * read-modify-write on the same subscriber row (tags today; merge fields
 * and custom fields when they land) must go through this with the
 * subscriber id as the key.
 */
export const subscriberWriteQueue = createSerialQueue();

/** Queue key for a subscriber-row write. */
export function subscriberWriteKey(id: string): string {
  return `subscriber:${id}`;
}
