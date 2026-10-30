/**
 * Agent routines — the standing instructions the platform runs on its own,
 * and the button that runs one right now.
 *
 * A complete subsystem shipped server-side (`apps/api/internal/agent_routines`
 * — model, repo, runner, minute-tick scheduler, seven routes wired from
 * main.go:3219) with ZERO mobile references. The only signal a routine had
 * failed was a pending approval that never arrived, and the only way to notice
 * was to open a laptop.
 *
 * WHY THIS IS A PHONE SURFACE AND NOT A DESK ONE. The three verbs it exposes
 * are the ones whose LATENCY is felt: did the Monday re-engagement brief
 * actually run, did it fail, and can I kick it off before the meeting. Each is
 * a ten-second glance. Authoring the 8000-rune brief is not, and is
 * deliberately absent (see the "deliberately not here" list in api/agentRoutines).
 *
 * THE ONE THING THE LIST CANNOT TELL YOU. `Repo.ListRoutines` selects
 * `last_run_at` and nothing about the OUTCOME of that run, and there is no
 * cross-routine run feed in the API — the only history endpoint is per routine.
 * So the list says WHEN each routine ran and never WHETHER it worked; the
 * outcome appears when you open one. What the list CAN derive honestly, and
 * does, is whether the platform is LATE: `last_run_at` plus the schedule's
 * interval is exactly the predicate `Repo.FindDue` scans on, so an "Overdue"
 * badge here is the same arithmetic the scheduler itself does.
 *
 * ROLE. Reading is `viewer` (`read:campaigns`); running is `editor`
 * (`write:campaigns`) because a run spends LLM quota and writes drafts. A
 * viewer sees everything and is told plainly that running needs an editor,
 * rather than discovering it via a 403 after a confirm sheet.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { router, useIsFocused } from "expo-router";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  Text,
  View,
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
import { AgentRoutineDetailSheet } from "@/components/agent-routines/AgentRoutineDetailSheet";
import { AgentRoutineRow } from "@/components/agent-routines/AgentRoutineRow";
import {
  useAgentRoutineRuns,
  useAgentRoutines,
  useRunAgentRoutineNow,
  useSetAgentRoutineEnabled,
} from "@/hooks/useAgentRoutines";
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
  orderRoutines,
  routineEnableCopy,
  routineEnableErrorMessage,
  runNowCopy,
  runNowErrorMessage,
  runNowSuccessMessage,
} from "@/lib/agentRoutineSchedule";
import {
  matchesRoutineFilter,
  matchesRoutineQuery,
  routineFilterCounts,
  ROUTINE_FILTERS,
  type AgentRoutine,
  type RoutineFilter,
} from "@/lib/agentRoutines";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

const FILTER_LABELS: Record<RoutineFilter, string> = {
  all: "All",
  scheduled: "Scheduled",
  manual: "Manual",
  paused: "Paused",
};

const EMPTY_COPY: Record<RoutineFilter, { title: string; description: string }> =
  {
    all: {
      title: "No agent routines yet",
      description:
        "A routine is a standing brief — “every Monday, draft a re-engagement campaign for lapsed subscribers”. They are written on desktop; once one exists, its schedule and every run it makes show up here.",
    },
    scheduled: {
      title: "Nothing on a schedule",
      description:
        "No routine is both enabled and set to daily, weekly or monthly, so the platform is not running anything on its own right now.",
    },
    manual: {
      title: "No manual-only routines",
      description:
        "Manual routines never run themselves — they wait for someone to press Run now.",
    },
    paused: {
      title: "Nothing paused",
      description:
        "Every routine in this workspace is enabled. A paused routine is skipped by the scheduler entirely, but can still be run by hand.",
    },
  };

export default function AgentRoutines() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("agent-routines");

  const mode = useAuthStore((s) => s.mode);
  // POST /api/v1/agent-routines/{id}/run is session_minimum_role: editor.
  const canRun = canAccessMinimumRole("editor", gate.effectiveRole, mode);

  const [filter, setFilter] = useState<RoutineFilter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const routines = useAgentRoutines();
  const runs = useAgentRoutineRuns(openId);
  const runNow = useRunAgentRoutineNow();
  const setEnabled = useSetAgentRoutineEnabled();
  const refresh = useRefreshControl(routines);

  // "Overdue", "due now" and "in 4h" all age while the screen sits open on a
  // desk. Without a ticker they freeze at whatever they said on mount.
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * relativeTime ("Overdue", "in 4h") plus a 15-MINUTE schedule grace, so 59
   * of every 60 ticks used to re-render the whole screen — and every row
   * that takes `now` as a prop — to repaint an identical string. Measured:
   * 60 renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  const all = useMemo(() => (Array.isArray(routines.data) ? routines.data : []), [routines.data]);
  const counts = useMemo(() => routineFilterCounts(all), [all]);

  const rows = useMemo(
    () =>
      orderRoutines(
        all.filter(
          (routine) =>
            matchesRoutineFilter(routine, filter) &&
            matchesRoutineQuery(routine, query),
        ),
        now,
      ),
    [all, filter, query, now],
  );

  const openRoutine = useMemo(
    () => all.find((routine) => routine.id === openId) ?? null,
    [all, openId],
  );

  const start = useCallback(
    async (routine: AgentRoutine) => {
      if (runNow.isPending) return;
      const copy = runNowCopy(routine);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        consequence: copy.consequence,
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
      });
      if (!ok) return;
      // Acknowledge the press; the success thump waits for the 202, so a
      // failing network never feels like a success followed by an error.
      haptics.impact();
      try {
        await runNow.mutateAsync({ routineId: routine.id });
        haptics.success();
        // No undo: nothing in the API cancels an in-flight run, so offering
        // one would be a lie about what the button can do.
        toast({ kind: "success", message: runNowSuccessMessage(routine.name) });
        // Open the history so the outcome the poll is about to fetch has
        // somewhere to land, instead of a toast and a list that looks unchanged.
        setOpenId(routine.id);
      } catch (error) {
        haptics.error();
        toast({ kind: "error", message: runNowErrorMessage(error) });
      }
    },
    [confirm, runNow, toast],
  );

  const togglePaused = useCallback(
    async (routine: AgentRoutine) => {
      if (setEnabled.isPending) return;
      const copy = routineEnableCopy(routine);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        destructive: routine.enabled,
      });
      if (!ok) return;
      try {
        await setEnabled.mutateAsync({
          routineId: routine.id,
          enabled: !routine.enabled,
        });
        toast({
          kind: "success",
          message: routine.enabled
            ? `${routine.name} paused.`
            : `${routine.name} resumed.`,
        });
      } catch (error) {
        toast({
          kind: "error",
          message: routineEnableErrorMessage(
            error && typeof error === "object" && "status" in error
              ? Number((error as { status?: unknown }).status)
              : undefined,
            `Couldn't ${routine.enabled ? "pause" : "resume"} ${routine.name}.`,
          ),
        });
      }
    },
    [confirm, setEnabled, toast],
  );

  const openApproval = useCallback((approvalId: string) => {
    setOpenId(null);
    router.push({
      pathname: "/(tabs)/approvals/[id]",
      params: { id: approvalId },
    });
  }, []);

  // Hoisted out of the FlatList: a fresh `renderItem` on every render is read
  // by VirtualizedList as a changed row renderer, so every mounted cell
  // re-renders — on a screen whose search field re-renders it per keystroke
  // and whose `now` ticks on a timer.
  const openRoutineRow = useCallback(
    (routine: AgentRoutine) => setOpenId(routine.id),
    [],
  );
  const keyExtractor = useCallback((routine: AgentRoutine) => routine.id, []);
  const renderRoutine = useCallback<ListRenderItem<AgentRoutine>>(
    ({ item }) => (
      <AgentRoutineRow
        routine={item}
        onPress={openRoutineRow}
        now={now}
        busy={runNow.isPending && runNow.variables?.routineId === item.id}
      />
    ),
    [now, openRoutineRow, runNow.isPending, runNow.variables],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Agent routines"
        {...(routines.data
          ? { subtitle: `${plural(all.length, "routine")} · ${FILTER_LABELS[filter]}` }
          : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
        <SegmentedControl
          accessibilityLabel="Routine state"
          scrollable
          options={ROUTINE_FILTERS.map((value) => ({
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
          placeholder="Search routines"
          accessibilityLabel="Search routines by name or brief"
          resultCount={rows.length}
          resultNoun="routine"
        />
      </View>

      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={routines.data === undefined ? [] : rows}
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
              A routine only ever produces a DRAFT — nothing here schedules or
              sends anything. Whether a run succeeded is recorded per routine;
              open one to read its history.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={routines}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so your routines can't be loaded — and a run wouldn't reach the agent. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={4} />}
            empty={
              query.trim()
                ? {
                    title: "No match",
                    description:
                      "No routine's name or brief contains that. Clear the search to see them all.",
                  }
                : EMPTY_COPY[filter]
            }
          >
            {null}
          </QueryStates>
        }
        renderItem={renderRoutine}
      />

      <AgentRoutineDetailSheet
        routine={openRoutine}
        runs={Array.isArray(runs.data) ? runs.data : []}
        runsQuery={runs}
        gate={gate}
        now={now}
        onClose={() => setOpenId(null)}
        onRunNow={(routine) => void start(routine)}
        running={runNow.isPending}
        onToggleEnabled={(routine) => void togglePaused(routine)}
        togglingEnabled={setEnabled.isPending}
        canRun={canRun}
        online={online}
        onOpenApproval={openApproval}
      />
    </SafeAreaView>
  );
}
