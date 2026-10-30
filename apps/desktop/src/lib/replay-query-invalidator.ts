/**
 * Tiny inversion boundary between the transport outbox and TanStack Query.
 *
 * `api-client.ts` owns replay but must not import `query-client.ts`: the query
 * module already imports API helpers, so doing so creates a cycle. A previous
 * dynamic import hid the cycle in source while Rollup correctly pointed out
 * that the module was already on the critical path. The query layer installs
 * its callback when it boots; headless API consumers simply have no callback.
 */

export type ReplayedQueryInvalidator = (prefix: string) => void;

let installedInvalidator: ReplayedQueryInvalidator | null = null;

/** Install (or replace during HMR) the active query invalidator. */
export function installReplayedQueryInvalidator(
  invalidator: ReplayedQueryInvalidator,
): () => void {
  installedInvalidator = invalidator;
  return () => {
    // Do not let disposal of an older HMR instance clear its replacement.
    if (installedInvalidator === invalidator) installedInvalidator = null;
  };
}

/** Best-effort dispatch; replay durability must not depend on UI cache state. */
export function invalidateReplayedQueryPrefix(prefix: string): void {
  try {
    installedInvalidator?.(prefix);
  } catch {
    // The mutation has already reached the server. A cache refresh failure is
    // recoverable through normal refetch/focus behavior and must not replay it.
  }
}
