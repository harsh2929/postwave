/**
 * DuplicatesScreen — "did the dedupe scan find anything, and can I clear the
 * obvious ones from here".
 *
 * WHY THIS IS ON A PHONE AT ALL, AND WHAT IS NOT. The desktop's
 * `DuplicatesModal.tsx` is 1,084 lines: a confidence-threshold setting, a
 * bulk-select toolbar, a merge-field schema editor next door. All of that is
 * CONFIGURATION and it stays on the desktop — a phone is the wrong device for
 * deciding what counts as a duplicate. What ports is the queue itself: two
 * addresses, the server's stated reason, and one decision. That is a triage
 * task, and triage is what a phone is for.
 *
 * THE ONE THING THIS SCREEN DOES THAT COSTS THE SERVER REAL WORK. There is no
 * route that lists PAST scans — `duplicate-scans` is POST-only
 * (subscriber_dedupe.go:37) — so "open a scan" is not a thing that exists.
 * Opening this screen MATERIALIZES a scan: `GET /api/v1/subscribers/duplicates`
 * runs `createCompleteScan`, which takes a per-tenant advisory lock and walks
 * every subscriber inside one repeatable-read transaction (scan.go:221-293).
 * The screen therefore says so, holds the result for ten minutes, never
 * auto-retries, and treats pull-to-refresh as "scan again" rather than
 * pretending it is a cheap re-read.
 *
 * READ AND WRITE HAVE DIFFERENT FLOORS AND THE SCREEN MODELS BOTH. The queue
 * is viewer-readable; the merge is owner/admin. Both were read off the handler
 * AND the generated policy manifest — see the header of
 * `api/subscriberDuplicates.ts` for the two-guard derivation.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
  type ListRenderItem,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { QueryStates } from "@/components/QueryStates";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { DuplicatePairReview } from "@/components/duplicates/DuplicatePairReview";
import { DuplicatePairRow } from "@/components/duplicates/DuplicatePairRow";
import { DuplicateScanCard } from "@/components/duplicates/DuplicateScanCard";
import {
  DUPLICATE_PAIRS_PAGE_SIZE,
  isDuplicateRoleDenied,
  isDuplicateScanBusy,
} from "@/api/subscriberDuplicates";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useDuplicatePairPages,
  useDuplicateScan,
} from "@/hooks/useSubscriberDuplicates";
import {
  mergePairPages,
  pairKey,
  scanIsExpired,
  staleLoadedCount,
  type DuplicatePair,
} from "@/lib/duplicateScan";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/**
 * A stable empty list. A fresh `[]` would be a new identity on every render and
 * would make the FlatList re-diff its (empty) data each time.
 */
const NO_PAIRS: readonly DuplicatePair[] = [];

const pairListKey = (pair: DuplicatePair) => pairKey(pair);

