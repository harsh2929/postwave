/**
 * FlowAbTestsScreen — "are the splits inside my automations collecting, and is
 * anything pulling ahead?"
 *
 * See the route file for why this surface exists and where its authorization
 * comes from. This file owns the composition: the catalogue, one headline, and
 * the detail sheet.
 *
 * THREE EMPTY-LOOKING STATES THAT MEAN COMPLETELY DIFFERENT THINGS, which is
 * the whole reason this screen is careful. "No splits configured" is a fact
 * about the workspace; "the list could not be loaded" is a fact about the
 * network; "configured, but nothing assigned" is a fact about the RUNTIME —
 * and only the last one is an operational problem you would want to be woken
 * for. Each has its own branch, and none of them renders as a set of zeroes.
 *
 * THE LIST IS NOT SORTED BY RECENCY ALONE. `Repo.List` already answers
 * `ORDER BY created_at DESC` (flowabtests.go:79), but a completed test is a
 * historical record and a running one is a live measurement, so running tests
 * are floated to the top within that order. The sort is stable, so the
 * server's ordering survives inside each group.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { FlowAbTestRow } from "@/components/flow-ab/FlowAbTestRow";
import { FlowAbTestSheet } from "@/components/flow-ab/FlowAbTestSheet";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useFlowAbResults,
  useFlowAbTest,
  useFlowAbTests,
} from "@/hooks/useFlowAbTests";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { FLOW_AB_SCOPE_NOTE } from "@/lib/flowAbPolicy";
import type { MobileFlowAbTest } from "@/lib/flowAbTests";
import { EMDASH, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Running first, then the server's own newest-first order within each group. */
function orderTests(
  tests: readonly MobileFlowAbTest[],
): readonly MobileFlowAbTest[] {
  return tests
    .map((test, index) => ({ test, index }))
    .sort((a, b) => {
      const rank = (t: MobileFlowAbTest) => (t.status === "running" ? 0 : 1);
      const byRank = rank(a.test) - rank(b.test);
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map((entry) => entry.test);
}

export function FlowAbTestsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("flow-ab-tests");

  const queriesEnabled = gate.enabled && Boolean(gate.tenantId);
  const [openId, setOpenId] = useState<string | null>(null);

  const tests = useFlowAbTests();
  const detail = useFlowAbTest(openId);
  const results = useFlowAbResults(openId);
  const refresh = useRefreshControl(tests);
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * relativeTime ("Updated 2d ago"), nothing finer, so 59 of every 60 ticks
   * used to re-render the whole screen — and every row that takes `now` as a
   * prop — to repaint an identical string. Measured: 60 renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  const rows = useMemo(
    // Array.isArray, not `?? []`: orderTests sorts, and a truthy non-array
    // from the wire reaches the comparator.
    () => orderTests(Array.isArray(tests.data) ? tests.data : []),
    [tests.data],
  );
  const openTest = useMemo(
    () => rows.find((row) => row.id === openId) ?? null,
    [rows, openId],
  );
  const running = rows.filter((row) => row.status === "running").length;

  // ABSENCE IS NOT ZERO: until the list has actually resolved, the count of
  // running splits is UNKNOWN, and an em-dash says so. "0 running" is a very
  // specific and reassuring claim to make about a workspace whose list you
  // failed to fetch.
  const countsUnknown =
    tests.isError || tests.data === undefined || (!queriesEnabled && rows.length === 0);
  const subtitle = countsUnknown
    ? `${EMDASH} running`
    : `${num(running)} running · ${plural(rows.length, "split")}`;

  const openRow = useCallback(
    (test: MobileFlowAbTest) => setOpenId(test.id),
    [],
  );
  const closeSheet = useCallback(() => setOpenId(null), []);
  const keyExtractor = useCallback((row: MobileFlowAbTest) => row.id, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Flow A/B tests"
        subtitle={subtitle}
        onBack={goBackOrMore}
      />

      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={tests.data === undefined ? [] : rows}
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
            enabled={queriesEnabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            <MobileScopeNotice body={FLOW_AB_SCOPE_NOTE} />
            {countsUnknown ? null : (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                  marginBottom: 12,
                }}
              >
                {running === 0
                  ? "Nothing is collecting right now. Open a split to see what it recorded while it ran."
                  : "Open a split to see its per-arm assignment and conversion counters."}
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <QueryStates
            query={{
              isError: tests.isError,
              isLoading: tests.isLoading,
              isPending: tests.isPending,
              isPaused: tests.isPaused,
              error: tests.error,
              refetch: tests.refetch,
            }}
            gate={{ enabled: queriesEnabled }}
            isEmpty={rows.length === 0}
            skeleton={
              <SkeletonList rows={4} lines={3} label="Loading flow A/B tests" />
            }
            offlineMessage="Connect to your workspace to load in-flow A/B tests. A cached conversion rate of unknown age is worse than none."
            empty={{
              title: "No in-flow A/B tests",
              description:
                "No automation in this workspace has a split configured. Splits are authored on the flow canvas; this screen is where you watch what they collect.",
            }}
          >
            {null}
          </QueryStates>
        }
        renderItem={({ item }) => (
          <FlowAbTestRow test={item} onPress={openRow} now={now} />
        )}
      />

      <FlowAbTestSheet
        test={openTest}
        detail={detail.data ?? null}
        results={Array.isArray(results.data) ? results.data : []}
        resultsLoading={results.isLoading}
        resultsFailed={results.isError}
        onClose={closeSheet}
      />
    </SafeAreaView>
  );
}
