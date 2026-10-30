/**
 * WinnerBanner (mobile) — RN port of the desktop A/B Results banner.
 *
 * Renders the prominent "Variant N won by X% (Y% confident)" call-out
 * at the top of the mobile A/B Results view when the server marks a
 * winner with confidence >= 0.95; otherwise renders a neutral
 * "no clear winner yet" hint.
 */
import { Text, View } from "react-native";

import { TINT_ALPHA, withAlpha } from "@/lib/color";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export type WinnerMethod = "bayesian" | "frequentist" | "not_decided";

export interface WinnerBannerProps {
  variantIndex: number;
  variantLabel?: string | null;
  liftPercent?: number;
  method: WinnerMethod;
  confidence: number;
}

export function WinnerBanner({
  variantIndex,
  variantLabel,
  liftPercent,
  method,
  confidence,
}: WinnerBannerProps) {
  const { t } = useTheme();
  if (method === "not_decided" || variantIndex < 0) {
    return (
      <View
        style={{
          backgroundColor: t.bgSubtle,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          marginBottom: 12,
        }}
        accessibilityLabel="No clear winner yet"
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontSize: 15,
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          No clear winner yet
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            fontSize: 12,
            marginTop: 4,
            lineHeight: 17,
            fontFamily: FONT.regular,
          }}
        >
          Keep the test running or widen the recipient pool. We&apos;ll mark a
          winner once the challenger crosses 95% confidence.
        </Text>
      </View>
    );
  }
  const labelTxt = variantLabel ?? `Variant ${variantIndex + 1}`;
  const liftTxt = liftPercent != null ? ` by ${liftPercent.toFixed(1)}%` : "";
  const conf = confidence > 1 ? confidence : confidence * 100;
  const methodTxt =
    method === "bayesian" ? "Bayesian P(B>A)" : "frequentist 1−p";
  return (
    <View
      style={{
        backgroundColor: withAlpha(t.success, TINT_ALPHA),
        borderColor: t.success,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
      }}
      accessibilityLabel={`${labelTxt} won${liftTxt}, ${conf.toFixed(1)}% confident`}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          fontSize: 15,
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {labelTxt} won{liftTxt}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          fontSize: 12,
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {conf.toFixed(1)}% confident · {methodTxt}
      </Text>
    </View>
  );
}
