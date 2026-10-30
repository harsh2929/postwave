/**
 * hooks/useManualRefresh.ts — pull-to-refresh state that only reflects a
 * REAL pull.
 *
 * `RefreshControl refreshing={query.isFetching}` looks correct and is
 * wrong on any polled query: a background refetch flips `isFetching`, so
 * the spinner appears and disappears on every poll tick. On the
 * Migrations screen — which polls every 5s precisely so an operator can
 * watch a live import — that meant the screen strobed during exactly the
 * window it exists for, reading as a malfunction.
 *
 * The fix (first written inline in approvals.tsx) is to track an explicit
 * flag that only the gesture sets. This hook is that pattern, shared, so
 * the next polled screen inherits it instead of re-deriving it.
 *
 * Usage:
 *   const refresh = useManualRefresh([jobs.refetch, sources.refetch]);
 *   <RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} />
 *
 * COMPLETION IS CONFIRMED PHYSICALLY. A pull-to-refresh is a gesture the user
 * commits to and then stops looking at; the spinner retracting is the only
 * signal it finished, and on a fast connection it retracts before the finger
 * has left the glass. Every other deliberate action in this app answers with a
 * haptic — a tap, a decision, a swipe action — and the single most-repeated
 * gesture on a list screen answered with nothing.
 *
 * It is a `tap()` (selection tick), not `success()`: a refresh that returned
 * the same rows is not an achievement, and the OS success notification is a
 * three-part buzz that is far too loud to fire on every pull. It fires ONLY
 * for a gesture-initiated refresh — `refreshing` is already the flag that
 * excludes background polls, which is the whole reason this hook exists — and
 * never after unmount, so leaving a screen mid-refresh stays silent.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { haptics } from "@/lib/haptics";

export interface ManualRefresh {
  /** True only while a user-initiated refresh is in flight. */
  refreshing: boolean;
  onRefresh: () => void;
}

export function useManualRefresh(
  refetchFns: readonly (() => Promise<unknown>)[],
  options?: { enabled?: boolean },
): ManualRefresh {
  const [refreshing, setRefreshing] = useState(false);
  const enabled = options?.enabled ?? true;
  // The callbacks are usually fresh identities every render (TanStack
  // returns a stable refetch, but callers often pass inline wrappers), so
  // hold them in a ref and keep `onRefresh` itself stable — otherwise the
  // RefreshControl element is rebuilt on every render.
  const fnsRef = useRef(refetchFns);
  fnsRef.current = refetchFns;
  // A refresh resolving after unmount must not setState on a dead tree.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (!enabled) return;
    const fns = fnsRef.current;
    if (fns.length === 0) return;
    setRefreshing(true);
    void Promise.allSettled(fns.map((fn) => fn())).finally(() => {
      if (!mounted.current) return;
      setRefreshing(false);
      haptics.tap();
    });
  }, [enabled]);

  return { refreshing, onRefresh };
}