export function DuplicatesScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  // Off the store, not the gate: the store holds the auth MODE as well as the
  // role, and an api_key session has to default-deny here. The mobile sign-in
  // response never enumerates a key's scopes, and routeauth wants the `admin`
  // scope for `/merge/apply` — so `canAccessMinimumRole` refuses anything
  // above viewer on that path rather than offering a control that may 403.
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("subscriber-duplicates");

  const canMerge = canAccessMinimumRole("admin", role, mode);
  const scanQuery = useDuplicateScan();
  const scan = scanQuery.data?.scan ?? null;
  const scanId = scan?.id ?? "";
  const firstCursor = scanQuery.data?.nextCursor ?? "";
  // Paging is opt-in: a mounted infinite query fetches eagerly, and pulling a
  // second page nobody asked for would double the cellular cost of a screen
  // whose whole argument is that twenty-five rows is the right first read.
  const [paging, setPaging] = useState(false);
  const pageQuery = useDuplicatePairPages(scanId, firstCursor, paging);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Merged rows are remembered locally rather than by re-scanning: a rescan is
  // a full workspace walk, and spending one to grey out a single row would be
  // an expensive way to say something the response already said.
  const [mergedKeys, setMergedKeys] = useState<readonly string[]>([]);

  const pairs = useMemo<DuplicatePair[]>(() => {
    const first = scanQuery.data?.pairs ?? [];
    const rest = pageQuery.data?.pages?.map((page) => page.pairs) ?? [];
    return mergePairPages([first, ...rest]);
  }, [scanQuery.data, pageQuery.data]);

  const refresh = useManualRefresh([scanQuery.refetch], {
    enabled: gate.enabled,
  });

  const onSelect = useCallback((key: string) => {
    setSelectedKey((current) => (current === key ? null : key));
  }, []);

  const onMerged = useCallback((key: string) => {
    setMergedKeys((current) =>
      current.includes(key) ? current : [...current, key],
    );
    setSelectedKey(null);
  }, []);

  const roleDenied = isDuplicateRoleDenied(scanQuery.error);
  const scanBusy = isDuplicateScanBusy(scanQuery.error);
  const stale = staleLoadedCount(pairs);
  // Read once per render rather than per row: an expired manifest makes every
  // pair under it unmergeable, and the reason is the SCAN's, not the pair's.
  const expired = scanIsExpired(scan, Date.now());
  const total = scan?.candidateCount ?? null;

  const subtitle =
    scan && total !== null
      ? `${plural(total, "pair")} · ${num(pairs.length)} loaded`
      : undefined;

  /**
   * VIRTUALIZED, because this list has no ceiling. The pager appends 25 pairs
   * per press onto whatever is already loaded, and these rows used to be a
   * `.map()` inside a ScrollView — so ten presses mounted 250 row components
   * at once, none of which could be recycled, on the screen whose whole
   * argument is that it is cheap to open. Everything that framed the list is
   * now the header and the footer; the rows are the FlatList's data.
   */
  // The rows are withheld in exactly the states QueryStates used to take the
  // list over in: a failed read REPLACES the queue rather than sitting above a
  // stale copy of it, which is what wrapping the `.map()` used to guarantee.
  const listData = scanQuery.isError ? NO_PAIRS : pairs;
  const renderPair = useCallback<ListRenderItem<DuplicatePair>>(
    ({ item }) => {
      const key = pairKey(item);
      const selected = key === selectedKey;
      return (
        <View>
          <DuplicatePairRow
            pair={item}
            selected={selected}
            merged={mergedKeys.includes(key)}
            onSelect={onSelect}
          />
          {selected ? (
            <DuplicatePairReview
              pair={item}
              scanId={scanId}
              canMerge={canMerge}
              gate={gate}
              scanExpired={expired}
              onMerged={onMerged}
            />
          ) : null}
        </View>
      );
    },
    [
      selectedKey,
      mergedKeys,
      scanId,
      canMerge,
      gate,
      expired,
      onSelect,
      onMerged,
    ],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Duplicates"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <FlatList
        data={listData}
        keyExtractor={pairListKey}
        renderItem={renderPair}
        {...MOBILE_LIST_PERF_PROPS}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          roleDenied ? (
            <RoleGateNotice
              live
              title="Your session cannot read the duplicate scan"
              body="Reading candidate duplicates needs a workspace session on this server. Ask an owner or admin to run the scan, or open Subscribers on the web admin."
            />
          ) : scanBusy ? (
            <BusyNotice />
          ) : (
            <>
              {scan ? <DuplicateScanCard scan={scan} /> : null}

              <SectionLabel
                subtitle={
                  stale > 0
                    ? `${num(stale)} of the ${plural(pairs.length, "pair")} loaded here changed after the scan and can no longer be merged against it.`
                    : "Every pair below carries the server's own reason for surfacing it."
                }
              >
                Candidate pairs
              </SectionLabel>

              <QueryStates
                query={scanQuery}
                gate={gate}
                isEmpty={pairs.length === 0}
                offlineMessage="A duplicate scan is computed by the server, so it needs a connection. This is not the same as having no duplicates."
                skeleton={
                  <SkeletonList rows={4} lines={3} label="Scanning for duplicates" />
                }
                empty={{
                  title: "No duplicate candidates",
                  description:
                    "The scan covered the whole workspace and found no two records that resolve to the same person. This is a total, not a sample.",
                }}
              >
                {/* QueryStates owns loading / empty / error / offline and
                    renders its children only once the read has succeeded. The
                    pairs are the FlatList's data, so nothing is left for it. */}
                {null}
              </QueryStates>
            </>
          )
        }
        ListFooterComponent={
          listData.length > 0 ? (
            <LoadMore
              hasMore={
                paging ? pageQuery.hasNextPage === true : firstCursor !== ""
              }
              busy={
                pageQuery.isFetchingNextPage === true ||
                (paging && pageQuery.isFetching === true)
              }
              loaded={pairs.length}
              total={total}
              onPress={() => {
                haptics.tap();
                // The first press MOUNTS the pager, which fetches page two
                // by itself; every press after that walks the cursor.
                if (!paging) {
                  setPaging(true);
                  return;
                }
                void pageQuery.fetchNextPage();
              }}
            />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

/**
 * The "load more" affordance, which doubles as the honest denominator.
 *
 * When there is nothing more to fetch it still states how many of the
 * manifest's pairs the device is holding, because a list that simply stops is
 * indistinguishable from a list that was truncated.
 */
function LoadMore({
  hasMore,
  busy,
  loaded,
  total,
  onPress,
}: {
  hasMore: boolean;
  busy: boolean;
  loaded: number;
  total: number | null;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const denominator = total === null ? "an unreported total" : num(total);
  if (!hasMore) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 8,
        }}
      >
        {`Showing all ${num(loaded)} of ${denominator} candidate pairs.`}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Load the next ${DUPLICATE_PAIRS_PAGE_SIZE} candidate pairs. ${num(loaded)} of ${denominator} loaded.`}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={{
        minHeight: 44,
        marginTop: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: t.surface,
        opacity: busy ? 0.7 : 1,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {busy
          ? "Loading…"
          : `Load more — ${num(loaded)} of ${denominator}`}
      </Text>
    </Pressable>
  );
}

/**
 * The 409 branch. A scan is serialized per tenant by an advisory lock
 * (scan.go:237-245), so this means a colleague or a desktop tab is scanning
 * right now — which is a fact about the workspace, not a fault, and pretending
 * it was an error would send someone debugging.
 */
function BusyNotice() {
  const { t } = useTheme();
  const body =
    "A complete duplicate scan is already running for this workspace — they are serialized so two scans cannot disagree. Pull to refresh in a moment.";
  return (
    <View
      accessible
      accessibilityLabel={`A scan is already running. ${body}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 16,
        gap: 8,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        A scan is already running
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
    </View>
  );
}
