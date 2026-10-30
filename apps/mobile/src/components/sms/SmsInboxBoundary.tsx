import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsInboxBoundary({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }}
    >
      <Text
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fgMuted,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
          textAlign: "center",
          marginTop: 8,
        }}
      >
        {message}
      </Text>
    </View>
  );
}
