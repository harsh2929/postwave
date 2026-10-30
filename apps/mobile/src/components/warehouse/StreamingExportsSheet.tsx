/**
 * StreamingExportsSheet — the shipped-window history for every streaming
 * connection, one section each, on a bottom sheet.
 *
 * WHY A SHEET AND NOT MORE LIST. The warehouse-runs screen's ScrollView is
 * owned by `WarehouseRunsScreen`, and the streaming dock is mounted BESIDE it
 * (see `StreamingExportsDock`). A second scrolling region stacked under the
 * first would fight it for the thumb; a sheet gets its own scroll, its own
 * pull-to-refresh, and a real Done control, and leaves the batch list exactly
 * as it was.
 *
 * A11Y: `accessibilityViewIsModal` keeps VoiceOver inside the sheet; Done is a
 * real ≥44pt button and the backdrop is only a pointer convenience.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { StreamingConnectionSection } from "@/components/warehouse/StreamingConnectionSection";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { FONT } from "@/lib/fonts";
import type { StreamingConnectionEntry } from "@/lib/streamingExportVerdict";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface StreamingExportsSheetProps {
  visible: boolean;
  onClose: () => void;
  entries: readonly StreamingConnectionEntry[];
  /** The dock's history query has not produced data yet. */
  loading: boolean;
  refetch: () => Promise<unknown>;
  gate: Pick<OnlineQueryGate, "enabled">;
}

export function StreamingExportsSheet({
  visible,
  onClose,
  entries,
  loading,
  refetch,
  gate,
}: StreamingExportsSheetProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const refresh = useManualRefresh([refetch], { enabled: gate.enabled });

  return (
    <ReducedMotionModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flex: 1, backgroundColor: t.overlay }}
      />
      <View
        accessibilityViewIsModal
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "85%",
          backgroundColor: t.bg,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          paddingTop: 14,
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 12) + 8,
          borderColor: t.border,
          borderWidth: 1,
        }}
      >
        <Text
          accessibilityRole="header"
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Streaming exports
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          The newest 50 windows per connection, as the server keeps them.
          Shipping a window is a web-admin action.
        </Text>
        <ScrollView
          style={{ flexGrow: 0, marginTop: 8 }}
          contentContainerStyle={{ paddingBottom: 8 }}
          refreshControl={
            <RefreshControl
              refreshing={refresh.refreshing}
              onRefresh={refresh.onRefresh}
              enabled={gate.enabled}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
        >
          {entries.map((entry) => (
            <StreamingConnectionSection
              key={entry.connectionId}
              entry={entry}
              loading={loading}
              offline={!gate.enabled}
            />
          ))}
        </ScrollView>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
          style={{
            minHeight: 44,
            marginTop: 6,
            paddingVertical: 12,
            borderRadius: 12,
            borderColor: t.border,
            borderWidth: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.semibold,
            }}
          >
            Done
          </Text>
        </Pressable>
      </View>
    </ReducedMotionModal>
  );
}
