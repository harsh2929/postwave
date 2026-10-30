/**
 * useSavedSegments — the workspace's saved-audience bookmarks (SUB-040).
 *
 *   GET /api/v1/segments/saved
 *   → { items: SavedSegment[], total_items, max_items }
 *
 * Returns workspace-visible bookmarks plus the caller's own personal ones,
 * so the row is already scoped correctly; mobile does no extra filtering.
 *
 * Not the SDK's segments resource: this is the SAVED-segment library
 * (bookmarks over the subscriber directory), a different family from
 * `/api/v1/segments` (the rule-tree segments the Segments tab lists).
 *
 * Whether a given bookmark can actually be applied to the mobile list is
 * decided by `reduceSegmentToListView` in src/lib/savedSegments.ts — this
 * hook only fetches.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseSavedSegments,
  type SavedSegmentRow,
} from "@/lib/savedSegments";

export function savedSegmentsKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["saved-segments", tenantId ?? null];
}

export function useSavedSegments() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: savedSegmentsKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Bookmarks are edited on the desktop, rarely, and this row sits above
    // a list the operator re-enters constantly.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SavedSegmentRow[]> => {
      const { client } = getClient();
      return parseSavedSegments(
        await client.request<unknown>("GET", "/api/v1/segments/saved"),
      );
    },
  });
}
