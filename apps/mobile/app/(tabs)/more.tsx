/**
 * More — secondary navigation menu.
 *
 * Five primary destinations live on the bottom tab bar; the rest live here in a
 * sectioned list. This pass closed several shell gaps:
 *
 *  - Sign-out now runs through the SHARED flow (src/lib/signOutFlow.ts). This
 *    screen and Settings had two divergent implementations of the most
 *    consequential action in the app, with different copy and only one guard.
 *  - The Notifications row carries the unread count. `unread_count` was in the
 *    payload and rendered nowhere — no bell, no badge, anywhere.
 *  - Pull-to-refresh. The workspace card shows a live connection badge whose
 *    state only changed on app foreground or a NetInfo flap, so a user staring
 *    at "Offline" had no way to ask the app to re-check. Settings already had
 *    a RefreshControl, which made the omission inconsistent rather than
 *    deliberate.
 *  - The six section lists are computed once per role change instead of six
 *    full scans of the route manifest on every render.
 *  - The tenant id and API origin are long-pressable to share — matching the
 *    idiom eight product screens already use — instead of being unselectable
 *    monospace text a user has to read out loud to support.
 *
 * Implementation note: rows use plain View + Pressable with STATIC styles.
 * NativeWind v4's JSX runtime intercepts the `({pressed}) => …` form in a way
 * that silently drops layout.
 */
import * as Application from "expo-application";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useConfirm } from "@/components/ConfirmSheet";
import { MoreDesktopOnly } from "@/components/more/MoreDesktopOnly";
import { FilteredDestinations, MoreSection } from "@/components/more/MoreRows";
import { MoreWorkspaceSection } from "@/components/more/MoreWorkspaceSection";
import { WhatsNewCard } from "@/components/more/WhatsNewCard";
import { iconTile } from "@/components/more/moreStyles";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { TabBarIcon } from "@/components/TabBarIcon";
import { useToast } from "@/components/Toast";
import { useTour } from "@/components/tour/TourProvider";
import { useUnreadNotificationCount } from "@/hooks/useNotificationFeed";
import { useMoreDestinations } from "@/hooks/useMoreDestinations";
import { ScrollToTop } from "@/components/ScrollToTop";
import { useRestoreScroll } from "@/hooks/useRestoreScroll";
import { connectionStatus } from "@/lib/connectionStatus";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { SCREEN_SCROLL_PADDING_BOTTOM } from "@/lib/shellStyleTokens";
import { retryPendingPushRevocation, unregisterPushThenSignOut } from "@/lib/push";
import { MOBILE_MORE_SECTION_ORDER } from "@/lib/mobileRouteManifest";
import { confirmAndSignOut } from "@/lib/signOutFlow";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/**
 * Per-route boundary: More reads the route manifest and the session, so a
 * surprise in either degrades THIS screen rather than replacing the whole
 * navigator (which would take the tab bar — and every escape route — with it).
 */
export { AppErrorBoundary as ErrorBoundary };

