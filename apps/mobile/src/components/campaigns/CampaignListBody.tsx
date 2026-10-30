/**
 * CampaignListBody — the campaigns FlatList and everything attached to it.
 *
 * Extracted from app/(tabs)/campaigns/index.tsx when multi-select pushed that
 * screen's component past its function-length budget. The split is along the
 * same seam the file already had: the screen decides WHAT the list contains
 * (gating, filtering, sorting, selection) and this decides how it scrolls.
 *
 * Everything the original had is preserved deliberately, because each piece
 * fixed something: the ref-bound scroll restoration, the tab-tap
 * scroll-to-top target, the bounded auto-pager's end-reached guard, and the
 * shared perf props.
 */
import { type ReactElement, type RefObject } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  type ScrollView,
  View,
} from "react-native";

import { ScrollToTop } from "@/components/ScrollToTop";
import type { RestoreListScrollBinding } from "@/hooks/useRestoreListScroll";
import type { AgendaEntry } from "@/lib/campaignAgenda";
import type { Campaign } from "@/hooks/useCampaigns";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme } from "@/lib/theme";

type Entry = AgendaEntry<Campaign>;

export interface CampaignListBodyProps {
  entries: readonly Entry[];
  keyExtractor: (entry: Entry) => string;
  renderItem: ListRenderItem<Entry>;
  /** From useRestoreListScroll — the list's ref plus its scroll recorder. */
  scroll: Pick<
    RestoreListScrollBinding<Entry>,
    "ref" | "onScroll" | "scrollEventThrottle"
  >;
  /** Tour target; the screen owns it because the tour registers by name. */
  containerRef: RefObject<View | null>;
  refreshing: boolean;
  onRefresh: () => void;
  onEndReached: () => void;
  empty: ReactElement;
  footer: ReactElement | null;
}

export function CampaignListBody({
  entries,
  keyExtractor,
  renderItem,
  scroll,
  containerRef,
  refreshing,
  onRefresh,
  onEndReached,
  empty,
  footer,
}: CampaignListBodyProps) {
  const { t } = useTheme();
  return (
    <>
      {/*
        Tapping the ALREADY-ACTIVE Campaigns tab returns to the top — the
        baseline iOS gesture, and the other half of remembered scroll: without
        it, restoring your position on every return leaves no cheap way back to
        the newest campaigns.

        react-navigation's `useScrollToTop` subscribes to the tab navigator's
        own `tabPress`, so this needs no change to the tab layout. Its
        `getScrollableNode` dispatches on the ref's own methods and handles
        `scrollToOffset` (a FlatList) before it ever considers `scrollTo` — the
        shared component types its target as a ScrollView only because its
        first caller was one, hence the cast over a structural difference the
        hook does not observe.

        The animated scroll it performs emits `onScroll`, so `scroll.onScroll`
        records the new offset and a later return lands at the top rather than
        back where you were before the gesture.
      */}
      <ScrollToTop
        targetRef={scroll.ref as unknown as RefObject<ScrollView | null>}
      />

      <View ref={containerRef} collapsable={false} style={{ flex: 1 }}>
        <FlatList
          {...MOBILE_LIST_PERF_PROPS}
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          scrollEventThrottle={scroll.scrollEventThrottle}
          data={entries}
          keyExtractor={keyExtractor}
          contentContainerStyle={{
            padding: 16,
            paddingTop: 4,
            paddingBottom: 32,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.35}
          ListEmptyComponent={empty}
          ListFooterComponent={footer}
          renderItem={renderItem}
        />
      </View>
    </>
  );
}
