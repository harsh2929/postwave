/**
 * AuthField — the labelled wrapper every auth input sits in, plus the
 * per-field error caption the auth screens never had.
 *
 * Before this, a validation failure produced ONE form-level string at the
 * bottom of a scrolled form ("Email and password are required") while the
 * keyboard covered half the screen — telling the user something was wrong but
 * not where. Desktop keys its errors by field and focuses the first invalid
 * control; this gives mobile the same affordance.
 */
import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AuthField({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  /** Per-field message. Rendered as a caption AND announced as an alert. */
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: error ? t.danger : t.fgMuted,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </Text>
      {children}
      {error ? (
        // Deliberately NOT accessibilityRole="alert": the form-level error is
        // the screen's single alert region, and two competing alerts on one
        // screen make neither reliable. Android still announces via the live
        // region; iOS is served by the screen's announce() at the setError
        // site, where the message is known.
        <Text
          accessibilityLiveRegion="assertive"
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
      ) : hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
