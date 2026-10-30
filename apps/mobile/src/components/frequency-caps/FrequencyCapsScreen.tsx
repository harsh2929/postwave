/**
 * Frequency caps — what is throttling this workspace's sends, and one switch
 * (DELIVERABILITY#54).
 *
 * The question this answers is the one that has no other home: "the campaign
 * went to fewer people than the segment holds — why?" A cap that defers
 * messages is invisible in the campaign report and is a different mechanism
 * from the workspace-wide throttle on Sending settings. See lib/frequencyCaps
 * for endpoint choice and authorisation.
 *
 * TURNING A CAP OFF IS CONFIRMED; TURNING ONE ON IS NOT. The asymmetry is
 * deliberate. Switching a cap ON is conservative — the worst case is that some
 * sends are deferred, and it is reversible by the same switch. Switching one
 * OFF removes a guard that exists to stop the workspace over-mailing people,
 * and the consequence lands on subscribers rather than on the operator, who
 * will not see it. That is the case a confirm is for.
 */
import { useCallback, useMemo, useState } from "react";
import { FlatList, type ListRenderItem, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useToast } from "@/components/Toast";
import { FrequencyCapCard } from "@/components/frequency-caps/FrequencyCapCard";
import {
  useFrequencyCaps,
  useToggleFrequencyCap,
} from "@/hooks/useFrequencyCaps";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import {
  capRuleLine,
  capToggleAnnouncement,
  capsSummaryHeadline,
  type FrequencyCap,
} from "@/lib/frequencyCaps";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function FrequencyCapsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("frequency-caps");

  const caps = useFrequencyCaps();
  const toggle = useToggleFrequencyCap();
  const [pendingId, setPendingId] = useState<string | null>(null);

  // `?? []` is a NULLISH guard: it passes a truthy `{}` / `{items: []}` straight
  // through to `capsSummaryLine`'s `.filter` and to FlatList's `data`. A LIVE
  // response is normalised by the queryFn, but a RESTORED persisted cache is
  // not (lib/secureQueryPersister's schema-buster note), so the guard has to be
  // on the shape, not on nullishness.
  const rows = useMemo(
    () => (Array.isArray(caps.data) ? caps.data : []),
    [caps.data],
  );
  // Only the query knows whether an empty `rows` is "zero caps" or "no answer".
  const capsLoaded = caps.isSuccess && Array.isArray(caps.data);
  const refresh = useManualRefresh([caps.refetch], { enabled: gate.enabled });

  /**
   * PATCH /api/v1/frequency-caps/{id} carries `RequireScope(ScopeAdmin)` at the
   * mount site AND `session_minimum_role: admin` in routeauth's manifest. Both
   * say admin, so the switch is ABSENT — not disabled — for anyone else, and
   * the screen stays a perfectly useful read for them.
   */
  const canToggle = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const onToggle = useCallback(
    (cap: FrequencyCap, next: boolean) => {
      void (async () => {
        if (!next) {
          const ok = await confirm({
            title: `Turn off ${cap.label}?`,
            message: `This cap currently limits sends to ${capRuleLine(cap)}. Turning it off removes that limit for every subscriber it covers until someone turns it back on.`,
            confirmLabel: "Turn off",
            destructive: true,
          });
          if (!ok) return;
        }
        setPendingId(cap.id);
        toggle.mutate(
          { id: cap.id, active: next },
          {
            onSuccess: () => {
              haptics.success();
              toast({
                kind: "success",
                message: capToggleAnnouncement(cap, next),
              });
            },
            onError: (error: unknown) => {
              haptics.error();
              toast({ kind: "error", message: errorPresentation(error).message });
            },
            onSettled: () => setPendingId(null),
          },
        );
      })();
    },
    [confirm, toast, toggle],
  );

  const keyExtractor = useCallback((cap: FrequencyCap) => cap.id, []);
  const renderRow = useCallback<ListRenderItem<FrequencyCap>>(
    ({ item }) => (
      <FrequencyCapCard
        cap={item}
        onToggle={canToggle ? onToggle : null}
        busy={pendingId === item.id}
      />
    ),
    [canToggle, onToggle, pendingId],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Frequency caps" onBack={goBackOrMore} />
      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        ListHeaderComponent={
          // paddingBottom, not just paddingTop: this header ends in a
          // two-line caption and the list's EMPTY-STATE CARD renders directly
          // beneath it, so with no bottom gap the card's top edge cut through
          // the caption's last line ("...this screen is the read and the on/off
          // switch"). Seen in-app on 2026-08-19. The sibling filter bars
          // (AuditFilterBar, DiscountsFilterBar) already carry a bottom pad for
          // the same reason.
          <View
            style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12 }}
          >
            <Text
              {...typeCap("bodySmall")}
              accessibilityLiveRegion="polite"
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {caps.isLoading
                ? "Reading caps…"
                : capsSummaryHeadline({ loaded: capsLoaded, caps: rows })}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                marginTop: 4,
                fontFamily: FONT.regular,
              }}
            >
              A cap defers a message rather than dropping it. Creating and
              editing rules stays on desktop; this screen is the read and the
              on/off switch.
            </Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
          />
        }
        ListEmptyComponent={
          <QueryStates
            query={caps}
            isEmpty={rows.length === 0}
            gate={gate}
            empty={{
              title: "No frequency caps configured",
              description:
                "Nothing is limiting how often this workspace can message a subscriber. Rules are created on the desktop Sending settings screen.",
            }}
            offlineMessage="Frequency caps are not cached for offline reading."
          >
            <View />
          </QueryStates>
        }
        {...MOBILE_LIST_PERF_PROPS}
      />
    </SafeAreaView>
  );
}
