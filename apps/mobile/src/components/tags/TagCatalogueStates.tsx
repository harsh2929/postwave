/**
 * The tag catalogue's five-state ladder, in one place.
 *
 * Kept out of app/(tabs)/tags.tsx because the screen's own function was
 * carrying the whole ladder inline and had drifted past the complexity
 * budget. The ORDER encoded here is the point:
 *
 *   loading → skeleton shaped like the chip cloud
 *   hard error (nothing cached) → full ErrorState
 *   soft error (rows still on screen) → slim stale banner, keep the rows
 *   gate closed → "reconnect", never "you have no tags"
 *   genuinely empty → empty state
 */
import { View } from "react-native";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton, SkeletonGroup } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";

const SKELETON_WIDTHS = [92, 64, 120, 78, 104, 70, 88, 132];

export function TagCatalogueStates({
  isLoading,
  isError,
  error,
  rowCount,
  query,
  groupName,
  showArchived,
  gateNotice,
  onRetry,
  onClearSearch,
  onGoToSubscribers,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  rowCount: number;
  query: string;
  /** Name of the active tag group, or "" when unfiltered. */
  groupName?: string;
  showArchived: boolean;
  gateNotice: CachedSessionNoticeContent | null;
  onRetry: () => void;
  onClearSearch: () => void;
  /** Routes to the subscribers list — where a tag is actually created. */
  onGoToSubscribers: () => void;
}) {
  if (isLoading) {
    return (
      <SkeletonGroup label="Loading tags">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {SKELETON_WIDTHS.map((width, i) => (
            <Skeleton key={i} width={width} height={44} radius={999} />
          ))}
        </View>
      </SkeletonGroup>
    );
  }
  if (isError) {
    // Rows on screen means the LAST load succeeded — keep them and say so,
    // rather than replacing a working catalogue with an error page.
    return rowCount === 0 ? (
      <ErrorState error={error} onRetry={onRetry} />
    ) : (
      <StaleDataBanner onRetry={onRetry} />
    );
  }
  if (rowCount > 0) return null;
  if (gateNotice) return <CachedSessionNotice notice={gateNotice} />;
  if (query || groupName) {
    // Name BOTH narrowings: "no tags match" over an invisible group filter
    // reads as an empty workspace rather than an active filter.
    return (
      <EmptyState
        title="No tags match"
        description={
          query && groupName
            ? `Nothing matches "${query}" in the ${groupName} group.`
            : query
              ? `Nothing matches "${query}".`
              : `The ${groupName} group has no tags yet.`
        }
        cta={{ label: "Clear filters", onPress: onClearSearch }}
      />
    );
  }
  return (
    <EmptyState
      title="No tags yet"
      // NOT a dead end any more. Tags are not a resource you create: the API
      // has no POST /api/v1/tags — a tag comes into existence the moment it
      // is written onto a subscriber (PATCH /api/v1/subscribers/{id} with
      // `tags`), which this app can already do from a profile and from a
      // multi-select on the subscribers list. Sending the operator to "the
      // web admin" was both a dead end AND wrong about how tags work.
      description={
        showArchived
          ? "A tag appears here the first time you put it on someone. Open a subscriber and add one."
          : "A tag appears here the first time you put it on someone. Open a subscriber and add one. Archived tags are hidden — turn on the Archived filter to include them."
      }
      cta={{ label: "Go to subscribers", onPress: onGoToSubscribers }}
    />
  );
}
