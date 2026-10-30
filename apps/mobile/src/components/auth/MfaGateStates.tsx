/**
 * MfaGateStates — the two non-form states of the per-session TOTP gate.
 *
 * Extracted from app/(auth)/totp.tsx so the route module holds the state
 * machine and one view, rather than three full-screen trees inline. The error
 * branch also gains an assertive live region and a spoken announcement:
 * `accessibilityRole="alert"` does not announce on iOS, so a blind user who
 * fell into this state previously heard nothing at all.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MfaCheckingView({ cancelling }: { cancelling: boolean }) {
  const { t } = useTheme();
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={["top", "bottom"]}
    >
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        accessibilityRole="progressbar"
        accessibilityLabel={
          cancelling ? "Switching accounts" : "Checking two-factor status"
        }
      >
        <ActivityIndicator color={t.accent} />
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 12,
            fontFamily: FONT.regular,
          }}
        >
          {cancelling ? "Switching accounts…" : "Checking two-factor status…"}
        </Text>
      </View>
    </SafeAreaView>
  );
}

export function MfaGateErrorView({
  error,
  busy,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
}: {
  error: string;
  busy: boolean;
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const { t } = useTheme();
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={["top", "bottom"]}
    >
      <View
        style={{
          flex: 1,
          padding: 20,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          accessibilityRole="header"
          {...typeCap("title")}
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontWeight: "700",
            fontFamily: FONT.display,
            marginBottom: 8,
          }}
        >
          Couldn&apos;t finish sign-in
        </Text>
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            textAlign: "center",
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
        <Pressable
          onPress={onPrimary}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={primaryLabel}
          accessibilityState={{ disabled: busy, busy }}
          style={{
            marginTop: 18,
            paddingHorizontal: 18,
            paddingVertical: 12,
            borderRadius: 12,
            minHeight: 44,
            justifyContent: "center",
            backgroundColor: t.accent,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color={t.accentFg} />
          ) : (
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accentFg,
                ...typeStyle("callout"),
                fontFamily: FONT.bold,
                fontWeight: "700",
              }}
            >
              {primaryLabel}
            </Text>
          )}
        </Pressable>
        <Pressable
          onPress={onSecondary}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={secondaryLabel}
          style={{
            marginTop: 14,
            padding: 8,
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontFamily: FONT.semibold,
              fontWeight: "600",
            }}
          >
            {secondaryLabel}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
