/**
 * CollectionCatalogSection — the list, its five states, and the two sentences
 * that stop a page being read as a workspace.
 *
 * WHY THE COVERAGE NOTE IS NOT OPTIONAL. `GET /api/v1/collections` is a keyset
 * page (default 50, max 200 — `types.go:135-136`) beside an exact, filter-wide
 * `total` computed by its own COUNT (`repo.go:113-119`). Those two numbers are
 * the only way a reader can tell "we have 50 reference collections" from "you
 * are looking at the first 50 of 312", and the second is the truth far more
 * often than a phone screen suggests.
 *
 * WHY "LOAD MORE" IS A BUTTON AND NOT AN onEndReached. The list lives inside
 * the screen's ScrollView (rows expand in place, so a virtualised list would
 * fight the expansion), and an infinite scroll that fires on a scroll position
 * inside a parent scroller either never fires or fires constantly. A button is
 * also the honest control here: paging costs a request, and this data changes
 * daily, so nobody benefits from fetching page 4 because a thumb slipped.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { CollectionDetailPanel } from "@/components/collections/CollectionDetailPanel";
import { CollectionRow } from "@/components/collections/CollectionRow";
import type { CollectionDetail, CollectionSummary } from "@/lib/collections";
import {
  collectionCoverageNote,
  collectionEmptyMessage,
  type CollectionTypeFilter,
} from "@/lib/collectionInventory";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CollectionCatalogSectionProps {
  list: QueryLike & {
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    fetchNextPage?: () => unknown;
  };
  items: readonly CollectionSummary[];
  total: number | null;
  gate: { enabled: boolean };
  type: CollectionTypeFilter;
  query: string;
  expandedId: string | null;
  onToggle: (id: string) => void;
  detailAllowed: boolean;
  detail: QueryLike & { data?: CollectionDetail | undefined };
}

export function CollectionCatalogSection({
  list,
  items,
  total,
  gate,
  type,
  query,
  expandedId,
  onToggle,
  detailAllowed,
  detail,
}: CollectionCatalogSectionProps) {
  const { t } = useTheme();
  const hasMore = list.hasNextPage === true;
  const coverage = collectionCoverageNote(items.length, total, hasMore);
  const empty = collectionEmptyMessage(type, query);

  return (
    <View style={{ marginTop: 14 }}>
      {/* Not "Collections" — that is the screen title, and two identical
          headings on one screen is two things a screen reader cannot tell
          apart. This label says which collections: the ones in this
          workspace, filtered by the controls above it. */}
      <SectionLabel topMargin={0}>In this workspace</SectionLabel>
      <QueryStates
        query={list}
        gate={gate}
        isEmpty={items.length === 0}
        offlineMessage="The collection catalogue needs a connection. Reconnect and pull to refresh — this is not the same as having no collections."
        skeleton={<SkeletonList rows={5} lines={2} label="Loading collections" />}
        empty={empty}
      >
        <View>
          {items.map((item) => (
            <View key={item.id}>
              <CollectionRow
                collection={item}
                expanded={expandedId === item.id}
                onToggle={onToggle}
              />
              {expandedId === item.id ? (
                <CollectionDetailPanel
                  allowed={detailAllowed}
                  online={gate.enabled}
                  detail={detail.data}
                  isLoading={detail.isLoading}
                  isError={detail.isError}
                  error={detail.error}
                />
              ) : null}
            </View>
          ))}
        </View>
      </QueryStates>

      {coverage ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 10,
          }}
        >
          {coverage}
        </Text>
      ) : null}

      {hasMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load more collections"
          accessibilityState={{ disabled: list.isFetchingNextPage === true }}
          disabled={list.isFetchingNextPage === true}
          onPress={() => void list.fetchNextPage?.()}
          // Static object — a function style silently drops layout on NativeWind v4.
          style={{
            marginTop: 10,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.borderSubtle,
            backgroundColor: t.surface,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
          >
            {list.isFetchingNextPage === true ? "Loading…" : "Load more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
