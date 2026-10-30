/**
 * UpgradeRequiredScreen — the blocking screen for HTTP 426 (NATIVE#3).
 *
 * Mounted by the root layout ABOVE the navigation stack: once the gateway has
 * told this build it is below the supported floor, every subsequent request
 * will fail the same way, so continuing to render tabs full of raw SDK error
 * strings is worse than saying plainly what happened.
 *
 * Provider-independent by design apart from the theme: it can render before
 * the tab tree exists. Deliberately offers no "continue anyway" — the server
 * has already refused, so a dismiss button would only produce broken screens.
 *
 * TYPE. This screen is the LAST thing a blocked user sees, so it is the worst
 * possible place for text to clip: every node is on the shared Dynamic Type
 * scale (lib/typeScale) and the whole card sits in a ScrollView with
 * `flexGrow`, so at a 2x accessibility size the copy reflows and the page
 * scrolls rather than the sentence being cut in half.
 */
import { useSyncExternalStore } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  getUpgradeRequirement,
  storeUrlsForPlatform,
  subscribeUpgradeRequirement,
  type UpgradeRequirement,
} from "@/lib/upgradeRequired";

export function useUpgradeRequirement(): UpgradeRequirement | null {
  return useSyncExternalStore(
    subscribeUpgradeRequirement,
    getUpgradeRequirement,
    getUpgradeRequirement,
  );
}

async function openStore(): Promise<void> {
  const urls = storeUrlsForPlatform(Platform.OS, {
    ...(process.env.EXPO_PUBLIC_IOS_APP_STORE_ID
      ? { iosAppStoreId: process.env.EXPO_PUBLIC_IOS_APP_STORE_ID }
      : {}),
    androidPackage: "com.moosewave.app",
  });
  for (const url of urls) {
    try {
      // Try the store-app scheme first, then the https form the OS always
      // resolves, so the button can never dead-end.
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return;
      }
    } catch {
      /* try the next candidate */
    }
  }
  const fallback = urls.at(-1);
  if (fallback) {
    await Linking.openURL(fallback).catch(() => undefined);
  }
}

export function UpgradeRequiredScreen({
  requirement,
}: {
  requirement: UpgradeRequirement;
}) {
  const { t } = useTheme();
  const detail =
    requirement.detail ??
    "This version of Moosewave is no longer supported. Update to keep using your workspace.";
  const versions = [
    requirement.currentVersion ? `You have ${requirement.currentVersion}` : null,
    requirement.minVersion ? `Minimum ${requirement.minVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      accessibilityViewIsModal
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
          gap: 16,
        }}
      >
        <View accessibilityRole="header">
          <Text
            {...typeCap("display")}
            style={{
              color: t.fg,
              ...typeStyle("display"),
              fontWeight: "800",
              fontFamily: FONT.bold,
            }}
          >
            Update Moosewave
          </Text>
        </View>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {detail}
        </Text>
        {versions ? (
          <Text
            {...typeCap("bodySmall")}
            accessibilityLabel={`App version: ${versions.replace(/·/g, ",")}`}
            style={{
              color: t.fgSubtle,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {versions}
          </Text>
        ) : null}
        <Pressable
          onPress={() => {
            void openStore();
          }}
          accessibilityRole="button"
          accessibilityLabel="Open the app store to update Moosewave"
          style={{
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            paddingHorizontal: 20,
            backgroundColor: t.accent,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              ...typeStyle("body"),
              fontWeight: "700",
              fontFamily: FONT.bold,
              textAlign: "center",
            }}
          >
            {Platform.OS === "android" ? "Open Play Store" : "Open App Store"}
          </Text>
        </Pressable>
        {requirement.requestId ? (
          <Text
            {...typeCap("caption")}
            selectable
            accessibilityLabel={`Support reference ${requirement.requestId}`}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              textAlign: "center",
            }}
          >
            Reference {requirement.requestId}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Renders the blocking screen when — and only when — a 426 has been observed.
 * Safe to mount unconditionally; it is null the rest of the time.
 */
export function UpgradeRequiredGate() {
  const requirement = useUpgradeRequirement();
  if (!requirement) return null;
  return <UpgradeRequiredScreen requirement={requirement} />;
}
