/**
 * OfflineBanner — a slim, app-wide bar shown whenever the device loses
 * connectivity, so flaky-cellular users understand why data is stale and
 * why writes are pausing (instead of silent failures). Rendered once in
 * the root layout, above the navigator.
 *
 * WHAT IT SAYS (NATIVE#36 / LOVE#37). The copy used to be one fixed sentence
 * — "No connection — showing cached data. Changes will sync when you're back
 * online." — and both halves could be false at once. The reasoning now lives
 * in lib/offlineBannerCopy.ts, which derives the line from measured state:
 * no promise about cached data (the persistence policy guarantees most screens
 * have none), and the OFFLINE QUEUE DEPTH stated here rather than only on the
 * Diagnostics screen behind More.
 *
 * IT ALSO OFFERS A RE-PROBE. NetInfo's reachability answer can stay wrong for
 * minutes behind a captive portal or after a VPN flap, and the only recovery a
 * user had was toggling airplane mode. `NetInfo.refresh()` forces a fresh
 * measurement, which lib/connectivity's listener turns into a TanStack
 * onlineManager update.
 *
 * MOTION (SHELL#49). This bar appears ABOVE the navigator, so it does not
 * fade in — it shoves the entire app down by its own height, instantly, in one
 * frame. That is the most disorienting motion in the app and it was the one
 * piece of chrome with no transition at all, while `lib/motion.ts` existed
 * specifically to be the shell's motion vocabulary and had only three
 * component consumers.
 *
 * `LayoutAnimation` rather than reanimated, deliberately: the thing that needs
 * to animate is the LAYOUT SHIFT this banner imposes on its siblings, which a
 * self-contained opacity animation cannot address. The duration comes from the
 * shared `enter`/`exit` intents, never a literal, and reduce-motion collapses
 * it to no configuration at all — the OS setting exists precisely for people
 * for whom a screen-wide shove is painful, so honouring it is not optional.
 *
 * `configureNext` is called during RENDER rather than in an effect: it applies
 * to the NEXT layout pass, and by the time an effect runs the pass that moved
 * everything has already happened.
 */
import NetInfo from "@react-native-community/netinfo";
import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutAnimation, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useIsOnline } from "@/hooks/useIsOnline";
import { announce, liveRegionProps } from "@/lib/a11y";
import { haptics } from "@/lib/haptics";
import { durationFor, useMotion } from "@/lib/motion";
import { offlineBannerCopy } from "@/lib/offlineBannerCopy";
import { currentOfflineAuthScope } from "@/lib/offlineMutations";
import { listOfflineMutationQueue } from "@/lib/offlineMutationQueue";
import { queryClient } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface QueueDepth {
  pending: number;
  failed: number;
}

const EMPTY_DEPTH: QueueDepth = { pending: 0, failed: 0 };

/**
 * Depth for the CURRENT identity only. `currentOfflineAuthScope` throws while
 * the identity is incomplete (mid sign-in, mid workspace switch); that is
 * treated as "nothing to report", never as another identity's queue.
 */
function readQueueDepth(): QueueDepth {
  try {
    const items = listOfflineMutationQueue(
      queryClient,
      currentOfflineAuthScope(),
    );
    let pending = 0;
    let failed = 0;
    for (const item of items) {
      if (item.status === "queued" || item.status === "syncing") pending += 1;
      else if (item.status === "failed") failed += 1;
    }
    return { pending, failed };
  } catch {
    return EMPTY_DEPTH;
  }
}

