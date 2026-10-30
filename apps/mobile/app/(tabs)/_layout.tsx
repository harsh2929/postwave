/**
 * (tabs) group — bottom-tab nav for the authenticated app.
 *
 * Five primary destinations on the bottom rail:
 *   Dashboard · Subscribers · Campaigns · Approvals · More
 *
 * "More" opens an in-app menu screen (more.tsx) with secondary
 * destinations: Voice, Integrations, Settings, Audit log, Sign out.
 * This is the standard mobile pattern (Slack/Linear/Notion) — keeps
 * the bottom bar legible (no truncated labels) while every screen is
 * still one or two taps away.
 *
 * Anyone hitting (tabs) without auth gets bounced to /sign-in. The
 * Redirect MUST come before the Tabs render so the tab bar doesn't
 * flash for a frame.
 *
 * Tab + header colours are derived from the active theme so the
 * chrome flips correctly between light / dark.
 *
 * THE NAVIGATOR IS NEVER CONDITIONALLY REPLACED. Two rules follow from that,
 * and both were bugs before:
 *
 *  1. A role denial renders as an OVERLAY over the content area, above a tab
 *     bar that stays mounted and usable (see SecondaryRouteGuard). It used to
 *     be returned INSTEAD of <Tabs>, so one forbidden deep link unmounted the
 *     whole navigator: the rail vanished, every tab's scroll position and
 *     query state was destroyed, and the only way out was a single button.
 *  2. Nothing in this component subscribes to the current route. `usePathname`
 *     lives in SecondaryRouteGuard, a leaf, so a navigation re-renders that
 *     leaf and not the ~56-child <Tabs> element tree. Every options object and
 *     every `tabBarIcon` renderer that does not depend on state is a module
 *     constant for the same reason — a recreated icon closure defeats the
 *     memoisation React Navigation does on its side.
 */
import { Redirect, Tabs } from "expo-router";
import { EVENTS } from "@postwave/telemetry";
import { useWindowDimensions, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SecondaryRouteGuard } from "@/components/SecondaryRouteGuard";
import { TabBarIcon, type IconName } from "@/components/TabBarIcon";
import { usePendingApprovalsCount } from "@/hooks/useApprovals";
import {
  badgeAccessibilityLabel,
  badgeLabel,
  useUnreadNotificationCount,
} from "@/hooks/useNotificationFeed";
import { useAppBadgeSync } from "@/hooks/useAppBadgeSync";
import { FONT } from "@/lib/fonts";
import { HIDDEN_TAB_SCREENS } from "@/lib/hiddenTabScreens";
import { haptics } from "@/lib/haptics";
import { track as trackTelemetry } from "@/lib/telemetry";
import { hidden, SHELL } from "@/lib/hiddenTabOptions";
import { useTheme } from "@/lib/theme";
import { tabBarScreenOptions } from "@/lib/tabBarChrome";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { tabBarHeightFor } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";
import { labelFor, shortLabelFor } from "@postwave/nav";

// 1-in-N session-stable sampling for mobile.tab_viewed. The bottom-tab nav
// fires often; sending every press is noisy. We pick a deterministic
// sample bucket once per app launch so the same session either always
// reports tab views or never does — keeps funnel analyses clean.
const TAB_VIEW_SAMPLE_RATE = 4; // 1-in-4
const SHOULD_SAMPLE_TAB_VIEWS =
  Math.floor(Math.random() * TAB_VIEW_SAMPLE_RATE) === 0;

function trackTabView(tab: string): void {
  if (!SHOULD_SAMPLE_TAB_VIEWS) return;
  trackTelemetry(EVENTS.MOBILE_TAB_VIEWED, { tab });
}

/** Stable per-tab `listeners`, so a re-render does not hand React Navigation a
 *  fresh object for every tab on the rail. */
