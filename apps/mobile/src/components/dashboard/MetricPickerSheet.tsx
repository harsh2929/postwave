/**
 * MetricPickerSheet — which of the six headline numbers this phone shows.
 *
 * Screen real estate is scarcest on the phone, so the one dashboard control
 * that matters most here is "show me the four numbers I actually check". This
 * is that control.
 *
 * SCOPE, stated in the sheet itself rather than only in a comment: the choice
 * is per DEVICE. The desktop's equivalent menu is also client-side
 * (KpiConfigMenu persists to localStorage per workspace, per browser), so this
 * is not a mobile shortcut — visibility has never been a server fact in this
 * product. ORDER, which IS a server fact, is read from
 * `GET /api/v1/dashboard/layout` and is not editable here: a second ordering
 * authority on the phone would fight the desktop's.
 *
 * The grid can never be emptied. `canHideTile` refuses the last unhide, and
 * the row says why instead of going quietly inert — a disabled control with no
 * explanation reads as a bug.
 *
 * NativeWind v4: every Pressable here uses a STATIC style object.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  canHideTile,
  MOBILE_TILE_LABELS,
  type MobileTileKey,
} from "@/lib/dashboardLayout";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface MetricPickerSheetProps {
  visible: boolean;
  /** Render order, already resolved against the server's saved layout. */
  order: readonly MobileTileKey[];
  hidden: readonly MobileTileKey[];
  onToggle: (tile: MobileTileKey) => void;
  onClose: () => void;
  /** True once the server's saved order has actually been read. */
  orderFromServer: boolean;
}

export function MetricPickerSheet({
  visible,
  order,
  hidden,
  onToggle,
  onClose,
  orderFromServer,
}: MetricPickerSheetProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  if (!visible) return null;

  return (
    <ReducedMotionModal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: t.overlay,
          }}
        />
        <View
          style={{
            backgroundColor: t.surfaceElevated,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderColor: t.border,
            borderWidth: 1,
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 16,
            gap: 12,
            maxHeight: "80%",
          }}
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              alignSelf: "center",
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: t.border,
            }}
          />
          <Text
            {...typeCap("title")}
            style={{
              color: t.fg,
              fontFamily: FONT.display,
              ...typeStyle("title"),
              letterSpacing: -0.3,
            }}
          >
            Choose metrics
          </Text>

          <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
            {order.map((tile) => {
              const isHidden = hidden.includes(tile);
              const allowed = canHideTile(order, hidden, tile);
              return (
                <MetricRow
                  key={tile}
                  label={MOBILE_TILE_LABELS[tile]}
                  shown={!isHidden}
                  disabled={!allowed}
                  onPress={() => {
                    if (!allowed) {
                      haptics.warning();
                      return;
                    }
                    haptics.tap();
                    onToggle(tile);
                  }}
                />
              );
            })}
          </ScrollView>

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {orderFromServer
              ? "Saved on this device. The order comes from the card layout saved for your account, so rearranging it on the desktop moves these too."
              : "Saved on this device. The order follows the card layout saved for your account once it has been read."}
          </Text>

          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              minHeight: 48,
              justifyContent: "center",
              paddingHorizontal: 16,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: t.borderSubtle,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.semibold,
                ...typeStyle("callout"),
                textAlign: "center",
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>
      </View>
    </ReducedMotionModal>
  );
}

function MetricRow({
  label,
  shown,
  disabled,
  onPress,
}: {
  label: string;
  shown: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      // State is announced AND written out beside the row, never carried by
      // colour alone.
      accessibilityState={{ checked: shown, disabled }}
      accessibilityHint={
        disabled
          ? "At least one metric must stay on the dashboard"
          : shown
            ? "Hides this metric on this device"
            : "Shows this metric on this device"
      }
      style={{
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingHorizontal: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: shown ? t.border : t.borderSubtle,
        backgroundColor: shown ? t.surface : "transparent",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: shown ? t.fg : t.fgMuted,
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: shown ? t.accent : t.fgSubtle,
          fontFamily: FONT.semibold,
          ...typeStyle("caption"),
        }}
      >
        {shown ? "Shown" : "Hidden"}
      </Text>
    </Pressable>
  );
}
