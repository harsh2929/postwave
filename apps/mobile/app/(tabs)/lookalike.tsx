/**
 * Lookalike audiences — is that modeled audience actually any good, and how
 * old is it.
 *
 * WHICH OF THE TWO LOOKALIKE FAMILIES THIS SCREEN TALKS TO, AND WHY. Both are
 * mounted and both are live, and only one of them can back a list screen:
 *
 *   /api/v1/audiences/lookalike   (audiences/handlers.go:37-45) — POST create,
 *   GET /{id}, GET /{id}/members, DELETE /{id}. NO LIST ROUTE. A phone surface
 *   built on it would have nothing to open, because the only way to reach a
 *   model is to already hold its uuid.
 *
 *   /api/v1/subscribers/lookalike (subscribers/lookalike.go:461-471) — the same
 *   verbs PLUS `GET /api/v1/subscribers/lookalike`, which returns every saved
 *   audience newest-first. That list is the whole reason this screen exists, so
 *   this is the family it uses. The two persist to SEPARATE tables (migrations
 *   0949/0950 for this one), so the choice genuinely changes which saved
 *   audiences appear — it is not a preference between two views of one thing.
 *
 * WHY THIS IS A MONITOR AND NOT A GENERATOR. Desktop wraps the create path in a
 * 1,405-line modal, and the reasons that is desktop work are all in the handler
 * rather than in the design:
 *   - `data_use_acknowledged` must be true or the request is refused
 *     (lookalike.go:74), and what gets stored beside it is a VERSIONED
 *     compliance record (`data_use_notice_version`, lookalike.go:158-162). A
 *     tick-box on a phone, without the notice it acknowledges, files a consent
 *     nobody read.
 *   - Create is SYNCHRONOUS and heavy — one transaction ranks up to 50,000
 *     candidates and then inserts the members one row at a time — and the route
 *     takes no idempotency key. On cellular it outlives the client timeout while
 *     the server commits anyway, so a retry is a SECOND audience.
 *   - The seed is a saved segment chosen from the whole catalogue, plus a size
 *     and a confidence floor.
 * There is also no long-running job to poll: `CreateLookalike` inserts a literal
 * `'ready'` (lookalike.go:169) because the work already happened inline. The
 * status column can still hold 'pending' | 'running' | 'failed' (migration 0949
 * says so explicitly, for a future async generator), so this screen renders
 * those states honestly and refuses to print a member count for them — but
 * there is nothing here that fakes a progress bar over a request that has none.
 *
 * WHY IT IS `viewer`. `GET /api/v1/subscribers/lookalike` and its detail are
 * mounted behind `apikeys.RequireScope(ScopeReadSubscribers)`
 * (lookalike.go:464, :466), and `ScopeReadSubscribers` is in the `readOnlyScopes`
 * allowlist (apikeys/middleware.go:332-337), so `requireAdminRoleForScopes` is
 * false and any authenticated dashboard session clears both. The surface has no
 * writes at all, so viewer is the whole authorization story.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { LookalikeDetailSheet } from "@/components/lookalike/LookalikeDetailSheet";
import { LookalikeRow } from "@/components/lookalike/LookalikeRow";
import { useIsOnline } from "@/hooks/useIsOnline";
import {
  useLookalikeAudiences,
  useLookalikeMembers,
} from "@/hooks/useLookalikeAudiences";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useSegments } from "@/hooks/useSegments";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import {
  lookalikeFilterCounts,
  LOOKALIKE_FILTERS,
  LOOKALIKE_STALE_DAYS,
  matchesLookalikeFilter,
  matchesLookalikeQuery,
  orderLookalikes,
  type LookalikeFilter,
} from "@/lib/lookalikeHealth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary };

const FILTER_LABELS: Record<LookalikeFilter, string> = {
  all: "All",
  attention: "Needs a look",
  stale: "Stale",
};

const EMPTY_COPY: Record<
  LookalikeFilter,
  { title: string; description: string }
> = {
  all: {
    title: "No lookalike audiences yet",
    description:
      "A lookalike ranks non-seed subscribers by how closely they resemble a seed segment, on first-party signals only — email domain, signup source, engagement and retention. They are generated on desktop; once one exists, its size and its quality show up here.",
  },
  attention: {
    title: "Nothing needs a look",
    description:
      "Every saved model finished building, matched somebody, filled the size it was asked for, and is not mostly weak matches.",
  },
  stale: {
    title: "Nothing is stale",
    description: `Every model was built within the last ${LOOKALIKE_STALE_DAYS} days. A lookalike is a frozen snapshot — nothing re-runs it — so age is the one thing that quietly makes a good model wrong.`,
  },
};

export default function LookalikeAudiences() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  useScreenViewed("lookalike");

  const [filter, setFilter] = useState<LookalikeFilter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // Identities are requested only when a human asks, and the request is
  // forgotten when the sheet closes, so re-opening a model asks again rather
  // than silently re-displaying addresses fetched minutes ago.
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const audiences = useLookalikeAudiences();
  // The seed's NAME is not on the lookalike wire — only its uuid — so the
  // segments catalogue is joined client-side. It is the same cached query the
  // Segments screen uses, and a failure here degrades to "not resolved" rather
  // than to a guess.
  const segments = useSegments();
  const members = useLookalikeMembers(revealedId);
  const refresh = useRefreshControl(audiences);

  // "Built 3 weeks ago" and the stale threshold both age while the screen sits
  // open on a desk. Without a ticker they freeze at whatever they said on mount.
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  /**
   * BUCKETED TO THE MINUTE, for the reason `useDiscountsScreen` documents.
   * The only thing this screen shows the clock for is "built 3 weeks ago" and
   * the LOOKALIKE_STALE_DAYS threshold, neither of which can change more often
   * than once a minute. Feeding a raw 1 Hz tick into the filter/sort memo
   * below rebuilt the FlatList's `data` every second, and handing it to
   * `LookalikeRow` — which is `React.memo`'d — broke the memo on every visible
   * row, once a second, forever. The cost is that a model crossing the stale
   * threshold at 12:00:30 is labelled at 12:01:00.
   *
   * The bucket is the HOOK's now (it used to be `Math.floor(tick / 60_000)`
   * here), which additionally stops this screen re-rendering at all on the 59
   * ticks a minute that cannot change a character: 60 renders/min → 1.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  const all = useMemo(
    () => (Array.isArray(audiences.data) ? audiences.data : []),
    [audiences.data],
  );
  const counts = useMemo(() => lookalikeFilterCounts(all, now), [all, now]);

  const seedNames = useMemo(() => {
    const map = new Map<string, string>();
    // Array.isArray, not `?? []`: the nullish guard passes a truthy `{}` from a
    // restored persisted cache straight into the iteration below. See
    // lib/secureQueryPersister.ts, whose version field is the only thing that
    // busts a cache written by an older response shape.
    const segs = Array.isArray(segments.data) ? segments.data : [];
    for (const segment of segs) map.set(segment.id, segment.name);
    return map;
  }, [segments.data]);

  const seedNameFor = useCallback(
    (seedSegmentId: string): string | null =>
      seedNames.get(seedSegmentId) ?? null,
    [seedNames],
  );

  const rows = useMemo(
    () =>
      orderLookalikes(
        all.filter(
          (audience) =>
            matchesLookalikeFilter(audience, filter, now) &&
            matchesLookalikeQuery(
              audience,
              query,
              seedNames.get(audience.seedSegmentId) ?? null,
            ),
        ),
      ),
    [all, filter, now, query, seedNames],
  );

  const openAudience = useMemo(
    () => all.find((audience) => audience.id === openId) ?? null,
    [all, openId],
  );

  const closeSheet = useCallback(() => {
    setOpenId(null);
    setRevealedId(null);
  }, []);

  // Stable identities, so the bucketed clock above is not undone one prop
  // later: `LookalikeRow`'s memo compares every prop, and an inline `onPress`
  // (or an inline `renderItem` rebuilding one) fails that comparison on every
  // render regardless of what the clock says.
  const openAudienceRow = useCallback(
    (audience: { id: string }) => setOpenId(audience.id),
    [],
  );
  const renderAudience = useCallback(
    ({ item }: { item: (typeof all)[number] }) => (
      <LookalikeRow
        audience={item}
        onPress={openAudienceRow}
        seedName={seedNameFor(item.seedSegmentId)}
        now={now}
      />
    ),
    [openAudienceRow, seedNameFor, now],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Lookalike audiences"
        {...(audiences.data
          ? {
              subtitle: `${plural(all.length, "model")} · ${FILTER_LABELS[filter]}`,
            }
          : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
        <SegmentedControl
          accessibilityLabel="Model health"
          scrollable
          options={LOOKALIKE_FILTERS.map((value) => ({
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
          placeholder="Search models"
          accessibilityLabel="Search lookalike models by name or seed segment"
          resultCount={rows.length}
          resultNoun="model"
        />
      </View>

      <FlatList
        keyboardDismissMode="on-drag"
        data={audiences.data === undefined ? [] : rows}
        keyExtractor={(audience) => audience.id}
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
              Models are generated, discarded and routed to destinations on
              desktop. This screen exists to tell you whether one is worth using
              — open a model to see how similar its members really are.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={audiences}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so your lookalike models can't be loaded. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={4} />}
            empty={
              query.trim()
                ? {
                    title: "No match",
                    description:
                      "No model's name or seed segment contains that. Clear the search to see them all.",
                  }
                : EMPTY_COPY[filter]
            }
          >
            {null}
          </QueryStates>
        }
        renderItem={renderAudience}
      />

      <LookalikeDetailSheet
        audience={openAudience}
        seedName={
          openAudience ? seedNameFor(openAudience.seedSegmentId) : null
        }
        onClose={closeSheet}
        revealed={openId !== null && revealedId === openId}
        onReveal={() => setRevealedId(openId)}
        members={Array.isArray(members.data?.members) ? members.data?.members : []}
        membersQuery={members}
        piiIncluded={members.data?.piiIncluded ?? false}
        gate={gate}
        online={online}
      />
    </SafeAreaView>
  );
}
