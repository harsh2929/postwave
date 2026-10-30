/**
 * MagicReturnView — the three terminal states of a magic-link return.
 *
 * The failure branch used to offer exactly ONE action, "Back to sign in", at
 * the highest-friction moment in the whole product: the user just tapped a
 * link that did not work. Worse, the screen already computes a precise reason
 * (expired vs state-mismatch vs storage-unavailable) and then did nothing with
 * it. Desktop's equivalent recovery screen offers retry, request-a-new-link,
 * another method, continue-in-browser and support.
 *
 * Retry is offered only when the failure is a transport failure — retrying an
 * expired or replayed token cannot succeed, and a button that is guaranteed to
 * fail is worse than no button.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type MagicReturnViewState = "working" | "fail" | "browser_fallback";

export function MagicReturnView({
  state,
  error,
  onContinueInBrowser,
  onBack,
  onRequestNewLink,
  onRetry,
  onContactSupport,
}: {
  state: MagicReturnViewState;
  error: string;
  onContinueInBrowser: () => void;
  onBack: () => void;
  /** Takes the user to sign-in ready to request a fresh link. */
  onRequestNewLink?: (() => void) | undefined;
  /** Present only when the failure was a transport failure. */
  onRetry?: (() => void) | undefined;
  onContactSupport?: (() => void) | undefined;
}) {
  const { t } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "bottom"]}>
      <View style={{ flex: 1, padding: 20, alignItems: "center", justifyContent: "center" }}>
        {state === "working" ? (
          <>
            <ActivityIndicator color={t.accent} />
            <Text {...typeCap("heading")} style={{
              color: t.fg,
              ...typeStyle("heading"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              marginTop: 16,
            }}>
              Completing sign-in…
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                marginTop: 6,
              }}
            >
              Verifying your magic link.
            </Text>
          </>
        ) : state === "browser_fallback" ? (
          <>
            <Text
              accessibilityRole="header"
              {...typeCap("heading")}
              style={{
                color: t.fg,
                ...typeStyle("heading"),
                fontWeight: "700",
                fontFamily: FONT.display,
                letterSpacing: -0.3,
                marginBottom: 8,
              }}
            >
              Continue in your browser
            </Text>
            <Text {...typeCap("bodySmall")} style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              textAlign: "center",
            }}>
              This sign-in was requested on the web. For your security, the app
              won&apos;t consume a browser link or switch accounts automatically.
            </Text>
            <PrimaryAction label="Continue in browser" onPress={onContinueInBrowser} />
            <SecondaryAction label="Back to sign in" onPress={onBack} />
          </>
        ) : (
          <>
            <Text
              accessibilityRole="header"
              {...typeCap("heading")}
              style={{
                color: t.fg,
                ...typeStyle("heading"),
                fontWeight: "700",
                fontFamily: FONT.display,
                letterSpacing: -0.3,
                marginBottom: 8,
              }}
            >
              Sign-in link didn&apos;t work
            </Text>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                textAlign: "center",
              }}
            >
              {error || "The link may have expired. Request a new one."}
            </Text>
            {onRetry ? (
              <PrimaryAction label="Try again" onPress={onRetry} />
            ) : null}
            {onRequestNewLink ? (
              <PrimaryAction
                label="Request a new link"
                onPress={onRequestNewLink}
                muted={Boolean(onRetry)}
              />
            ) : null}
            <SecondaryAction label="Back to sign in" onPress={onBack} />
            {onContactSupport ? (
              <SecondaryAction label="Contact support" onPress={onContactSupport} />
            ) : null}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function PrimaryAction({
  label,
  onPress,
  muted,
}: {
  label: string;
  onPress: () => void;
  muted?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        marginTop: 14,
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderRadius: 12,
        minHeight: 44,
        justifyContent: "center",
        alignItems: "center",
        minWidth: 220,
        borderWidth: muted ? 1 : 0,
        borderColor: t.border,
        backgroundColor: muted ? t.surface : t.accent,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: muted ? t.fg : t.accentFg,
          ...typeStyle("callout"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SecondaryAction({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        marginTop: 10,
        padding: 10,
        minHeight: 44,
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