/**
 * A tab press is the app's most-repeated interaction and was the only one with
 * no physical feedback — every other control in the app thumps. `haptics.tap()`
 * is the lightest pattern available, which is the right weight for navigation:
 * it confirms the rail registered the press even when the destination takes a
 * beat to paint, without becoming noise across hundreds of presses a day.
 */
function onTabPress(): void {
  haptics.tap();
}

/**
 * `focus` — not `tabPress` — is what a screen VIEW actually is.
 *
 * `tabPress` fires only when a finger lands on the rail, so a cold start into
 * Dashboard, a notification deep link into Campaigns or Approvals, and every
 * programmatic `router.replace` into a primary tab all recorded NOTHING: the
 * five most-visited destinations in the app were blind on their most common
 * entry path, which is the same blindness `useScreenViewed` was written to fix
 * for secondary screens. `focus` fires for all of those, once per navigation.
 *
 * It deliberately does NOT fire when the already-focused tab is pressed again
 * — that gesture scrolls to top, it is not a new view — so moving the call
 * here also removes a small over-count that `tabPress` had.
 *
 * The haptic stays on `tabPress`, because that one IS about the finger: it
 * must confirm the press even when the press changes nothing.
 */
function onTabFocus(tab: string): () => void {
  return () => {
    trackTabView(tab);
  };
}

const TAB_LISTENERS = {
  dashboard: { tabPress: onTabPress, focus: onTabFocus("dashboard") },
  subscribers: { tabPress: onTabPress, focus: onTabFocus("subscribers") },
  campaigns: { tabPress: onTabPress, focus: onTabFocus("campaigns") },
  approvals: { tabPress: onTabPress, focus: onTabFocus("approvals") },
  more: { tabPress: onTabPress, focus: onTabFocus("more") },
} as const;

/**
 * A module-level `tabBarIcon` renderer.
 *
 * Written inline as `tabBarIcon: ({ color }) => <TabBarIcon …/>` this is a new
 * function on every render of the layout, which is exactly the identity React
 * Navigation compares. Built once, per icon, it is not.
 *
 * It lives here rather than in lib/tabBarChrome.ts because it renders JSX, and
 * tabBarChrome is imported by a node-environment vitest suite that cannot
 * transform a react-native import.
 */
function tabIcon(name: IconName) {
  function TabIcon({ color }: { color: string }) {
    return <TabBarIcon name={name} color={color} />;
  }
  return TabIcon;
}

const ICONS = {
  dashboard: tabIcon("home"),
  subscribers: tabIcon("users"),
  campaigns: tabIcon("send"),
  approvals: tabIcon("check"),
  more: tabIcon("more"),
};

/**
 * The options block for a primary tab that carries no badge and is never
 * conditionally hidden. Evaluated once at module scope — none of its inputs
 * are state.
 *
 * `title`/`shortLabel` are FALLBACKS: the shared @postwave/nav manifest is the
 * source of truth and nav.consistency.test.ts asserts the two agree. They exist
 * only so a manifest gap degrades to a readable label instead of an empty tab.
 *
 * Approvals and More deliberately do NOT use this — their options carry a live
 * badge and, for Approvals, a conditional `href: null`, and hiding the thing
 * that decides whether a tab appears on the rail at all inside a helper would
 * be the wrong trade.
 */
function primaryTab(
  key: string,
  title: string,
  shortLabel: string,
  tabBarIcon: (props: { color: string }) => React.ReactElement,
) {
  return {
    title: labelFor(key) ?? title,
    tabBarLabel: shortLabelFor(key) ?? shortLabel,
    tabBarIcon,
  };
}

const PRIMARY = {
  dashboard: primaryTab("dashboard", "Dashboard", "Home", ICONS.dashboard),
  subscribers: primaryTab(
    "subscribers",
    "Subscribers",
    "People",
    ICONS.subscribers,
  ),
  campaigns: primaryTab("campaigns", "Campaigns", "Send", ICONS.campaigns),
};

const FILL: ViewStyle = { flex: 1 };

