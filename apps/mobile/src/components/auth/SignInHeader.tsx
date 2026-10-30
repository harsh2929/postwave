/**
 * SignInHeader — title + the one-sentence explanation of the selected
 * credential method.
 *
 * Extracted from sign-in.tsx (MAP#53): the screen is a state → view switch and
 * a block of static presentation is the cheapest thing to move out of it. The
 * subtitle is a prop rather than derived here so the header cannot disagree
 * with the segmented control that sets the mode.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SignInHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginBottom: 20, marginTop: 12 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("display")}
        style={{
          color: t.fg,
          ...typeStyle("display"),
          fontWeight: "700",
          fontFamily: FONT.display,
          letterSpacing: -0.4,
          marginBottom: 6,
        }}
      >
        {title}
      </Text>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          fontFamily: FONT.regular,
        }}
      >
        {subtitle}
      </Text>
    </View>
  );
}
