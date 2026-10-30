/**
 * AppErrorBoundary — root error boundary. Re-exported as `ErrorBoundary`
 * from app/_layout.tsx, which is the Expo Router convention for catching
 * render errors in the whole route tree. Without it, an uncaught render
 * error drops the user to a blank white screen with no recovery.
 *
 * Still deliberately provider-independent — the thing that crashed may BE a
 * provider — but no longer hardcoded (NATIVE#41):
 *
 *   - Colours come from @postwave/design-tokens, the same source lib/theme.ts
 *     uses, selected with react-native's `Appearance` module rather than a
 *     React context. A light-mode user used to get a near-black card at the
 *     worst possible moment.
 *   - The card now shows a SUPPORT REFERENCE (error type + server request id +
 *     build) and offers "Share details", matching apps/desktop's ErrorScreen.
 *     The crash already reached Sentry; the user had no way to say WHICH crash
 *     they hit.
 *
 * Message redaction lives in lib/rootErrorReport.ts and is unit-tested — an
 * error string put on screen is a string the user may screenshot into a shared
 * channel.
 *
 * TYPE. Every node is on the shared Dynamic Type scale (lib/typeScale), which
 * is import-free by construction and therefore safe to reach for here: this
 * component must not depend on a provider, and typeScale has no react-native,
 * theme, or context dependency at all. A recovery screen whose "Try again"
 * label clips at a large accessibility size is a recovery screen with no
 * recovery.
 */
import { dark, light } from "@postwave/design-tokens";
import type { ErrorBoundaryProps } from "expo-router";
import { useEffect, useMemo } from "react";
import {
  Appearance,
  Pressable,
  ScrollView,
  Share,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { buildRootErrorReport, rootErrorShareText } from "@/lib/rootErrorReport";
import { captureRootError } from "@/lib/sentry";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AppErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    captureRootError(error);
  }, [error]);

  // Read once per mount, not through a context: a crashed ThemeProvider must
  // not be able to take the recovery screen down with it.
  const t = useMemo(
    () => (Appearance.getColorScheme() === "light" ? light : dark),
    [],
  );
  const report = useMemo(
    () => buildRootErrorReport(error, process.env.EXPO_PUBLIC_POSTWAVE_RELEASE),
    [error],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      {/* Scrolls rather than centres-and-clips: at a 2x OS text size the four
          stacked labels below are taller than a phone screen, and a recovery
          screen the user cannot reach the button on is not a recovery. */}
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 14,
        }}
      >
        <Text
          {...typeCap("title")}
          accessibilityRole="header"
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontWeight: "700",
            textAlign: "center",
          }}
        >
          Something went wrong
        </Text>
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fgMuted,
            ...typeStyle("callout"),
            textAlign: "center",
          }}
        >
          The app hit an unexpected error. Your data is safe — tap below to try
          again.
        </Text>

        <Pressable
          onPress={() => void retry()}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 12,
            paddingHorizontal: 28,
            borderRadius: 12,
            backgroundColor: t.accent,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              fontWeight: "700",
              ...typeStyle("body"),
              textAlign: "center",
            }}
          >
            Try again
          </Text>
        </Pressable>

        <Pressable
          onPress={() => {
            void Share.share({ message: rootErrorShareText(report) }).catch(
              () => undefined,
            );
          }}
          accessibilityRole="button"
          accessibilityLabel="Share error details with support"
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 10,
            paddingHorizontal: 20,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              fontWeight: "600",
              ...typeStyle("callout"),
              textAlign: "center",
            }}
          >
            Share details
          </Text>
        </Pressable>

        {/* Spoken in full so a VoiceOver user can read the reference to
            support without having to see the screen. */}
        <Text
          {...typeCap("caption")}
          selectable
          accessibilityLabel={`Support reference: ${report.reference}`}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            textAlign: "center",
          }}
        >
          {report.reference}
        </Text>

        {__DEV__ && error ? (
          // Rendered inline rather than in a nested ScrollView: the outer one
          // already scrolls, and a same-axis nested scroller steals the drag.
          <Text
            {...typeCap("caption")}
            style={{
              color: t.danger,
              ...typeStyle("caption"),
              marginTop: 8,
              alignSelf: "stretch",
            }}
            selectable
          >
            {error.message}
            {"\n\n"}
            {error.stack}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
