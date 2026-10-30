/**
 * optimisticQueries — the cancel → snapshot → project → roll back triad,
 * written once so every mutation that can honestly predict its own result
 * gets the same, tested behaviour.
 *
 * WHEN OPTIMISM IS CORRECT (and when it is a lie):
 *
 *   YES — a reversible, single-row, low-stakes write whose result the client
 *   already knows: mark-read, pause/resume a flag, add a tag, add a list
 *   membership. The projected state and the server's answer agree, so the
 *   only visible effect is that the UI stops waiting for a round trip.
 *
 *   NO — anything the SERVER computes: a send, a queue fill, a verification
 *   probe, a derived count, a state machine that can reject the transition.
 *   Projecting those means rendering a number the client invented, and the
 *   rollback (a row reappearing, a count jumping back) is more confusing
 *   than a spinner would have been.
 *
 * ORDERING IS A SEPARATE PROBLEM. An optimistic update fixes the BASE a
 * read-modify-write is computed from; it does NOT stop two overlapping
 * full-replace writes to the same row from landing out of order. Anything
 * doing read-modify-write must ALSO go through src/lib/serialQueue.ts.
 *
 * Deliberately free of every react-native import (only a type import from
 * TanStack, which is erased) so the whole triad is unit-testable under the
 * node environment — see optimisticQueries.test.ts, which drives these
 * through a real QueryClient + MutationObserver, failure path included.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Every cache entry an optimistic projection touched, captured BEFORE the
 * projection so `rollbackQueries` can restore it verbatim. This is the
 * mutation's TContext.
 */
export interface OptimisticSnapshot {
  previous: [QueryKey, unknown][];
}

/** A snapshot that rolls back to nothing — for the "no tenant yet" path. */
export function emptySnapshot(): OptimisticSnapshot {
  return { previous: [] };
}

/**
 * Cancel in-flight fetches under `queryKey` (a slower in-flight response
 * would otherwise land on top of the projection and undo it), snapshot every
 * matching entry, then hand each to `update`.
 *
 * `queryKey` is a PREFIX — TanStack's filters compare positionally — so one
 * call patches every mounted variant of a query (each filter tab, each
 * paging/role/mode suffix).
 *
 * INVARIANT: `update` must return `undefined` for an `undefined` input, i.e.
 * never fabricate a cache entry that does not exist. TanStack treats an
 * updater returning `undefined` as "no change", which is also what makes the
 * rollback of a never-populated entry a correct no-op.
 */
export async function optimisticUpdateQueries<TData>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  update: (current: TData | undefined) => TData | undefined,
): Promise<OptimisticSnapshot> {
  await queryClient.cancelQueries({ queryKey });
  const previous = queryClient.getQueriesData<TData>({ queryKey });
  queryClient.setQueriesData<TData>({ queryKey }, (current) => update(current));
  return { previous: previous as [QueryKey, unknown][] };
}

/** Restore every entry captured by `optimisticUpdateQueries`. */
export function rollbackQueries(
  queryClient: QueryClient,
  snapshot: OptimisticSnapshot | undefined,
): void {
  for (const [queryKey, data] of snapshot?.previous ?? []) {
    queryClient.setQueryData(queryKey, data);
  }
}

/** Combine snapshots from several projections into one rollback context. */
export function mergeSnapshots(
  ...snapshots: OptimisticSnapshot[]
): OptimisticSnapshot {
  return { previous: snapshots.flatMap((snapshot) => snapshot.previous) };
}

/**
 * The two mutation callbacks that make a projection safe. `onSettled` is
 * deliberately NOT included: what a given mutation must invalidate is its
 * own business, and forgetting it is loud (the screen keeps the projection)
 * rather than silent.
 */
export interface OptimisticTriad<TVars> {
  onMutate: (variables: TVars) => Promise<OptimisticSnapshot>;
  onError: (
    error: unknown,
    variables: TVars,
    context: OptimisticSnapshot | undefined,
  ) => void;
}

/**
 * Build the pair for one mutation. `queryKey` may be a function when the key
 * depends on the mutation variables (a per-row detail cache, say).
 */
export function optimisticTriad<TData, TVars>(
  queryClient: QueryClient,
  queryKey: QueryKey | ((variables: TVars) => QueryKey),
  update: (current: TData | undefined, variables: TVars) => TData | undefined,
): OptimisticTriad<TVars> {
  return {
    onMutate: (variables) =>
      optimisticUpdateQueries<TData>(
        queryClient,
        typeof queryKey === "function" ? queryKey(variables) : queryKey,
        (current) => update(current, variables),
      ),
    onError: (_error, _variables, context) =>
      rollbackQueries(queryClient, context),
  };
}

/* ---- row-level projections for list caches ---- */

/**
 * Shallow-merge `patch` into the row with this id.
 *
 * Returns the SAME array when nothing matched, so TanStack can skip a
 * re-render, and so a mistargeted id is a visible no-op rather than a
 * silently duplicated row.
 */
export function patchRowById<TRow extends { id: string }>(
  rows: TRow[] | undefined,
  id: string,
  patch: Partial<TRow>,
): TRow[] | undefined {
  if (!rows) return undefined;
  let changed = false;
  const next = rows.map((row) => {
    if (row.id !== id) return row;
    changed = true;
    return { ...row, ...patch };
  });
  return changed ? next : rows;
}

/** Drop the row with this id. Same array back when it was not there. */
export function removeRowById<TRow extends { id: string }>(
  rows: TRow[] | undefined,
  id: string,
): TRow[] | undefined {
  if (!rows) return undefined;
  const next = rows.filter((row) => row.id !== id);
  return next.length === rows.length ? rows : next;
}

/**
 * Append a row unless its id is already present.
 *
 * Idempotent on purpose: the membership write it backs is idempotent
 * server-side (ON CONFLICT DO NOTHING), so re-adding must not render a
 * duplicate that the next refetch then silently removes.
 */
export function appendRowIfAbsent<TRow extends { id: string }>(
  rows: TRow[] | undefined,
  row: TRow,
): TRow[] | undefined {
  if (!rows) return undefined;
  if (rows.some((existing) => existing.id === row.id)) return rows;
  return [...rows, row];
}
