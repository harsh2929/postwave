/**
 * Landing pages — which hosted pages exist, which are LIVE, and who they have
 * captured.
 *
 * A complete subsystem shipped server-side (`apps/api/internal/landingpages`:
 * model, RLS-scoped repo, six routes mounted at
 * `internal/server/analytics_realtime_routes.go:66-74`, plus the public capture
 * path in `internal/compat`) with a full web editor and ZERO mobile references.
 * The read model is the whole of the phone job: a page is authored at a desk,
 * but "is the launch page actually live" and "has anyone signed up yet" are
 * ten-second questions asked away from one.
 *
 * WHAT THIS SCREEN WILL NOT DO, and why each is a decision rather than a gap:
 *
 *  - NO PER-ROW LEAD COUNT. There is no cross-page rollup anywhere in the API;
 *    leads come from `GET /{id}/leads`, one page at a time, up to 5000 rows a
 *    call. Fetching that for every row would be an N+1 of unbounded payloads
 *    from a phone, and the `metrics` column that looks like it holds a count is
 *    written by nothing in the repository — rendering its empty `{}` as "0
 *    leads" would put a manufactured zero on every row. The count appears when
 *    you open a page, from the one request that can answer it.
 *  - EDITING STAYS IN THE BLOCK EDITOR. Since the desktop-parity pass, ADMIN
 *    sessions CAN publish/unpublish/restore, archive (the server's DELETE is
 *    a soft `status='archived'`), and create a draft shell from here — every
 *    one an online-only ScopeAdmin write with a confirm. What stays desk-side
 *    is authoring `blocks`/`seo`/`tracking`: whole-JSON-document work.
 *  - NO CSV EXPORT. `/{id}/leads.csv` answers `Content-Disposition:
 *    attachment`; this app has no file-share sheet (no expo-sharing /
 *    expo-file-system dependency), so the sheet says so in words rather than
 *    offering a button that cannot finish.
 *
 * ROLE. The four reads are mounted behind
 * `apikeys.RequireScope(ScopeReadCampaigns)`, and `read:campaigns` is in
 * `readOnlyScopes` (apikeys/middleware.go:334), so `RequireScope` runs NO role
 * check on the session path: every authenticated dashboard user, viewer
 * included, may read this. Hence no `minimumRole` on the route row — read the
 * handler and its middleware, never the manifest's auto-generated rows.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { LandingPageCreateSheet } from "@/components/landing-pages/LandingPageCreateSheet";
import { LandingPageDetailSheet } from "@/components/landing-pages/LandingPageDetailSheet";
import { LandingPageRow } from "@/components/landing-pages/LandingPageRow";
import { LANDING_WRITE_MINIMUM_ROLE } from "@/lib/landingLifecycle";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";
import { useLandingLeads, useLandingPages } from "@/hooks/useLandingPages";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { PUBLIC_APP_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  filterLandingPages,
  landingStatusCounts,
  LANDING_STATUS_FILTERS,
  orderLandingPages,
  publicLandingUrl,
  type LandingStatusFilter,
  type MobileLandingPage,
} from "@/lib/landingPages";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary };

const FILTER_LABELS: Record<LandingStatusFilter, string> = {
  all: "All",
  published: "Live",
  draft: "Drafts",
  archived: "Archived",
};

const EMPTY_COPY: Record<
  LandingStatusFilter,
  { title: string; description: string }
> = {
  all: {
    title: "No landing pages yet",
    description:
      "A landing page is a hosted signup page you can point an ad or a campaign at. They're built in the block editor on the web app; once one exists, its public link and every lead it captures show up here.",
  },
  published: {
    title: "Nothing is live",
    description:
      "No page is published, so none of them is being served. A draft's public URL returns Not Found until someone publishes it.",
  },
  draft: {
    title: "No drafts",
    description:
      "Every page in this workspace is either live or archived.",
  },
  archived: {
    title: "Nothing archived",
    description:
      "Archiving retires a page and stops it being served, without deleting the leads it already captured.",
  },
};

export default function LandingPages() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  useScreenViewed("landing-pages");

  const [filter, setFilter] = useState<LandingStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Every landing write is ScopeAdmin; API-key sessions fail closed.
  const mode = useAuthStore((s) => s.mode);
  const canWrite =
    canAccessMinimumRole(
      LANDING_WRITE_MINIMUM_ROLE,
      gate.effectiveRole,
      mode,
    ) && gate.enabled;

  const pages = useLandingPages();
  const leads = useLandingLeads(openId);
  const refresh = useRefreshControl(pages, leads);

  // "2d ago" ages while the screen sits open on a desk; without a ticker it
  // freezes at whatever it said on mount.
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

  /**
   * Coerced to an array rather than trusted. `?? []` is a NULLISH guard and
   * passes a truthy `{}` or `{items: []}` straight through; this app rehydrates
   * its query cache from disk (lib/secureQueryPersister), so a cache entry
   * written by an older build's response shape can reach this line after an app
   * update. `landingStatusCounts` iterates with for-of, so such a value throws
   * inside render and the error boundary replaces the screen with a blank.
   */
  const all = useMemo(
    () => (Array.isArray(pages.data) ? pages.data : []),
    [pages.data],
  );
  const counts = useMemo(() => landingStatusCounts(all), [all]);
  const rows = useMemo(
    () => orderLandingPages(filterLandingPages(all, { q: query, status: filter })),
    [all, query, filter],
  );

  const openPage = useMemo(
    () => all.find((page) => page.id === openId) ?? null,
    [all, openId],
  );

  // Built from the app origin exactly as apps/web builds it, and null for any
  // page that is not published — Moosewave serves published rows only, so a
  // draft's link would be a 404 handed out as if it worked.
  const publicUrl = useMemo(
    () => (openPage ? publicLandingUrl(PUBLIC_APP_BASE_URL, openPage) : null),
    [openPage],
  );

  const copyUrl = useCallback(
    (url: string) => {
      Clipboard.setStringAsync(url)
        .then(() => {
          haptics.success();
          toast({ kind: "success", message: "Public link copied" });
        })
        .catch(() => {
          haptics.error();
          toast({
            kind: "error",
            message: "Couldn't reach the clipboard. Long-press the link to select it instead.",
          });
        });
    },
    [toast],
  );

  // `onPress` is hoisted out of the row, not just out of the FlatList:
  // `LandingPageRow` is `React.memo`'d, and an arrow rebuilt inside
  // `renderItem` is a changed prop on every cell render, so the memo could
  // never hold. Same shape the lookalike list was fixed for.
  const openRow = useCallback(
    (page: MobileLandingPage) => setOpenId(page.id),
    [],
  );
  const renderItem = useCallback(
    ({ item }: { item: MobileLandingPage }) => (
      <LandingPageRow page={item} now={now} onPress={openRow} />
    ),
    [now, openRow],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Landing pages"
        {...(pages.data
          ? {
              subtitle: `${plural(all.length, "page")} · ${plural(
                counts.published,
                "live",
                "live",
              )}`,
            }
          : {})}
        onBack={goBackOrMore}
        right={
          canWrite ? (
            <Pressable
              onPress={() => {
                haptics.tap();
                setCreateOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Create a new landing page"
              style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accent,
                  ...typeStyle("callout"),
                  fontFamily: FONT.semibold,
                }}
              >
                New
              </Text>
            </Pressable>
          ) : undefined
        }
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
        <SegmentedControl
          accessibilityLabel="Landing page status"
          scrollable
          options={LANDING_STATUS_FILTERS.map((value) => ({
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
          placeholder="Search pages"
          accessibilityLabel="Search landing pages by name or slug"
          resultCount={rows.length}
          resultNoun="page"
        />
      </View>

      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={pages.data === undefined ? [] : rows}
        keyExtractor={(page) => page.id}
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
              Most recently edited first. Lead counts are per page — the API has
              no rollup across pages, so open one to see how many it captured.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={pages}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline and no landing pages have been cached yet. They'll load when you reconnect."
            skeleton={<SkeletonList rows={4} />}
            empty={
              query.trim()
                ? {
                    title: "No match",
                    description:
                      "No page's name or slug contains that. Clear the search to see them all.",
                  }
                : EMPTY_COPY[filter]
            }
          >
            {null}
          </QueryStates>
        }
        renderItem={renderItem}
      />

      {/* `leads` gets the same coercion as the list above: the sheet `.map`s it,
          and a rehydrated non-array would throw inside render. */}
      <LandingPageDetailSheet
        page={openPage}
        leads={Array.isArray(leads.data) ? leads.data : []}
        leadsQuery={leads}
        gate={gate}
        now={now}
        onClose={() => setOpenId(null)}
        publicUrl={publicUrl}
        onCopyUrl={copyUrl}
        canWrite={canWrite}
      />
      <LandingPageCreateSheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </SafeAreaView>
  );
}
