/**
 * useApprovalArrivals — the state half of the queue's "N new" affordance
 * (GOVERNANCE#29). The arithmetic and the copy live in
 * `components/approvals/approvalArrivals`, which is import-free and node-tested;
 * this file is only the React wiring, and exists so the route file does not
 * carry six pieces of interlocking state for one behaviour.
 *
 * THE SCOPE ARGUMENT IS LOAD-BEARING. Pending and All are different queries
 * over different sets, and an id list captured from one is meaningless against
 * the other — a hold set carried across a filter switch would withhold the
 * entire new list. Comparing the scope inline (rather than clearing it from an
 * effect) means there is no render in which the wrong hold set is applied.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlatList } from "react-native";

import {
  displayedApprovalIds,
  withheldApprovals,
} from "@/components/approvals/approvalArrivals";

export interface ApprovalArrivalsController<T> {
  /** The rows to render — arrivals withheld. */
  rows: T[];
  /** Arrivals held back behind the pill. */
  newCount: number;
  /** Adopt the arrivals and return to the top of the list. */
  adopt: () => void;
  /** Attach to the list so `adopt` can restore the reading position. */
  listRef: React.RefObject<FlatList<T> | null>;
}

export function useApprovalArrivals<T extends { id: string }>(
  incoming: readonly T[] | undefined,
  scope: string,
): ApprovalArrivalsController<T> {
  const [held, setHeld] = useState<{ scope: string; ids: string[] } | null>(
    null,
  );
  const heldIds = held && held.scope === scope ? held.ids : null;
  const arrivals = useMemo(
    () => withheldApprovals(incoming, heldIds),
    [incoming, heldIds],
  );
  const listRef = useRef<FlatList<T> | null>(null);

  // Seed the hold set from whatever the reader has actually seen: on the first
  // page, after every adopt, and whenever `autoAdopted` reports that the old
  // set no longer matches anything on the wire (a teammate cleared the queue).
  // Without that last case, holding would stay permanently off for this scope.
  useEffect(() => {
    if (incoming === undefined) return;
    if (heldIds === null || arrivals.autoAdopted) {
      setHeld({ scope, ids: displayedApprovalIds(incoming) });
    }
  }, [arrivals.autoAdopted, heldIds, incoming, scope]);

  const adopt = useCallback(() => {
    setHeld(null);
    // Adopted rows land ABOVE the reading position, so return to the top
    // rather than leaving them silently off-screen.
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  return { rows: arrivals.rows, newCount: arrivals.newCount, adopt, listRef };
}
