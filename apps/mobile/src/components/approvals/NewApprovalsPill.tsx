/**
 * NewApprovalsPill — "N new requests — tap to load" (GOVERNANCE#29).
 *
 * Deliberately the same object as `AuditTailBanner`, down to the shape, the
 * verb and the 44pt target: both surfaces make the same promise — the list does
 * not move until you say so — and two different-looking controls for one
 * contract would teach the operator that the promise is per-screen.
 *
 * Renders nothing when nothing is held, so the queue does not carry a permanent
 * empty strip above it.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  approvalArrivalLabel,
  approvalArrivalSpokenLabel,
} from "@/components/approvals/approvalArrivals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface NewApprovalsPillProps {
  count: number;
  onLoad: () => void;
}

export function NewApprovalsPill({ count, onLoad }: NewApprovalsPillProps) {
  const { t } = useTheme();
  const label = approvalArrivalLabel(count);
  if (!label) return null;
  return (
    <Pressable
      onPress={onLoad}
      accessibilityRole="button"
      accessibilityLabel={approvalArrivalSpokenLabel(count)}
      // Static style object. A `({ pressed }) => …` callback silently drops
      // layout under NativeWind v4 and this control would collapse to nothing.
      style={{
        minHeight: 44,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 999,
        borderWidth: 1,
        borderColor: t.accent,
        backgroundColor: t.surface,
        paddingHorizontal: 14,
        paddingVertical: 8,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.accent,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
