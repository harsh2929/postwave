/**
 * SubscribersHeaderRegion — the block between the screen chrome and the list:
 * search/filter/sort header, the saved-views strip, and the stale-session
 * notice. Extracted verbatim from app/(tabs)/subscribers/index.tsx when the
 * screen hit its function-size budget; the screen still owns every piece of
 * STATE (query, filter, sort, selection) and this region is presentation +
 * the export transport, which is a pure list-surface concern:
 *
 *  - Share the APPLIED view as CSV — the same server export desktop uses
 *    (viewer-scoped), bounded and injection-safe for a share sheet
 *    (hooks/useSubscribersExport).
 *  - Saved views. Applying one sets the SAME q + status the chips drive, and
 *    only segments whose rule the list can reproduce EXACTLY are tappable —
 *    see src/lib/savedSegments.ts. Save/delete are editor verbs and
 *    online-only (a bookmark names the view on screen NOW), so they ride the
 *    same role floor as create plus the live connection.
 */
import { useState } from "react";
import { View } from "react-native";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { SubscriberScoresSheet } from "@/components/subscriber/SubscriberScoresSheet";
import { SubscribersListHeader } from "@/components/subscriber/SubscribersListHeader";
import { SubscribersSavedSegments } from "@/components/subscriber/SubscribersSavedSegments";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSubscribersExport } from "@/hooks/useSubscribersExport";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

export function SubscribersHeaderRegion({
  query,
  draftQuery,
  onQueryChange,
  resultCount,
  filterKey,
  onFilterChange,
  countLine,
  freshness,
  sortKey,
  sortOpen,
  onSortOpen,
  onSortClose,
  onSortChange,
  includeArchived,
  onToggleArchived,
  engineStatus,
  sortField,
  sortOrder,
  serverTotal,
  statusNoun,
  listLoading,
  gateNotice,
  hasRows,
  activeSegmentId,
  onApplySegment,
  canEditSavedViews,
}: {
  /** SETTLED (debounced) query — what the list actually shows. */
  query: string;
  /** The live input draft, for the export settle guard. */
  draftQuery: string;
  onQueryChange: (next: string) => void;
  resultCount: number | undefined;
  filterKey: string;
  onFilterChange: (key: string) => void;
  countLine: string;
  freshness: string;
  sortKey: string;
  sortOpen: boolean;
  onSortOpen: () => void;
  onSortClose: () => void;
  onSortChange: (key: string) => void;
  includeArchived: boolean;
  onToggleArchived: () => void;
  engineStatus: string | undefined;
  sortField: string;
  sortOrder: "asc" | "desc";
  serverTotal: number | undefined;
  statusNoun: string;
  listLoading: boolean;
  gateNotice: CachedSessionNoticeContent | null;
  hasRows: boolean;
  activeSegmentId: string | null;
  onApplySegment: (id: string, q: string, statusKey: string) => void;
  /** Editor+ role floor (the same one create uses); online is checked here. */
  canEditSavedViews: boolean;
}) {
  const online = useIsOnline();
  const gate = useOnlineQueryGate();
  const authMode = useAuthStore((s) => s.mode);
  const [scoresOpen, setScoresOpen] = useState(false);
  // Rule EDITING is the PUT's admin floor; the explorer itself is
  // viewer-scoped and rides the live connection (its reads never cache).
  const canEditRules =
    canAccessMinimumRole("admin", gate.effectiveRole, authMode) &&
    online &&
    !gateNotice;
  const exporter = useSubscribersExport({
    view: {
      query,
      engineStatus,
      sort: sortField,
      order: sortOrder,
      includeArchived,
    },
    serverTotal,
    statusNoun,
    draftQuery,
    loading: listLoading,
    gated: Boolean(gateNotice),
    online,
  });

  return (
    <>
      <SubscribersListHeader
        query={draftQuery}
        onQueryChange={onQueryChange}
        {...(resultCount !== undefined ? { resultCount } : {})}
        filterKey={filterKey}
        onFilterChange={onFilterChange}
        countLine={countLine}
        freshness={freshness}
        sortKey={sortKey}
        sortOpen={sortOpen}
        onSortOpen={onSortOpen}
        onSortClose={onSortClose}
        onSortChange={onSortChange}
        includeArchived={includeArchived}
        onToggleArchived={onToggleArchived}
        onExport={exporter.onExport}
        exporting={exporter.exporting}
        {...(online
          ? {
              onOpenScores: () => {
                haptics.tap();
                setScoresOpen(true);
              },
            }
          : {})}
      />
      {/* Mounted only while open (the TagCreateSheet idiom): a closed sheet
          must not add queries to the screen's hook surface. */}
      {scoresOpen ? (
        <SubscriberScoresSheet
          visible
          canEditRules={canEditRules}
          onClose={() => setScoresOpen(false)}
        />
      ) : null}
      <SubscribersSavedSegments
        activeId={activeSegmentId}
        onApply={onApplySegment}
        view={{
          query,
          statusKey: filterKey,
          includeArchived,
        }}
        canEdit={canEditSavedViews && online}
      />
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        {gateNotice && hasRows ? (
          <CachedSessionNotice notice={gateNotice} variant="stale" />
        ) : null}
      </View>
    </>
  );
}
