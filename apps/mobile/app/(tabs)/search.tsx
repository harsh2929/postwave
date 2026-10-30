/**
 * Search — the mobile command palette.
 *
 * What changed and why:
 *
 *  - It is a LAUNCHER, not just an entity finder. Desktop's palette concatenates
 *    navigation targets, actions, entity hits and recents; mobile only ever
 *    asked the server about four entity types, while 22 secondary routes sat
 *    behind a scrolling More list. The "Go to" section closes that.
 *  - It joined the data layer. The old screen ran a raw useEffect + fetch with a
 *    hand-rolled race guard, outside `useOnlineQueryGate` — the one contract
 *    every other screen honours — so it fired on a cached-but-unvalidated
 *    session, cached nothing, retried nothing.
 *  - It stopped lying. A 500, an expired session or airplane mode all rendered
 *    as "No matches." — an authoritative claim that the workspace contains no
 *    such subscriber. Error, offline and empty are now three different screens.
 *  - It runs VERBS and reaches SECTIONS. "New campaign / form / list" open the
 *    target screen's own create sheet (`?new=1`), and every Settings section
 *    is a destination (`?anchor=`) — the two desktop palette sources mobile
 *    still lacked. Both live in lib/paletteCreateItems + paletteSettingsItems.
 *
 * NativeWind v4 gotcha: rows use STATIC style Pressables, never the
 * `({pressed}) => …` form, which silently drops layout.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Keyboard, SectionList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EVENTS } from "@postwave/telemetry";

import {
  fanOutSearch,
  groupSearchHits,
  searchHitRoute,
  searchHitTypeLabel,
  type MobileSearchHit,
} from "@/api/search";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useTour } from "@/components/tour/TourProvider";
import { PaletteRow, PaletteSectionHeader } from "@/components/PaletteRow";
import {
  SearchEmpty,
  SearchFooter,
  SearchTrouble,
} from "@/components/search/SearchStates";
import { useDebounced } from "@/hooks/useDebounced";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNavigateTo } from "@/hooks/useNavigateTo";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { usePaletteRecents } from "@/hooks/usePaletteRecents";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { haptics } from "@/lib/haptics";
import { MOBILE_SECTION_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import {
  buildPaletteItems,
  filterPaletteItems,
  paletteItemBadge,
  paletteItemTarget,
  type PaletteItem,
} from "@/lib/paletteItems";
import { MIN_QUERY } from "@/lib/searchScreenCopy";
import { SCREEN_SCROLL_PADDING_BOTTOM } from "@/lib/shellStyleTokens";
import { track } from "@/lib/telemetry";
import { confirmAndSignOut } from "@/lib/signOutFlow";
import { unregisterPushThenSignOut } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary: a surprising hit shape degrades search, not the app. */
export { AppErrorBoundary as ErrorBoundary };

type Row =
  | { kind: "palette"; item: PaletteItem }
  | { kind: "hit"; hit: MobileSearchHit };

