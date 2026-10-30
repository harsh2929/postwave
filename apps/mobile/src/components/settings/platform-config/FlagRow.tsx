/**
 * FlagRow — one flag on the Settings card. For an admin it is a button that
 * opens the override sheet on that row; below admin it is the plain read-only
 * Row the card always had, with no affordance that would 403.
 */
import { Pressable } from "react-native";

import { Row } from "@/components/settings/SettingsScreenPrimitives";
import { haptics } from "@/lib/haptics";
import type { FeatureFlagView } from "@/lib/platformConfig";

export function FlagRow({
  flag,
  value,
  onPress,
}: {
  flag: FeatureFlagView;
  /** The card's own value line — computed by the card, rendered here. */
  value: string;
  /** Absent below admin: the row is then not a control. */
  onPress?: (() => void) | undefined;
}) {
  const row = <Row label={flag.key} value={value} />;
  if (!onPress) return row;
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`Edit flag ${flag.key}`}
      accessibilityHint={
        flag.isDefault
          ? "Opens a sheet to create this workspace's override."
          : "Opens a sheet to change or remove this workspace's override."
      }
    >
      {row}
    </Pressable>
  );
}
