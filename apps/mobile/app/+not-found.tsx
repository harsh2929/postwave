/**
 * The screen a link that goes nowhere lands on.
 *
 * WHY THIS FILE EXISTS. Expo Router ships its own "Unmatched Route" page, and
 * without a `+not-found` route that is what a user sees: an unstyled dark
 * screen carrying the raw URL and a developer's "Sitemap" link. Reached
 * in-app on 2026-08-19 by opening a `moosewave://` link with no matching route.
 *
 * That page is fine for a developer and wrong for everyone else. The links
 * that actually miss are the ones outside our control — a campaign email sent
 * before a screen was renamed, a shared link opened on a build that predates
 * it, a typo in a universal link — so the person seeing this has done nothing
 * unusual and needs a way back in, not a sitemap.
 *
 * It names the address it could not open, because a link that silently
 * forgets which link it was is unreportable.
 */
import { Stack, router, usePathname } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export default function NotFoundScreen() {
  const { t } = useTheme();
  const pathname = usePathname();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <Stack.Screen options={{ title: "Not found" }} />
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 32,
          gap: 12,
        }}
      >
        <Text
          {...typeCap("heading")}
          accessibilityRole="header"
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontFamily: FONT.semibold,
            textAlign: "center",
          }}
        >
          That link doesn&apos;t open anything
        </Text>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
            textAlign: "center",
          }}
        >
          It may point at a screen that has been renamed, or it may have been
          typed by hand. Nothing is wrong with your account.
        </Text>
        {pathname ? (
          <Text
            {...typeCap("caption")}
            // Selectable so it can be pasted into a bug report.
            selectable
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              textAlign: "center",
            }}
          >
            {pathname}
          </Text>
        ) : null}
        <Pressable
          onPress={() => {
            haptics.tap();
            router.replace("/(tabs)/dashboard");
          }}
          accessibilityRole="button"
          accessibilityLabel="Go to the dashboard"
          style={{
            marginTop: 8,
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 20,
            borderRadius: 12,
            backgroundColor: t.accent,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            Go to the dashboard
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// Expo Router mounts this as the route's boundary, per the invariant in
// lib/routeErrorBoundary.consistency.test — a screen that itself throws must
// not take the whole app down, least of all the one shown after a bad link.
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";
