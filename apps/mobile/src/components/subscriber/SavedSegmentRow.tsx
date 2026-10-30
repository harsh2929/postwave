/**
 * SavedSegmentRow — the saved-audience chips above the subscriber list.
 *
 * Mobile had no saved-view concept at all: the only affordances were four
 * hardcoded status chips, so an operator whose whole workflow is "open
 * Engaged EU" had to reconstruct it by hand on a phone keyboard.
 *
 * Honesty rules, all enforced by src/lib/savedSegments.ts:
 *
 *  - A segment the mobile list CANNOT reproduce exactly is still shown
 *    (with its size) but is disabled, and its spoken label says why. Half-
 *    applying a segment under its own name is the failure this prevents.
 *  - `lastCount === null` means "never evaluated", never zero — it renders
 *    as an em-dash, matching the desktop picker.
 *  - Selection is announced with accessibilityState.selected, and the
 *    active chip is not distinguished by colour alone (the label carries
 *    the state through Chip's own selected treatment).
 *
 * NativeWind v4: static style objects only on Pressable.
 */
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { compactNum, EMDASH } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  reduceSegmentToListView,
  savedSegmentLabel,
  type SavedSegmentRow as SavedSegment,
} from "@/lib/savedSegments";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SavedSegmentChips({
  segments,
  activeId,
  onApply,
  onUnavailable,
  onLongPress,
  trailing,
}: {
  segments: readonly SavedSegment[];
  /** id of the segment currently driving the list, or null. */
  activeId: string | null;
  onApply: (id: string, q: string, statusKey: string) => void;
  /** Called with the reason when a disabled chip is pressed. */
  onUnavailable: (reason: string) => void;
  /**
   * Editor-only management gesture (delete). Omitted for viewers, so the
   * gesture — like every other affordance a role cannot use — simply does
   * not exist rather than failing.
   */
  onLongPress?: ((segment: SavedSegment) => void) | undefined;
  /** Extra chip rendered after the segments (the Save-view affordance). */
  trailing?: ReactNode;
}) {
  const { t } = useTheme();
  if (segments.length === 0 && !trailing) return null;

  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Saved segments
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexDirection: "row", gap: 6, paddingEnd: 8 }}
      >
        {segments.map((segment) => {
          const application = reduceSegmentToListView(segment.predicate);
          const active = segment.id === activeId;
          const usable = application.applicable;
          return (
            <Pressable
              key={segment.id}
              onPress={() => {
                if (!application.applicable) {
                  onUnavailable(application.reason);
                  return;
                }
                haptics.tap();
                onApply(segment.id, application.q, application.statusKey);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: !usable }}
              accessibilityLabel={savedSegmentLabel(segment, application)}
              {...(onLongPress
                ? {
                    onLongPress: () => {
                      haptics.impact();
                      onLongPress(segment);
                    },
                    accessibilityHint: "Long press to delete this saved view.",
                  }
                : {})}
              hitSlop={6}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: 44,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: active ? t.accent : t.border,
                backgroundColor: active ? t.accent : t.surface,
                // Dimmed AND explained on press — never dimmed alone.
                opacity: usable ? 1 : 0.55,
              }}
            >
              {segment.isPinned ? (
                // Decorative glyph standing in for a pin icon; the spoken
                // label already says the segment is pinned.
                <Text
                  allowFontScaling={false}
                  style={{ fontSize: 11 }}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                >
                  📌
                </Text>
              ) : null}
              {/* Both lines are DENSE: the chip carries an explicit
                  `maxWidth: 160` and lives in a horizontal scroller, so it is
                  pinned geometry that cannot reflow. */}
              <Text
                numberOfLines={1}
                {...typeCap("control")}
                style={{
                  color: active ? t.accentFg : t.fg,
                  ...typeStyle("control"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                  maxWidth: 160,
                }}
              >
                {segment.name}
              </Text>
              <Text
                {...typeCap("badgeSmall")}
                style={{
                  color: active ? t.accentFg : t.fgSubtle,
                  ...typeStyle("badgeSmall"),
                  fontFamily: FONT.regular,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {segment.lastCount === null
                  ? EMDASH
                  : compactNum(segment.lastCount)}
              </Text>
            </Pressable>
          );
        })}
        {trailing}
      </ScrollView>
    </View>
  );
}
