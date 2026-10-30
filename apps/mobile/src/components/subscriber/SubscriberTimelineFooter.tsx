/**
 * SubscriberTimelineFooter — the tail of the detail screen's FlatList: the
 * timeline's own empty/unavailable/loading state, an explicit
 * "Load older activity" control, and the Suppress action.
 *
 * Split out of SubscriberDetailSections.tsx, which had become a grab-bag
 * that every new profile section made worse.
 *
 * The load-more control exists because the timeline used to auto-fetch
 * forever: a subscriber with tens of thousands of events accumulated all of
 * them in JS memory on a device with far less headroom than a desktop.
 * Auto-paging now stops at a ceiling and continuing becomes a deliberate act.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { Card } from "@/components/subscriber/SubscriberDetailPrimitives";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberTimelineFooter({
  hasSubscriber,
  isSuppressed,
  unavailable,
  timelineLoading,
  eventsCount,
  shownCount,
  facetEmptyMessage,
  timelineFailed,
  fetchingNext,
  suppressPending,
  canSuppress,
  suppressDisabledReason,
  onSuppress,
  autoPagingExhausted,
  onLoadOlder,
}: {
  hasSubscriber: boolean;
  /** Already blocklisted — Suppress is a no-op, so say so. */
  isSuppressed: boolean;
  unavailable: boolean;
  timelineLoading: boolean;
  /** Events the loaded pages contained, BEFORE the facet filter. */
  eventsCount: number;
  /**
   * Rows the facet filter left on screen. When the record has events but the
   * chosen facet matched none of them, the tail must say THAT — rendering the
   * record-level "No activity recorded" would be a claim about the person
   * rather than about the filter. Omit for an unfiltered feed.
   */
  shownCount?: number | undefined;
  /** Scope-honest sentence for that case (see lib/timelineFilter). */
  facetEmptyMessage?: string | undefined;
  timelineFailed: boolean;
  fetchingNext: boolean;
  suppressPending: boolean;
  canSuppress: boolean;
  suppressDisabledReason?: string | undefined;
  onSuppress: () => void;
  /** True once auto-paging has hit its ceiling and more pages exist. */
  autoPagingExhausted: boolean;
  onLoadOlder: () => void;
}) {
  const { t } = useTheme();
  if (!hasSubscriber) return null;

  let timelineTail: ReactNode = null;
  if (unavailable) {
    timelineTail = (
      <Card>
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Timeline unavailable
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          This Moosewave deployment hasn&apos;t enabled the per-subscriber
          timeline yet. Send / open / click events will surface here once the
          API exposes /subscribers/:id/timeline.
        </Text>
      </Card>
    );
  } else if (timelineLoading && eventsCount === 0) {
    timelineTail = (
      <View style={{ padding: 32, alignItems: "center" }}>
        <ActivityIndicator color={t.fgMuted} />
      </View>
    );
  } else if (eventsCount === 0 && !timelineFailed) {
    timelineTail = (
      <Card>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No activity recorded for this subscriber yet.
        </Text>
      </Card>
    );
  } else if (shownCount === 0 && facetEmptyMessage) {
    // The record HAS events; this facet matched none of them.
    timelineTail = (
      <Card>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {facetEmptyMessage}
        </Text>
      </Card>
    );
  } else if (fetchingNext) {
    timelineTail = (
      <View style={{ paddingVertical: 16, alignItems: "center" }}>
        <ActivityIndicator color={t.fgMuted} />
      </View>
    );
  } else if (autoPagingExhausted) {
    timelineTail = (
      <Pressable
        onPress={onLoadOlder}
        accessibilityRole="button"
        accessibilityLabel="Load older activity"
        accessibilityHint={`${plural(eventsCount, "event")} loaded so far`}
        style={{
          marginTop: 8,
          alignSelf: "center",
          paddingVertical: 12,
          paddingHorizontal: 18,
          minHeight: 44,
          justifyContent: "center",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Load older activity
        </Text>
      </Pressable>
    );
  }

  const suppressDisabled = !canSuppress || suppressPending || isSuppressed;

  return (
    <>
      {timelineTail}
      <Pressable
        onPress={onSuppress}
        disabled={suppressDisabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: suppressDisabled }}
        {...(suppressDisabled && !isSuppressed && suppressDisabledReason
          ? { accessibilityHint: suppressDisabledReason }
          : {})}
        style={{
          marginTop: 24,
          paddingVertical: 12,
          minHeight: 44,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.danger,
          backgroundColor: `${t.danger}1a`,
          alignItems: "center",
          justifyContent: "center",
          opacity: suppressDisabled ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.danger,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {isSuppressed
            ? "Already suppressed"
            : suppressPending
              ? "Suppressing…"
              : "Suppress"}
        </Text>
      </Pressable>
    </>
  );
}