export function OfflineBanner() {
  const online = useIsOnline();
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { reduceMotion } = useMotion();
  const previous = useRef(online);
  const [depth, setDepth] = useState<QueueDepth>(EMPTY_DEPTH);
  const [rechecking, setRechecking] = useState(false);

  // Subscribe only while the bar is actually visible. The mutation cache fires
  // for every mutation in the app and this component is mounted for the whole
  // session, so an unconditional subscription would re-render the shell on
  // every write the user makes online.
  useEffect(() => {
    if (online) {
      setDepth(EMPTY_DEPTH);
      return;
    }
    setDepth(readQueueDepth());
    // `mutationCache.subscribe` notifies SYNCHRONOUSLY from inside whatever
    // component is mutating, so calling setDepth directly set state during that
    // component's render -- React's "Cannot update a component while rendering a
    // different component". This banner is mounted once in app/_layout.tsx, so
    // it was live on every route. Same fault, same fix as
    // OfflineMutationFailureBanner: a microtask moves the update after the
    // offending render commits. Not a debounce -- one notification, one read.
    //
    // The equality bail-out is the other half. QueueDepth is an OBJECT, so a
    // fresh read changed the reference every time and re-rendered the shell on
    // every write even when the numbers were identical.
    let live = true;
    const unsubscribe = queryClient.getMutationCache().subscribe(() => {
      queueMicrotask(() => {
        if (!live) return;
        const next = readQueueDepth();
        setDepth((prev) =>
          prev.pending === next.pending && prev.failed === next.failed
            ? prev
            : next,
        );
      });
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [online]);

  // Android announces the live-region Text below. VoiceOver does not announce
  // a newly mounted alert role reliably, so speak once on the online→offline
  // transition without grouping away the independently focusable Retry button.
  useEffect(() => {
    if (online) return;
    const snapshot = readQueueDepth();
    announce(
      offlineBannerCopy({
        pendingWrites: snapshot.pending,
        failedWrites: snapshot.failed,
        rechecking: false,
      }).accessibilityLabel,
    );
  }, [online]);

  const onRecheck = useCallback(() => {
    haptics.tap();
    setRechecking(true);
    void NetInfo.refresh()
      .catch(() => undefined)
      .finally(() => setRechecking(false));
  }, []);

  if (previous.current !== online) {
    previous.current = online;
    if (!reduceMotion) {
      // Leaving is quicker than arriving: a departing element should not hold
      // attention, and the app snapping back up is the good news.
      const intent = online ? "exit" : "enter";
      LayoutAnimation.configureNext({
        duration: durationFor(intent, false),
        create: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
        update: { type: LayoutAnimation.Types.easeInEaseOut },
        delete: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
      });
    }
  }

  if (online) return null;

  const copy = offlineBannerCopy({
    pendingWrites: depth.pending,
    failedWrites: depth.failed,
    rechecking,
  });

  return (
    <View
      style={{
        backgroundColor: t.warning,
        paddingTop: insets.top + 6,
        paddingBottom: 6,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      {/* Foreground must track the t.warning background across themes: the
          warning token is a DARK amber/brown in light mode (#B45309) but a
          BRIGHT yellow in dark mode (#F1C04C), so a single hardcoded near-black
          (#1c1407) read fine on dark-mode yellow yet failed WCAG AA on the
          light-mode brown (~3.6:1). t.bg is light-paper in light / dark-ink in
          dark — the inverse of t.warning's lightness — so it stays AA+ on both
          (4.89:1 light, 11.30:1 dark) without needing a new shared token. */}
      <View style={{ flex: 1 }}>
        <Text
          {...liveRegionProps()}
          accessibilityLabel={copy.accessibilityLabel}
          {...typeCap("label")}
          style={{ color: t.bg, ...typeStyle("label"), fontWeight: "700" }}
        >
          {copy.title}
        </Text>
        {copy.detail ? (
          <Text
            {...typeCap("label")}
            importantForAccessibility="no"
            style={{ color: t.bg, ...typeStyle("label") }}
          >
            {copy.detail}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onRecheck}
        disabled={rechecking}
        accessibilityRole="button"
        accessibilityLabel="Check the connection again"
        accessibilityState={{ disabled: rechecking, busy: rechecking }}
        hitSlop={8}
        style={{
          minHeight: 44,
          justifyContent: "center",
          paddingHorizontal: 4,
          opacity: rechecking ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.bg,
            ...typeStyle("control"),
            fontWeight: "700",
            textDecorationLine: "underline",
          }}
        >
          {copy.actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}