export default function More() {
  const { t } = useTheme();
  const { start: startTour } = useTour();
  const confirm = useConfirm();
  const { toast } = useToast();
  const signOut = useAuthStore((s) => s.signOut);
  const revalidateSession = useAuthStore((s) => s.revalidateSession);
  const tenantId = useAuthStore((s) => s.tenantId);
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const mode = useAuthStore((s) => s.mode);
  const sessionValidation = useAuthStore((s) => s.sessionValidation);
  const session = useAuthStore((s) => s.session);
  const effectiveRole = session?.effectiveRole || session?.role || null;
  const [signingOut, setSigningOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Filter across ALL sections. Local and instant — the catalogue is ~30 rows
  // already in memory — so no debounce and no query.
  const [query, setQuery] = useState("");
  const unread = useUnreadNotificationCount();
  // Six sections deep: coming back from a destination used to drop the user
  // at the top of the list they had just scrolled through.
  const scroll = useRestoreScroll("more");

  // Prefer a human-friendly workspace name (session mode) over the raw
  // tenant UUID; fall back to the tenant id, then an em-dash.
  const workspaceLabel = session?.workspaceName || tenantId || "—";
  const tenantSubLabel = session?.workspaceName && tenantId ? tenantId : null;
  // A session that is only offline-cached (launched offline, or online
  // revalidation failed) is not a live connection — reflect that instead of
  // a green "Session" badge that reads as connected/healthy.
  //
  // The derivation itself now lives in src/lib/connectionStatus.ts so this card
  // and the shell's header indicator cannot drift into two answers, and so the
  // rule is unit-testable without a renderer. It also distinguishes "still
  // checking" from "cached", which the inline ternaries here flattened into one
  // pessimistic "Offline".
  const connection = connectionStatus({ mode, sessionValidation });
  const connectionColor =
    connection.tone === "success"
      ? t.success
      : connection.tone === "warning"
        ? t.warning
        : connection.tone === "info"
          ? t.info
          : t.fgSubtle;

  const onSignOut = useCallback(() => {
    void confirmAndSignOut({
      mode,
      confirm,
      performSignOut: () => unregisterPushThenSignOut(signOut),
      onBusyChange: setSigningOut,
      navigateToSignIn: () => router.replace("/(auth)/sign-in"),
    }).then((outcome) => {
      // Local credentials are gone either way, but a failed revocation means
      // the server may still push to this device. Claiming a clean sign-out
      // would be the wrong answer to "did I actually log out?".
      if (outcome === "signed-out-degraded") {
        toast({
          kind: "warning",
          message:
            "Signed out on this device, but the server couldn't be reached to revoke it. It will retry.",
        });
      }
    });
  }, [confirm, mode, signOut, toast]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([
        revalidateSession(),
        retryPendingPushRevocation(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [revalidateSession]);

  const shareValue = useCallback(
    (label: string, value: string) => {
      haptics.tap();
      void Share.share({ message: value }).catch(() =>
        toast({ kind: "error", message: `Couldn't share the ${label}.` }),
      );
    },
    [toast],
  );

  // Row model — access filtering, pin/recent decoration and query ranking.
  // Extracted to a hook so this component keeps rendering and its two side
  // effects (sign-out, refresh) and nothing else; the three-stage memo
  // structure that keeps typing off the manifest scan lives there.
  const onPinChanged = useCallback(
    (label: string, pinned: boolean) => {
      toast({
        kind: "info",
        message: pinned
          ? `${label} pinned to the top of More.`
          : `${label} unpinned.`,
      });
    },
    [toast],
  );
  const {
    sections,
    favoriteRows,
    recentRows,
    matches,
    trimmedQuery,
    recordVisit,
  } = useMoreDestinations({
    effectiveRole,
    mode,
    unread,
    query,
    startTour,
    onPinChanged,
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="More" onSearch />
      {/* Pinned under the header, not inside the scroll: the whole point is to
          reach a destination without scrolling, so a filter that scrolls away
          would be the second thing you had to find. Local and instant — the
          catalogue is already in memory — so no debounce and no spinner. */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Filter destinations"
          accessibilityLabel="Filter the More menu"
          resultCount={trimmedQuery ? matches.length : undefined}
          resultNoun="match"
          resultNounPlural="matches"
        />
      </View>
      {/* Re-tapping the active More tab returns to the top — the iOS
          convention this shell never honoured. <ScrollToTop> subscribes to the
          tab navigator's own tabPress, so it needs no change to the tab
          layout, and it renders null outside a navigator so an isolated mount
          of this screen in a route test still renders. */}
      <ScrollToTop targetRef={scroll.ref} />
      <ScrollView
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        scrollEventThrottle={scroll.scrollEventThrottle}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: 4,
          paddingBottom: SCREEN_SCROLL_PADDING_BOTTOM,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {trimmedQuery ? (
          <FilteredDestinations
            rows={matches}
            query={trimmedQuery}
            t={t}
            onVisit={recordVisit}
          />
        ) : (
          <>
            {/* The identity card reads session state that a mid-flight schema
                change can surprise. It must not be able to take the DESTINATION
                LIST with it: More is the only way to reach 24 of the app's 29
                screens, so a blank More screen is a stranded user. */}
            {/* Identity card + workspace switcher + server connections, in one
                boundary because they read the same session state. */}
            <MoreWorkspaceSection
              t={t}
              onRetry={() => void revalidateSession()}
              workspaceLabel={workspaceLabel}
              tenantSubLabel={tenantSubLabel}
              connectionLabel={connection.label}
              connectionSpoken={connection.spoken}
              connectionColor={connectionColor}
              baseUrl={baseUrl}
              email={mode === "session" ? (session?.email ?? null) : null}
              role={mode === "session" ? (session?.role ?? null) : null}
              onShare={shareValue}
            />

            {/* One dismissible product announcement, from the same registry
                that badges the rows below. Renders nothing once everything
                live has been read or has aged out of its 30-day window. */}
            <WhatsNewCard
              effectiveRole={effectiveRole}
              mode={mode}
              onOpen={recordVisit}
            />

            {/* Both render null when empty, so a user who has never pinned
                anything sees exactly the list they saw before. */}
            <MoreSection
              title="Favourites"
              rows={favoriteRows}
              t={t}
              onVisit={recordVisit}
            />
            <MoreSection
              title="Recent"
              rows={recentRows}
              t={t}
              onVisit={recordVisit}
            />

            {MOBILE_MORE_SECTION_ORDER.map((section) => (
              <MoreSection
                key={section}
                title={section}
                rows={sections.get(section) ?? []}
                t={t}
                onVisit={recordVisit}
              />
            ))}

            {/* The six headings above are a CLAIM about coverage, and this is
                where the claim stops (MAP#73). Without it, a user who scans
                Content and finds no Referrals concludes Moosewave has none,
                rather than that it has one on desktop. Rendered only when the
                list is unfiltered: while a filter is active the screen is
                answering "where is X", and an always-unfiltered block under
                every search is noise. */}
            <MoreDesktopOnly />
          </>
        )}

        {/* Sign out — destructive standalone action. */}
        <View style={{ marginHorizontal: 12, marginTop: 8 }}>
          <Pressable
            onPress={onSignOut}
            disabled={signingOut}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            accessibilityState={{ disabled: signingOut }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.borderSubtle,
              opacity: signingOut ? 0.5 : 1,
            }}
          >
            <View style={iconTile(t)}>
              <TabBarIcon name="signout" color={t.danger} size={20} />
            </View>
            <Text
              // Same role as every other destination row in this list.
              {...typeCap("body")}
              style={{
                color: t.danger,
                ...typeStyle("body"),
                fontWeight: "500",
                fontFamily: FONT.medium,
              }}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Text>
          </Pressable>
        </View>

        {/* App version footer — parity with the Settings screen footer. */}
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            textAlign: "center",
            marginTop: 20,
            fontFamily: FONT.regular,
          }}
        >
          Moosewave Mobile · v{Application.nativeApplicationVersion ?? "0.1.0"} (
          {Application.nativeBuildVersion ?? "1"})
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