export default function SearchScreen() {
  useScreenViewed("search");
  const { t, setPreference } = useTheme();
  const gate = useOnlineQueryGate();
  const navigateTo = useNavigateTo();
  const tour = useTour();
  const confirm = useConfirm();
  const { toast } = useToast();
  const mode = useAuthStore((s) => s.mode);
  const signOut = useAuthStore((s) => s.signOut);

  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const trimmed = dq.trim();
  // Per-identity recents: read on mount, re-read when the account changes,
  // written on every launch — hooks/usePaletteRecents.
  const { recentIds, remember } = usePaletteRecents(gate);

  // `online` is the same gate the create controls on the target screens read,
  // so a verb is offered exactly when its sheet would open with a live button.
  const catalogue = useMemo(
    () =>
      buildPaletteItems({
        role: gate.effectiveRole,
        mode,
        online: gate.enabled,
      }),
    [gate.effectiveRole, gate.enabled, mode],
  );
  const paletteMatches = useMemo(
    () => filterPaletteItems(catalogue, trimmed, { recentIds }),
    [catalogue, trimmed, recentIds],
  );

  const search = useQuery({
    queryKey: ["search", gate.tenantId, trimmed],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && trimmed.length >= MIN_QUERY,
    queryFn: () => fanOutSearch(trimmed),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  // Memoised: a fresh [] literal on every render would re-run the sections
  // useMemo on every keystroke even when nothing changed.
  const hits = useMemo(() => (Array.isArray(search.data?.hits) ? search.data?.hits : []), [search.data]);
  const searching = trimmed.length >= MIN_QUERY;

  // Pull-to-refresh through the shared hook. `enabled` mirrors `searching`
  // exactly — a refresh gesture on the local "Go to" list has nothing to
  // refetch — and the hook is what confirms completion physically, which
  // matters more here than anywhere: the whole reason to pull on this screen
  // is "did that subscriber land yet?", and the answer is often the same rows,
  // where a spinner that retracts in 80ms is the only thing that ever happened.
  const refetchSearch = search.refetch;
  const refresh = useManualRefresh([refetchSearch], { enabled: searching });

  const runAction = useCallback(
    (item: PaletteItem) => {
      switch (item.actionKey) {
        case "theme-system":
        case "theme-light":
        case "theme-dark": {
          const next = item.actionKey.replace("theme-", "") as
            | "system"
            | "light"
            | "dark";
          setPreference(next);
          toast({ kind: "success", message: `Theme set to ${next}.` });
          return;
        }
        case "replay-tour":
          router.push("/(tabs)/dashboard");
          setTimeout(() => tour.start(), 450);
          return;
        case "sign-out":
          void confirmAndSignOut({
            mode,
            confirm,
            performSignOut: () => unregisterPushThenSignOut(signOut),
            navigateToSignIn: () => router.replace("/(auth)/sign-in"),
          }).then((outcome) => {
            if (outcome === "signed-out-degraded") {
              toast({
                kind: "warning",
                message:
                  "Signed out on this device, but the server couldn't be reached to revoke it. It will retry.",
              });
            }
          });
          return;
        default:
          return;
      }
    },
    [confirm, mode, setPreference, signOut, toast, tour],
  );

  const openPaletteItem = useCallback(
    (item: PaletteItem) => {
      haptics.tap();
      remember(item.id);
      // navigateTo, not router.push: a creation verb and a Settings section
      // carry params, and {pathname, params} is the one href shape that keeps
      // them — `router.push(route)` would drop the flag and land on the bare
      // list, which reads as the verb having done nothing.
      const target = paletteItemTarget(item);
      if (target) navigateTo(target);
      else runAction(item);
    },
    [navigateTo, remember, runAction],
  );

  // One event per settled query. Structural only: the query's LENGTH, the
  // result count and whether a source failed — never the text, which on a
  // search box is customer content by definition. Without this nobody could
  // tell whether the palette is used at all or which queries return nothing.
  const settledAt = search.dataUpdatedAt;
  useEffect(() => {
    if (!searching || !search.isSuccess) return;
    track(EVENTS.MOBILE_SEARCH_PERFORMED, {
      query_length: trimmed.length,
      result_count: hits.length,
      outcome: search.data?.partial ? "partial" : "success",
    });
    // Keyed on the settle timestamp so a re-render never re-emits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledAt]);

  const openHit = useCallback(
    (hit: MobileSearchHit) => {
      haptics.tap();
      track(EVENTS.MOBILE_SEARCH_PERFORMED, {
        outcome: "opened",
        hit_type: hit.type,
      });
      // navigateTo, not router.push: opening the same hit twice (or a second
      // list hit that lands on the same screen with a different filter) used to
      // stack another identical copy of it.
      navigateTo(searchHitRoute(hit));
    },
    [navigateTo],
  );

  const sections = useMemo(() => {
    const out: { title: string; data: Row[] }[] = [];
    if (paletteMatches.length) {
      out.push({
        title: trimmed ? "Go to" : "Jump back in",
        data: paletteMatches.map((item) => ({ kind: "palette", item }) as Row),
      });
    }
    for (const group of groupSearchHits(hits)) {
      out.push({
        title: group.title,
        data: group.data.map((hit) => ({ kind: "hit", hit }) as Row),
      });
    }
    return out;
  }, [paletteMatches, hits, trimmed]);

  const resultCount = paletteMatches.length + hits.length;

  // useCallback so a keystroke in the search field does not hand the
  // SectionList a fresh renderItem identity and re-render every mounted row
  // (LOVE#39). Deps are exactly the two navigation callbacks it closes over,
  // both of which are themselves memoised.
  const renderRow = useCallback(
    ({ item: row }: { item: Row }) =>
      row.kind === "palette" ? (
        <PaletteRow
          title={row.item.title}
          subtitle={row.item.subtitle}
          icon={row.item.icon}
          badge={paletteItemBadge(row.item)}
          onPress={() => openPaletteItem(row.item)}
        />
      ) : (
        <PaletteRow
          title={row.hit.title}
          subtitle={row.hit.detail}
          icon="search"
          badge={searchHitTypeLabel(row.hit.type)}
          onPress={() => openHit(row.hit)}
        />
      ),
    [openHit, openPaletteItem],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Search" onBack={goBackOrMore} />
      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Screens, settings, subscribers, campaigns…"
          accessibilityLabel="Search Moosewave"
          autoFocus
          resultCount={q.trim() ? resultCount : undefined}
          resultNoun="match"
          resultNounPlural="matches"
          // The keyboard's Search key was decorative: results are live, so
          // there is nothing to submit — but the keyboard covers half the
          // viewport, and dropping it is exactly what the key should mean here.
          onSubmit={() => Keyboard.dismiss()}
        />
      </View>

      <SectionList
        {...MOBILE_SECTION_LIST_PERF_PROPS}
        sections={sections}
        keyExtractor={(row) =>
          row.kind === "palette" ? row.item.id : `${row.hit.type}:${row.hit.id}`
        }
        keyboardShouldPersistTaps="handled"
        // Drag-to-dismiss: without it a short result list leaves the keyboard
        // occupying half the screen with no one-handed way to close it.
        keyboardDismissMode="on-drag"
        // Pull-to-refresh, but ONLY while a server query is live. Results are
        // cached for a minute, so "did that subscriber land yet?" otherwise
        // meant retyping the query. Offered at all only when there is
        // something to refetch — a refresh gesture on the local "Go to" list
        // would spin against nothing.
        {...(searching
          ? { refreshing: refresh.refreshing, onRefresh: refresh.onRefresh }
          : {})}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: SCREEN_SCROLL_PADDING_BOTTOM,
        }}
        renderSectionHeader={({ section }) => (
          <PaletteSectionHeader title={section.title} />
        )}
        renderItem={renderRow}
        // The trouble notice CANNOT live in ListEmptyComponent alone. The "Go
        // to" section is local and matches on almost any word, so a query like
        // "camp" leaves `sections` non-empty — and a SectionList never renders
        // its empty component then. A 500 from the server search therefore
        // rendered as a short, confident list of screens with no hint that the
        // subscriber/campaign half of the answer had failed, which is the same
        // lie as "No matches." with extra steps.
        ListHeaderComponent={
          sections.length > 0 ? (
            <SearchTrouble
              gateEnabled={gate.enabled}
              searching={searching}
              isError={search.isError}
              error={search.error}
              onRetry={() => void search.refetch()}
            />
          ) : null
        }
        ListEmptyComponent={
          <SearchEmpty
            gateEnabled={gate.enabled}
            searching={searching}
            isError={search.isError}
            error={search.error}
            isLoading={search.isLoading}
            onRetry={() => void search.refetch()}
          />
        }
        ListFooterComponent={
          <SearchFooter
            partial={Boolean(search.data?.partial)}
            truncated={Boolean(search.data?.truncated)}
            visible={searching && hits.length > 0}
          />
        }
      />
    </SafeAreaView>
  );
}