/**
 * The tab group's parent route for a COLD deep link (LOVE#48).
 *
 * Expo Router only honours `unstable_settings` from a layout module, so this
 * is the one file it can live in. Opening a notification straight into a
 * hidden detail route previously left the navigator with no parent to fall
 * back to, and `goBackOr()` had to REPLACE with a fallback route rather than
 * pop — which is why Back from a pushed detail could land somewhere the user
 * had never been.
 *
 * Partial on its own, and worth being honest about: this synthesises a parent,
 * but the scroll/filter restoration the finding ultimately wants also needs
 * the entity-detail Stack conversion (LOVE-V#1), which is deliberately
 * deferred — it would change back-behaviour app-wide.
 */
export const unstable_settings = { initialRouteName: "dashboard" };

export default function TabsLayout() {
  const isAuthed = useAuthStore((s) => s.canEnterApp());
  const mfaGate = useAuthStore((s) => s.mfaGate());
  const mode = useAuthStore((s) => s.mode);
  const effectiveRole = useAuthStore(
    (s) => s.session?.effectiveRole ?? s.session?.role ?? null,
  );
  const { t } = useTheme();
  // Derive the bottom inset from the safe area rather than hardcoding it,
  // so the tab bar sits flush with no dead space on devices without a home
  // indicator (iPhone SE, Android button-nav, iPad) and clears the home
  // indicator on notched devices / landscape.
  const insets = useSafeAreaInsets();
  // OS text-size setting; the tab bar must grow with the label it contains.
  const { fontScale } = useWindowDimensions();
  // Pending-approvals badge. Hook MUST run before the auth early-return
  // (rules of hooks); it self-disables while logged out, so it never
  // fires a request pre-auth. Shares the query cache with the
  // Approvals screen — no extra network traffic.
  //
  // Gated on the admin role because GET /api/v1/approvals calls
  // requireAdmin (apps/api/internal/approvals/handlers.go:226 → :597 admits
  // only owner|admin), so an editor or viewer would otherwise fire a
  // guaranteed 403 every 60 seconds for the whole session. NOTE: the
  // generated route-authz manifest lists this route as viewer-level, but
  // that entry is a `fail_closed_default` safe-default, not a reading of the
  // handler — hence a plain role check here rather than a MOBILE_CAPABILITIES
  // entry (nav.consistency asserts capabilities match the manifest).
  // canAccessMinimumRole is pure, so it is safe above the early returns.
  const canApprove = canAccessMinimumRole("admin", effectiveRole, mode);
  const pendingApprovals = usePendingApprovalsCount(canApprove);
  // Unread notifications. Same rules-of-hooks constraint, and the hook shares
  // the inbox's exact query key, so the badge costs no extra request. The
  // inbox lives behind More, so More is where the count has to surface —
  // otherwise the number is on the wire and nowhere on the screen.
  const unreadNotifications = useUnreadNotificationCount();
  // Push arrival already raises the springboard badge; this lowers it on read.
  useAppBadgeSync();
  if (mfaGate === "enrollment") {
    return <Redirect href="/(auth)/mfa-enroll" />;
  }
  if (mfaGate === "challenge") {
    return <Redirect href="/(auth)/totp" />;
  }
  if (!isAuthed) {
    return <Redirect href="/(auth)/sign-in" />;
  }
  return (
    <View style={FILL}>
      <Tabs
        screenOptions={tabBarScreenOptions({
          t,
          bottomInset: insets.bottom,
          fontScale,
        })}
      >
        {/* ——— PRIMARY TABS ——— */}
        <Tabs.Screen
          name="dashboard"
          options={PRIMARY.dashboard}
          listeners={TAB_LISTENERS.dashboard}
        />
        <Tabs.Screen
          name="subscribers"
          options={PRIMARY.subscribers}
          listeners={TAB_LISTENERS.subscribers}
        />
        <Tabs.Screen
          name="campaigns"
          options={PRIMARY.campaigns}
          listeners={TAB_LISTENERS.campaigns}
        />
        <Tabs.Screen
          name="approvals"
          options={{
            title: labelFor("approvals") ?? "Approvals",
            tabBarLabel: shortLabelFor("approvals") ?? "Approve",
            tabBarIcon: ICONS.approvals,
            // A non-admin's Approvals tab can only ever render a permission
            // notice, so it is not offered on the rail. The route itself stays
            // registered — an approval push deep-links straight to
            // approvals/[id], which states the boundary in its own words.
            // Spread-conditional for exactOptionalPropertyTypes.
            ...(canApprove ? {} : { href: null }),
            // The badge itself is decoration to VoiceOver — a red dot with a
            // number it does not read. The label is what carries the count.
            tabBarAccessibilityLabel: badgeAccessibilityLabel(
              shortLabelFor("approvals") ?? "Approvals",
              pendingApprovals,
            ),
            // Badge = pending count; capped so a backlog doesn't blow out
            // the tab bar. Omitted entirely at zero (exactOptionalPropertyTypes
            // forbids an explicit undefined) so no badge renders.
            ...(pendingApprovals > 0
              ? {
                  tabBarBadge: pendingApprovals > 99 ? "99+" : pendingApprovals,
                  tabBarBadgeStyle: {
                    backgroundColor: t.danger,
                    color: t.accentFg,
                    fontSize: 11,
                    fontFamily: FONT.semibold,
                  },
                }
              : {}),
          }}
          listeners={TAB_LISTENERS.approvals}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: "More",
            tabBarLabel: "More",
            tabBarIcon: ICONS.more,
            // A tab badge is a coloured dot to assistive tech unless the label
            // says what it counts.
            tabBarAccessibilityLabel: badgeAccessibilityLabel(
              "More",
              unreadNotifications,
            ),
            ...(unreadNotifications > 0
              ? {
                  tabBarBadge: badgeLabel(unreadNotifications),
                  tabBarBadgeStyle: {
                    backgroundColor: t.accent,
                    color: t.accentFg,
                    fontSize: 11,
                    fontFamily: FONT.semibold,
                  },
                }
              : {}),
          }}
          listeners={TAB_LISTENERS.more}
        />

        {/* Dedicated role-denial destination. The guard REPLACES a forbidden
            screen with this hidden route so the forbidden scene unmounts while
            the primary rail remains available. */}
        <Tabs.Screen
          name="access-denied"
          options={hidden("Restricted screen")}
        />

        {/* ——— SECONDARY ROUTES (hidden from the tab bar; reached via More
            and deep links). The list is data in lib/hiddenTabScreens.ts —
            see that file for the folder-index trap it encodes. ——— */}
        {HIDDEN_TAB_SCREENS.map(([name, title]) => (
          <Tabs.Screen key={name} name={name} options={hidden(title)} />
        ))}

        {/* Detail screens of the folder-index families. These take SHELL, not
            hidden(...), so they stay here where the difference is visible. */}
        <Tabs.Screen name="helpdesk/[id]" options={SHELL} />
        <Tabs.Screen name="sequences/[id]" options={SHELL} />
        <Tabs.Screen name="forms/[id]" options={SHELL} />
        <Tabs.Screen name="sms/[phone]" options={SHELL} />

        {/* ——— NESTED PUSH STACKS ———
            campaigns · subscribers · approvals · lists · segments ·
            suppressions are DIRECTORY navigators (app/(tabs)/<family>/
            _layout.tsx) and their index/[id] screens are registered by THAT
            layout, not this one. Naming them here is what produces Expo
            Router's "[Layout children]: No route named …" warning. ——— */}
      </Tabs>
      <SecondaryRouteGuard
        role={effectiveRole}
        mode={mode}
        tabBarHeight={tabBarHeightFor(fontScale) + insets.bottom}
      />
    </View>
  );
}
