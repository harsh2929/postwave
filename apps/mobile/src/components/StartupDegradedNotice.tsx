/**
 * StartupDegradedNotice — what the user sees when the launch watchdog let the
 * app through before something finished (SHELL#62).
 *
 * The alternative it replaces is not another banner: it is an app that sits on
 * the splash screen forever. So this bar exists to turn an unrecoverable hang
 * into a visible, explainable state — the user is on a screen they can act
 * from, and they are told why it looks wrong.
 *
 * Self-clearing: the reason is DERIVED from the launch gate each render, so if
 * hydration lands late the bar disappears without anyone dismissing it.
 */
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import {
  startupDegradationNotice,
  type StartupDegradation,
} from "@/lib/startupGate";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function StartupDegradedNotice({
  reason,
}: {
  reason: StartupDegradation | null;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();

  if (!reason) return null;

  const notice = startupDegradationNotice(reason);

  return (
    <View
      accessible
      accessibilityRole="alert"
      // One spoken string: a screen reader gets the whole situation in the
      // order a sighted user reads it, not two fragments from two nodes.
      accessibilityLabel={`${notice.title}. ${notice.message}`}
      style={{
        backgroundColor: t.warning,
        paddingTop: insets.top + 8,
        paddingBottom: 10,
        paddingHorizontal: 16,
        gap: 2,
      }}
    >
      {/* Foreground tracks t.warning across themes exactly as OfflineBanner
          does — t.bg is the inverse lightness of t.warning in both themes, so
          it stays AA+ without a new token. */}
      <Text
        {...typeCap("label")}
        style={{
          color: t.bg,
          fontFamily: FONT.bold,
          ...typeStyle("label"),
        }}
      >
        {notice.title}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.bg,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {notice.message}
      </Text>
    </View>
  );
}
