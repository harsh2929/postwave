/**
 * SuppressionSelectionBar — the bar that appears when the suppressions list is
 * in selection mode.
 *
 * Same shape as SubscriberSelectionBar (long-press a row to enter, tap rows to
 * add/remove, act from a bar pinned above the tab bar, Done to leave) so the
 * two largest lists in the app do not teach two different gestures.
 *
 * The two things it does that a naive port would not:
 *
 *  - IT EXPLAINS ITS OWN UNAVAILABILITY. A viewer or an offline operator gets
 *    the reason as visible text AND as the button's accessibilityHint, rather
 *    than one greyed-out control with no explanation.
 *  - IT SAYS WHAT "ALL" MEANS. Selecting all over a paged list selects the rows
 *    that are LOADED, never the archive, and the button says "loaded" so it
 *    cannot be read as the latter.
 */
import { Text, View } from "react-native";

import { SubActionButton } from "@/components/subscriber/SubActionButton";
import { FONT } from "@/lib/fonts";
import { suppressionSelectionTitle } from "@/lib/suppressionSelection";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SuppressionSelectionBar({
  count,
  loadedCount,
  allLoadedSelected,
  enabled,
  reason,
  pending,
  onRelease,
  onSelectAll,
  onClear,
  onDone,
  t,
}: {
  count: number;
  /** Rows materialised right now — the ceiling "all" means. */
  loadedCount: number;
  allLoadedSelected: boolean;
  enabled: boolean;
  reason?: string | undefined;
  pending: boolean;
  onRelease: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
  t: ThemeTokens;
}) {
  const live = enabled && !pending;
  return (
    <View
      // A distinct region so VoiceOver users can jump to it instead of swiping
      // back through every selected row.
      accessibilityRole="toolbar"
      accessibilityLabel={`${suppressionSelectionTitle(count)}. Bulk actions.`}
      style={{
        borderTopColor: t.border,
        borderTopWidth: 1,
        backgroundColor: t.surface,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 12,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          // Announced on every change so a screen-reader user hears the count
          // move as they tap rows.
          accessibilityLiveRegion="polite"
          numberOfLines={2}
        >
          {suppressionSelectionTitle(count)}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <SubActionButton
            label={allLoadedSelected ? "Clear" : "Select loaded"}
            onPress={allLoadedSelected ? onClear : onSelectAll}
            disabled={loadedCount === 0}
            {...(loadedCount === 0
              ? { disabledReason: "No addresses are loaded yet." }
              : {})}
            t={t}
          />
          <SubActionButton label="Done" onPress={onDone} t={t} />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 8 }}>
        <SubActionButton
          label="Release"
          onPress={onRelease}
          disabled={!live}
          busy={pending}
          danger
          {...(reason ? { disabledReason: reason } : {})}
          t={t}
        />
      </View>

      {reason && !enabled ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {reason}
        </Text>
      ) : null}
    </View>
  );
}
