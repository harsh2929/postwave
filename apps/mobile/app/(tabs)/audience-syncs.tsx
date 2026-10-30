/**
 * Audience syncs — did the nightly push to the destination actually work, and
 * if not, what broke.
 *
 * A complete reverse-ETL subsystem ships server-side
 * (`apps/api/internal/audience_destinations` — repo, runner, activation
 * firewall, minute-tick scheduler, seven routes) with ZERO mobile references
 * until now. Its failures are discovered HOURS later, by definition: a daily
 * sync fires at 3am, the destination gets nothing, and the first person to
 * notice is whoever opens a laptop. That is exactly the class of thing a phone
 * should surface.
 *
 * MONITOR, NOT CONSOLE — AND THE MISSING FORM IS DELIBERATE. Creating a sync
 * means choosing a source list or segment, a destination type, an HTTPS
 * receiver URL and an HMAC signing secret, against a validator that rejects
 * nine distinct shapes (`validateCreate`, syncs.go:244). Editing one is worse:
 * the destination config round-trips MASKED, and a client that fails to strip
 * the "••••" sentinel overwrites a real stored credential with four bullets
 * (`stripMaskedConfigKeys`, syncs.go:418). Both stay on desktop. The phone gets
 * the two verbs whose LATENCY is felt — see that it broke, and push it again.
 *
 * WHY THIS ROUTE IS `viewer`. Both reads are mounted behind
 * `apikeys.RequireScope(ScopeReadSubscribers)` (sync_handlers.go:45, :57), and
 * `ScopeReadSubscribers` is in the `readOnlyScopes` allowlist
 * (apikeys/middleware.go:332-337), so `requireAdminRoleForScopes` is false and
 * any authenticated dashboard session clears them. Running is separate:
 * `POST /{id}/run` is `ScopeWriteSubscribers` (sync_handlers.go:55), which is
 * NOT read-only but IS in `editorWriteScopes` (middleware.go:291-294) — so
 * owner, admin and editor may run one and viewer/member may not. A viewer sees
 * every failure and is told plainly that re-running needs an editor, rather
 * than discovering it via a 403 after a confirm sheet.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  RefreshControl,
  Text,
  View,
  type ListRenderItem,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { AudienceSyncDetailSheet } from "@/components/audience-syncs/AudienceSyncDetailSheet";
import { AudienceSyncRow } from "@/components/audience-syncs/AudienceSyncRow";
import {
  useAudienceSyncRuns,
  useAudienceSyncs,
  useRunAudienceSyncNow,
} from "@/hooks/useAudienceSyncs";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import {
  matchesSyncFilter,
  matchesSyncQuery,
  orderSyncs,
  syncFilterCounts,
  SYNC_FILTERS,
  type SyncFilter,
} from "@/lib/audienceSyncHealth";
import {
  newRunOperationKey,
  runNowCopy,
  runNowErrorMessage,
  runNowResultMessage,
} from "@/lib/audienceSyncRunNow";
import {
  destinationTypeLabel,
  sourceLabel,
  type AudienceSync,
} from "@/lib/audienceSyncs";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

const FILTER_LABELS: Record<SyncFilter, string> = {
  all: "All",
  failing: "Failing",
  overdue: "Overdue",
  paused: "Paused",
};

const EMPTY_COPY: Record<SyncFilter, { title: string; description: string }> = {
  all: {
    title: "No audience syncs yet",
    description:
      "A sync pushes a list or segment out to somewhere else — an ad platform's custom audience, or your own signed webhook. They are created on desktop; once one exists, every run it makes shows up here.",
  },
  failing: {
    title: "Nothing is failing",
    description:
      "Every sync's last run finished cleanly. A run counts as failing here if it failed outright, was rejected by the size cap, delivered only part of the audience, or never acknowledged an outcome.",
  },
  overdue: {
    title: "Nothing is overdue",
    description:
      "Every scheduled sync has run inside its interval. A paused or manual-only sync is never overdue — the scheduler does not look at either.",
  },
  paused: {
    title: "Nothing is paused",
    description:
      "Every sync in this workspace is enabled. A paused sync is skipped by the scheduler AND refused a manual run, so nothing reaches its destination at all.",
  },
};

export default function AudienceSyncs() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("audience-syncs");

  const mode = useAuthStore((s) => s.mode);
  // POST /api/v1/audience-syncs/{id}/run is RequireScope(write:subscribers),
  // which on the session path admits owner | admin | editor.
  const canRun = canAccessMinimumRole("editor", gate.effectiveRole, mode);

  const [filter, setFilter] = useState<SyncFilter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const syncs = useAudienceSyncs();
  const runs = useAudienceSyncRuns(openId);
  const runNow = useRunAudienceSyncNow();
  const refresh = useRefreshControl(syncs);

  // "Overdue since 2h ago" and "Next run in 40m" both age while the screen sits
  // open on a desk. Without a ticker they freeze at whatever they said on mount.
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * relativeTime plus a schedule grace of at least 5 minutes, so 59 of every
   * 60 ticks used to re-render the whole screen — and every row that takes
   * `now` as a prop — to repaint an identical string. Measured: 60
   * renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  /**
   * Coerced to an array rather than trusted. `?? []` is a NULLISH guard: it
   * lets a truthy `{}` or `{items: []}` through, and this app REHYDRATES its
   * query cache from disk (lib/secureQueryPersister), so a cache entry written
   * by an older build's response shape can arrive here after an app update.
   * `syncFilterCounts` iterates with for-of, so that value takes the whole
   * screen down inside render — the same route by which api-keys shipped
   * "Invalid attempt to spread non-iterable instance". An empty list plus a
   * refetch is recoverable; a thrown render is not.
   */
  const all = useMemo(
    () => (Array.isArray(syncs.data) ? syncs.data : []),
    [syncs.data],
  );
  const counts = useMemo(() => syncFilterCounts(all, now), [all, now]);

  const rows = useMemo(
    () =>
      orderSyncs(
        all.filter(
          (sync) =>
            matchesSyncFilter(sync, filter, now) && matchesSyncQuery(sync, query),
        ),
        now,
      ),
    [all, filter, query, now],
  );

  const openSync = useMemo(
    () => all.find((sync) => sync.id === openId) ?? null,
    [all, openId],
  );

  const start = useCallback(
    async (sync: AudienceSync) => {
      if (runNow.isPending) return;
      const copy = runNowCopy({
        name: sync.name,
        enabled: sync.enabled,
        schedule: sync.schedule,
        destinationType: sync.destination.type,
        destinationLabel: destinationTypeLabel(sync.destination.type),
        sourceLabel: sourceLabel(sync),
      });
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        consequence: copy.consequence,
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
      });
      if (!ok) return;
      // Acknowledge the press; the outcome thump waits for the response, so a
      // failed run never feels like a success followed by an error.
      haptics.impact();
      try {
        const run = await runNow.mutateAsync({
          syncId: sync.id,
          idempotencyKey: newRunOperationKey(sync.id),
        });
        // THE TRAP THIS BRANCH EXISTS FOR: a FAILED run is HTTP 200 with
        // `status:"failed"` (sync_handlers.go:172-175), so `mutateAsync`
        // resolving is not a success. The outcome is read off the returned row.
        const result = runNowResultMessage(run, sync.name);
        if (result.kind === "success") haptics.success();
        else if (result.kind === "error") haptics.error();
        // No undo: nothing in the API recalls a delivered batch, so offering
        // one would be a lie about what the button can do.
        toast({ kind: result.kind, message: result.message });
      } catch (error) {
        haptics.error();
        toast({ kind: "error", message: runNowErrorMessage(error) });
      }
    },
    [confirm, runNow, toast],
  );

  /**
   * Hoisted out of the FlatList, and the `onPress` arrow hoisted out of the
   * ROW, for the reason the lookalike list documents: `AudienceSyncRow` is
   * `React.memo`'d, and a callback rebuilt on every parent render is a changed
   * prop, so the memo could never hold. Measured on 30 syncs with 10 rows in
   * the window: 10 row-body renders for every re-render of this screen that
   * changed nothing a row displays — a keystroke in the search field, opening
   * or closing the detail sheet, a run's pending flag settling. Now 0.
   */
  const openRow = useCallback((sync: AudienceSync) => setOpenId(sync.id), []);
  const closeSheet = useCallback(() => setOpenId(null), []);
  const keyExtractor = useCallback((sync: AudienceSync) => sync.id, []);
  const renderSync = useCallback<ListRenderItem<AudienceSync>>(
    ({ item }) => (
      <AudienceSyncRow
        sync={item}
        onPress={openRow}
        now={now}
        busy={runNow.isPending && runNow.variables?.syncId === item.id}
      />
    ),
    [now, openRow, runNow.isPending, runNow.variables],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Audience syncs"
        {...(syncs.data
          ? { subtitle: `${plural(all.length, "sync")} · ${FILTER_LABELS[filter]}` }
          : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
        <SegmentedControl
          accessibilityLabel="Sync health"
          scrollable
          options={SYNC_FILTERS.map((value) => ({
            value,
            label: FILTER_LABELS[value],
            badge: counts[value],
          }))}
          value={filter}
          onChange={setFilter}
        />
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search syncs"
          accessibilityLabel="Search syncs by name or destination"
          resultCount={rows.length}
          resultNoun="sync"
        />
      </View>

      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard
        // covers roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={syncs.data === undefined ? [] : rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 12,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListFooterComponent={
          rows.length > 0 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              Sources, destinations and schedules are edited on desktop. Every
              run withholds anyone who has not consented for the destination&apos;s
              purpose — open a sync to see how many.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={syncs}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so your syncs can't be loaded — and a run wouldn't reach the destination. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={4} />}
            empty={
              query.trim()
                ? {
                    title: "No match",
                    description:
                      "No sync's name or destination contains that. Clear the search to see them all.",
                  }
                : EMPTY_COPY[filter]
            }
          >
            {null}
          </QueryStates>
        }
        renderItem={renderSync}
      />

      {/* `runs` gets the same coercion as the list above: the sheet `.map`s it,
          and a rehydrated non-array would throw inside render. */}
      <AudienceSyncDetailSheet
        sync={openSync}
        runs={Array.isArray(runs.data) ? runs.data : []}
        runsQuery={runs}
        gate={gate}
        now={now}
        onClose={closeSheet}
        onRunNow={(sync) => void start(sync)}
        running={runNow.isPending}
        canRun={canRun}
        online={online}
      />
    </SafeAreaView>
  );
}
