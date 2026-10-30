/**
 * components/SecondaryRouteGuard.tsx — the (tabs) shell's role denial, as an
 * OVERLAY over the tab navigator's content area rather than a replacement for
 * the navigator.
 *
 * WHAT WAS WRONG. `app/(tabs)/_layout.tsx` used to answer a failed role check
 * by returning the notice INSTEAD of <Tabs>. One forbidden deep link therefore
 * unmounted the entire navigator: the bottom rail vanished, every tab's scroll
 * position and query state was destroyed, and the only way out was a single
 * button. An Android `hardwareBackPress` handler had to be bolted on because,
 * with no navigator mounted, back had nothing left to pop.
 *
 * WHAT IT DOES NOW. The navigator always renders. This component sits beside it
 * inside a filling parent and covers the content area, stopping exactly at the
 * top of the tab bar — so the rail stays visible and tappable, tab state
 * survives, and Android back is once again React Navigation's own. That last
 * point is what makes it safe to opt the Android activity into predictive back
 * (`android.predictiveBackGestureEnabled`), which the removed BackHandler
 * would have fought.
 *
 * DENIALS BECOME A ROUTE. The opaque overlay now exists only for the transition
 * frame, then `router.replace` moves onto the hidden `access-denied` route.
 * That unmounts the restricted scene so it cannot keep fetching or remain in
 * VoiceOver's traversal, while the tab navigator and its rail stay mounted.
 */
import { router, usePathname } from "expo-router";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { MobileSecondaryRoute } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { deniedSecondaryRoute } from "@/lib/tabShellPolicy";
import { typeCap, typeStyle } from "@/lib/typeScale";
import type { AuthMode } from "@/store/auth";

/**
 * The only consumer of the current route in the tab shell, and deliberately a
 * leaf.
 *
 * `usePathname` re-renders whoever calls it on every navigation — including
 * pushes inside nested stacks like campaigns/[id]. Called in TabsLayout (where
 * it used to live) that meant rebuilding the entire <Tabs> element tree, every
 * `Tabs.Screen` and every icon closure, on every single navigation. Called
 * here it re-renders one component that returns `null` on the overwhelmingly
 * common path.
 *
 * `tabBarHeight` is passed in rather than read from `useBottomTabBarHeight`:
 * this component is a SIBLING of the navigator, not inside a tab screen, so
 * that hook has no context to read. It is the same number the navigator is
 * given in `tabBarScreenOptions`, from the same `tabBarHeightFor`.
 */
export function SecondaryRouteGuard({
  role,
  mode,
  tabBarHeight,
}: {
  role: string | null;
  mode: AuthMode | null;
  tabBarHeight: number;
}) {
  const pathname = usePathname();
  const denied = deniedSecondaryRoute(pathname, role, mode);

  // Move the denial onto its own hidden tab route. Keeping this opaque notice
  // for the single transition frame prevents restricted content flashing, but
  // the replace is the important part: the covered screen is then unmounted,
  // so it cannot keep fetching and assistive technology cannot swipe into it.
  // `replace`, rather than `push`, also keeps Back from returning to the same
  // route and immediately denying it again.
  useEffect(() => {
    if (!denied) return;
    router.replace({
      pathname: "/(tabs)/access-denied",
      params: { routeKey: denied.key },
    } as never);
  }, [denied]);

  if (!denied) return null;
  return (
    <MobileRouteAccessDenied
      label={denied.label}
      tabBarHeight={tabBarHeight}
      transitioning
    />
  );
}

/** The notice itself. Exported for the route test, which renders it directly. */
export function MobileRouteAccessDenied({
  label,
  tabBarHeight,
  transitioning = false,
}: {
  label: MobileSecondaryRoute["label"];
  tabBarHeight: number;
  transitioning?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      {...(transitioning ? { accessibilityViewIsModal: true } : {})}
      testID="secondary-route-denied"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: tabBarHeight,
        backgroundColor: t.bg,
        alignItems: "center",
        justifyContent: "center",
        padding: 28,
      }}
    >
      <Text
        {...typeCap("title")}
        style={{
          ...typeStyle("title"),
          color: t.fg,
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        {label} is restricted
      </Text>
      <Text
        {...typeCap("body")}
        style={{
          ...typeStyle("body"),
          color: t.fgMuted,
          fontFamily: FONT.regular,
          textAlign: "center",
          marginTop: 8,
        }}
      >
        This workspace role does not include the capability required for this
        screen. Ask a workspace administrator if you need access, or use the
        tabs below to go somewhere else.
      </Text>
      <Pressable
        onPress={() => router.replace("/(tabs)/more")}
        accessibilityRole="button"
        accessibilityLabel="Return to the More menu"
        style={{
          marginTop: 20,
          minHeight: 44,
          paddingHorizontal: 18,
          borderRadius: 10,
          backgroundColor: t.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            ...typeStyle("control"),
            color: t.accentFg,
            fontFamily: FONT.semibold,
          }}
        >
          Return to More
        </Text>
      </Pressable>
    </View>
  );
}
