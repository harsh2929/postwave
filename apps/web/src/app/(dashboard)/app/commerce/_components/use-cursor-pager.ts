// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";

/**
 * Prev/Next over a cursor-paginated endpoint.
 *
 * The server hands out only a forward cursor, so "Previous" is the trail of
 * cursors already visited. The trail is keyed by `identity` (which list, for
 * which catalog): when the identity changes the trail is discarded rather
 * than replayed against a different list, where a stale cursor would be
 * malformed at best and another catalog's page at worst.
 */
export interface CursorPager {
  cursor: string | undefined;
  pageNumber: number;
  hasPrevious: boolean;
  /** Advance to `cursor` — ignored when it was already visited (a loop). */
  next: (cursor: string) => void;
  previous: () => void;
  reset: () => void;
  visited: (cursor: string) => boolean;
}

export function useCursorPager(identity: string): CursorPager {
  const [state, setState] = useState<{ identity: string; trail: string[] }>(
    { identity, trail: [] },
  );
  const trail = state.identity === identity ? state.trail : [];
  const cursor = trail.at(-1);
  return {
    cursor,
    pageNumber: trail.length + 1,
    hasPrevious: trail.length > 0,
    visited: (candidate) => trail.includes(candidate),
    next: (candidate) => {
      if (!candidate || trail.includes(candidate)) return;
      setState({ identity, trail: [...trail, candidate] });
    },
    previous: () => {
      if (trail.length === 0) return;
      setState({ identity, trail: trail.slice(0, -1) });
    },
    reset: () => {
      if (trail.length === 0) return;
      setState({ identity, trail: [] });
    },
  };
}
