/**
 * OfflineMutationFailureBanner — a one-line summary, and a door.
 *
 * "Review" used to open an `Alert.alert` holding a newline-joined string: it
 * could not scroll, it silently `.slice(0, 6)`'d both the queue and the failure
 * list, and it offered no per-item retry or discard (NATIVE#35). The full
 * inspector now lives on the diagnostics screen, which renders every item with
 * its status, expiry, operation id and per-item actions — so this banner does
 * the one job a banner should: say how much is unsent, and get out of the way.
 *
 * MOTION (SHELL#49). Like OfflineBanner, this bar renders ABOVE the navigator,
 * so it does not fade in or out — it shoves the entire app down by its own
 * height in one frame, and shoves it back up when the queue drains. That
 * happens while the user is reading or mid-tap, which is precisely when a
 * one-frame jump costs a mis-tap. It shares OfflineBanner's vocabulary: the
 * duration comes from the `enter`/`exit` intents in lib/motion.ts, never a
 * literal, `configureNext` runs during RENDER because it configures the NEXT
 * layout pass, and Reduce Motion schedules no animation at all.
 */
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { animateNextLayout, useMotion } from "@/lib/motion";

import {
  conflictResolveHref,
  firstConflictOperationId,
} from "@/lib/offlineConflict";
import {
  listOfflineMutationFailures,
  sameFailures,
  subscribeOfflineMutationFailures,
  type OfflineMutationFailure,
} from "@/lib/offlineMutationFailures";
import { currentOfflineAuthScope } from "@/lib/offlineMutations";
import type { OfflineMutationAuthScope } from "@/lib/offlineMutationContract";
import {
  listOfflineMutationQueue,
  sameQueue,
  type OfflineMutationQueueItem,
} from "@/lib/offlineMutationQueue";
import {
  offlineQueueReviewHint,
  offlineQueueReviewLabel,
  offlineQueueReviewSpoken,
  offlineQueueStatusLine,
} from "@/lib/offlineQueueStatusLine";
import { offlineQueueCounts } from "@/lib/offlineQueueView";
import { queryClient } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function OfflineMutationFailureBanner() {
  const { t } = useTheme();
  const baseUrl = useAuthStore((state) => state.baseUrl);
  const tenantId = useAuthStore((state) => state.tenantId);
  const mode = useAuthStore((state) => state.mode);
  const sessionUserId = useAuthStore((state) => state.session?.userId ?? null);
  const sessionRole = useAuthStore(
    (state) => state.session?.effectiveRole ?? null,
  );
  const apiKey = useAuthStore((state) => state.apiKey);
  const [failures, setFailures] = useState<OfflineMutationFailure[]>([]);
  const [queue, setQueue] = useState<OfflineMutationQueueItem[]>([]);
  const refreshEpoch = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const { reduceMotion } = useMotion();
  const wasVisible = useRef(false);

  const refresh = useCallback(() => {
    const epoch = refreshEpoch.current + 1;
    refreshEpoch.current = epoch;
    const hasCompleteIdentity =
      mode === "session"
        ? Boolean(sessionUserId && sessionRole)
        : mode === "api_key"
          ? Boolean(apiKey)
          : false;
    if (!baseUrl || !tenantId || !hasCompleteIdentity) {
      setFailures([]);
      setQueue([]);
      return;
    }
    let scope: OfflineMutationAuthScope;
    try {
      scope = currentOfflineAuthScope();
    } catch {
      setFailures([]);
      setQueue([]);
      return;
    }
    // listOfflineMutationQueue and listOfflineMutationFailures both build a
    // FRESH array every call, so setting them unconditionally changes the
    // reference on every refresh even when nothing moved. That fed the
    // `[queue, refresh]` effect below, which set a timer, which called refresh,
    // which built another new array -- React reported "Maximum update depth
    // exceeded" 84 times in one session walking the tabs. Bail out on equal
    // CONTENT so an unchanged queue is a no-op.
    const nextQueue = listOfflineMutationQueue(queryClient, scope);
    setQueue((prev) => (sameQueue(prev, nextQueue) ? prev : nextQueue));
    void listOfflineMutationFailures(scope)
      .then((rows) => {
        if (!live.current || refreshEpoch.current !== epoch) return;
        setFailures((prev) => (sameFailures(prev, rows) ? prev : rows));
      })
      .catch(() => undefined);
  }, [baseUrl, tenantId, mode, sessionUserId, sessionRole, apiKey]);

  useEffect(() => {
    // The FIRST call is safe synchronously: an effect body never runs during
    // another component's render.
    refresh();
    // The subscriptions are not. `mutationCache.subscribe` notifies
    // SYNCHRONOUSLY from inside whatever component is mutating, so calling
    // refresh directly set state during that component's render -- React
    // reported "Cannot update a component (OfflineMutationFailureBanner) while
    // rendering a different component" 108 times in one session, once per
    // screen visited, because this banner is mounted once in app/_layout.tsx
    // and is therefore live on every route.
    //
    // A microtask moves the setState after the offending render commits. It is
    // not a debounce: every notification still produces exactly one refresh.
    const deferred = () => {
      queueMicrotask(() => {
        if (live.current) refresh();
      });
    };
    const unsubscribeFailures = subscribeOfflineMutationFailures(deferred);
    const unsubscribeQueue = queryClient.getMutationCache().subscribe(deferred);
    return () => {
      unsubscribeFailures();
      unsubscribeQueue();
    };
  }, [refresh]);

  useEffect(() => {
    const sent = queue.filter((item) => item.status === "sent");
    if (sent.length === 0) return;
    const nextExpiry = Math.min(...sent.map((item) => item.queuedAt + 60_000));
    const timer = setTimeout(refresh, Math.max(250, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [queue, refresh]);

  const visible = Boolean(
    baseUrl && tenantId && (failures.length > 0 || queue.length > 0),
  );
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    // Leaving is quicker than arriving: the queue draining is the good news,
    // and a departing bar should not hold attention on the way out.
    animateNextLayout(visible ? "enter" : "exit", reduceMotion);
  }
  if (!visible) return null;

  const failureOperations = new Set(
    failures.map((failure) => failure.operationId),
  );
  const uncapturedFailures = queue.filter(
    (item) =>
      item.status === "failed" && !failureOperations.has(item.operationId),
  );
  // The journal and the mutation cache can hold the SAME failure; counting both
  // reported "2 failed" for one change.
  const counts = offlineQueueCounts(
    queue,
    failures.length + uncapturedFailures.length,
  );
  // The line is assembled in lib/offlineQueueStatusLine, not here: it used to
  // be four `${count} ${status}` concatenations, which froze number-then-word
  // order, printed the only ungrouped number in the app, and assumed English's
  // "one participle for both numbers" (SHELL#67).
  const statusSummary = offlineQueueStatusLine(counts);

  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: counts.failed > 0 ? t.danger : t.warning,
        paddingVertical: 8,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{ color: t.bg, ...typeStyle("label"), fontWeight: "700", flex: 1 }}
      >
        {statusSummary}
      </Text>
      <Pressable
        // A journalled conflict lands on its resolver (P2.56); otherwise the
        // plain inspector.
        onPress={() =>
          router.push(conflictResolveHref(firstConflictOperationId(failures)))
        }
        accessibilityRole="button"
        accessibilityLabel={offlineQueueReviewSpoken(statusSummary)}
        accessibilityHint={offlineQueueReviewHint()}
        hitSlop={8}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("label")}
          style={{ color: t.bg, ...typeStyle("label"), fontWeight: "800" }}
        >
          {offlineQueueReviewLabel()}
        </Text>
      </Pressable>
    </View>
  );
}


