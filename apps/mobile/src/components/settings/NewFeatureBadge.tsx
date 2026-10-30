/**
 * NewFeatureBadge — the mobile twin of desktop's NewBadge.tsx.
 *
 * Renders a small "New" pill beside a navigation row while the feature's
 * registry entry (src/lib/newFeatures.ts) is inside its 30-day window, and
 * nothing at all after that. Stateless on purpose — see the lib header.
 *
 * The pill's meaning is carried on the accessibility label ("New feature:
 * <label>") because "New" alone is noise to a screen reader mid-row.
 */
import { Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { isFeatureNew, newFeatureLabel } from "@/lib/newFeatures";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function NewFeatureBadge({ featureKey }: { featureKey: string }) {
  const { t } = useTheme();
  if (!isFeatureNew(featureKey)) return null;
  const label = newFeatureLabel(featureKey);
  return (
    <Text
      accessibilityLabel={label ? `New feature: ${label}` : "New feature"}
      {...typeCap("badgeSmall")}
      style={{
        ...typeStyle("badgeSmall"),
        color: t.accentFg,
        backgroundColor: t.accent,
        fontFamily: FONT.semibold,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      New
    </Text>
  );
}
