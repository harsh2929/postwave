import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { haptics } from "@/lib/haptics";

/**
 * useRefreshControl — one pull-to-refresh idiom for the whole app.
 *
 * The audit found four screens using three different idioms: a hand-rolled
 * `refreshing` useState wrapped around refetch, a direct bind to
 * `query.isFetching`, and (on Plan & usage) no refresh gesture at all. The
 * `isFetching` variant is actively wrong twice over — it spins on every
 * BACKGROUND refetch, and it fires during the FIRST load, so the spinner and
 * the skeleton render on top of each other.
 *
 * `isRefetching` alone fixes only the second half. It is `isFetching &&
 * !isPending`: true on EVERY refetch after the first load, so a poll tick, an
 * invalidation or a reconnect raised the spinner with no finger on the glass,
 * and on iOS a programmatic `refreshing={true}` shifts the list by the
 * control's height. Polled screens (subscriber imports, a helpdesk thread)
 * jumped on every tick.
 *
 * So the spinner is owned by the GESTURE: `pulling` is set by `onRefresh` and
 * cleared when that pull's own refetches settle, and `refreshing` is `pulling`
 * AND-ed with `isRefetching`. The AND is load-bearing. Offline, TanStack pauses
 * the fetch: the refetch promise stays pending and `isRefetching` stays false,
 * so a flag on its own would hang a spinner until the device came back. With
 * the AND the spinner shows only while the pull's fetch is actually on the
 * wire, which is never more than `isRefetching` alone would show.
 *
 * Declared structurally so a screen can pass a hand-composed object when it
 * merges two queries.
 *
 * COMPLETION IS CONFIRMED PHYSICALLY, on the same terms as `useManualRefresh`.
 * A pull-to-refresh is a gesture the user commits to and then stops watching;
 * the spinner retracting is the only signal that it finished, and on a fast
 * connection it retracts before the finger has left the glass. This app answers
 * every other deliberate action with a haptic, and the two shared refresh hooks
 * disagreeing about that would mean the same gesture felt different on two
 * screens for no reason the operator can see.
 *
 * It is `tap()` (a selection tick), never `success()`: a refresh that returned
 * the same rows is not an achievement, and the OS success pattern is a
 * three-part buzz far too loud to fire on every pull. It is bound to the
 * RESOLVED PROMISES of the gesture's own refetches rather than to a
 * `refreshing` true→false transition, because a cache-warm refetch can settle
 * without `isRefetching` ever flipping — a transition watcher would then leave
 * a gesture "armed" and buzz on the next unrelated background refetch instead.
 */
export interface RefreshableQuery {
  isRefetching: boolean;
  refetch: () => unknown;
}

export interface RefreshControlBinding {
  refreshing: boolean;
  onRefresh: () => void;
}

export function useRefreshControl(
  ...queries: readonly RefreshableQuery[]
): RefreshControlBinding {
  const [pulling, setPulling] = useState(false);
  // Only the operator's own pull, and only while its fetch is on the wire.
  const refreshing = pulling && queries.some((q) => q.isRefetching);
  // Queries are re-created objects every render, and a hand-composed binding
  // hands a new `refetch` identity each time. Hold the latest refetchers in a
  // ref (as useManualRefresh does) so `onRefresh` stays one stable callback
  // that still reaches the refetch the screen holds now.
  const refetchersRef = useRef(queries.map((q) => q.refetch));
  refetchersRef.current = queries.map((q) => q.refetch);
  // A refresh that resolves after the screen is gone must stay silent — a
  // buzz from a screen the operator has already left reads as a notification.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onRefresh = useCallback(() => {
    const settled = refetchersRef.current.map((refetch) =>
      Promise.resolve(refetch() as unknown),
    );
    if (settled.length === 0) return;
    setPulling(true);
    void Promise.allSettled(settled).then(() => {
      if (!mounted.current) return;
      setPulling(false);
      haptics.tap();
    });
  }, []);
  return useMemo(() => ({ refreshing, onRefresh }), [refreshing, onRefresh]);
}
