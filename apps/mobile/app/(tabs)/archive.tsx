/**
 * Archive — the published-issue index.
 *
 * What changed, and why:
 *
 *  - SEARCH REACHES THE SERVER. The screen fetched ONE 50-row page, threw away
 *    `nextCursor`, and filtered that page in memory. A five-year weekly
 *    newsletter has ~260 issues, so searching for anything from year one
 *    produced an authoritative "Nothing matches" — while the backend had
 *    supported `q` all along (archive.go AdminList → listsearch.ReadQuery, with
 *    a real `subject ILIKE … OR archive_slug ILIKE …` filter). The list is an
 *    infinite query now, keyed on the debounced query, and it pages.
 *  - "NOTHING PUBLISHED YET" NO LONGER MEANS "YOU'RE OFFLINE". Those are
 *    different sentences and the five-state ladder tells them apart.
 *  - THE WIRE IS TYPED. `pinned`, `viewCount` and `uniqueVisitors` all ship on
 *    archive.IssueSummary and were read through a local `as` widening; they are
 *    first-class on ArchiveIssue now.
 *  - LINKS ARE REAL. Public URLs come from the archive tenant-settings endpoint
 *    (the resolver matches `tenant_archive_slug` / a verified vanity domain, NOT
 *    the auth workspace slug this screen used to build links from), and every
 *    affordance refuses rather than emitting a plausible-looking 404.
 *  - THE ISSUE OPENS INSIDE THE APP. Tapping a row reads the workspace's own
 *    copy through GET /api/v1/admin/archive/issues/{slug}/preview, which needs
 *    no public routing at all; "Open ↗" still goes to the published page but
 *    through `expo-web-browser`, so returning is a dismiss instead of an app
 *    switch that cold-starts the index and loses the search you typed.
 *  - THE WRONG LINK CAN BE PULLED. "Unpublish" was web-admin-only, which is
 *    backwards: publishing an issue is desk work, retracting one is a phone
 *    emergency. It is a swipe action (and a VoiceOver rotor action), gated to
 *    owner/admin exactly like POST /campaigns/{id}/unpublish-archive.
 */
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Share,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { ArchiveIssuePreviewSheet } from "@/components/archive/ArchiveIssuePreviewSheet";
import { ArchiveIssueRow } from "@/components/archive/ArchiveIssueRow";
import { PrivateFeedGateRow } from "@/components/archive/PrivateFeedGateRow";
import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useDebounced } from "@/hooks/useDebounced";
import { useArchiveRowActions } from "@/hooks/useArchiveRowActions";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useFirstPageRefresh } from "@/hooks/useFirstPageRefresh";
import { archiveIssuesQueryRootKey } from "@/lib/detailSeedKeys";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  ARCHIVE_SEARCH_MIN,
  useArchiveIssues,
  useArchiveStats,
  useArchiveTenantSettings,
  type ArchiveIssue,
} from "@/hooks/useArchiveOps";
import {
  archiveFeedURL,
  archiveIssueURL,
  archiveLinkBlockedReason,
} from "@/lib/archiveLinks";
import { FONT } from "@/lib/fonts";
import { num, plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary: one malformed issue degrades the archive, not the app. */
export { AppErrorBoundary as ErrorBoundary };

type ArchiveListItem =
  | { kind: "header"; key: string; title: string; spaced: boolean }
  | { kind: "row"; key: string; row: ArchiveIssue };

export default function Archive() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const now = useNowTicker();
  const { toast } = useToast();
  useScreenViewed("archive");

  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 250);
  /** The row whose in-app preview is open; null means the sheet is closed. */
  const [previewing, setPreviewing] = useState<ArchiveIssue | null>(null);

  const issues = useArchiveIssues(debouncedQ);
  const stats = useArchiveStats();
  const settings = useArchiveTenantSettings();
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const mode = useAuthStore((s) => s.mode);
  const session = useAuthStore((s) => s.session);
  // Mirrors `apikeys.RequireScope(apikeys.ScopeAdmin)` on
  // POST /api/v1/campaigns/{id}/unpublish-archive: on the session path that
  // middleware demands owner/admin (apikeys/middleware.go:211), and an API-key
  // session carries no role claim at all, so it never qualifies.
  const canUnpublish = canAccessMinimumRole(
    "admin",
    session?.effectiveRole ?? session?.role ?? null,
    mode,
  );
  // Bounded to one page request (see useFirstPageRefresh). The search term is
  // in the query key and the only client-side pass is a pinned/rest partition,
  // which hides no rows, so page one is the whole answer.
  const refreshIssues = useFirstPageRefresh(
    archiveIssuesQueryRootKey(gate.tenantId),
    issues.refetch,
  );
  const refresh = useManualRefresh([refreshIssues, stats.refetch]);

  // Memoised: the object literal is a new identity every render, which would
  // invalidate every link callback below on each keystroke.
  const identity = useMemo(
    () =>
      settings.data
        ? {
            archiveDomain: settings.data.archiveDomain,
            tenantArchiveSlug: settings.data.tenantArchiveSlug,
          }
        : null,
    [settings.data],
  );
  // One sentence, shared by every affordance, explaining why links are off.
  const blockedReason = archiveLinkBlockedReason(identity, {
    loaded: settings.isSuccess,
    // The tenant-settings read is admin-scoped, so a viewer gets a 403 that
    // never resolves — "Checking…" would be permanent.
    failed: settings.isError,
  });

  const firstPage = issues.data?.pages?.[0];
  // `?? []` is a NULLISH guard and catches neither `{}` nor a page whose
  // `items` key is absent — and the pages here can come from the offline
  // vault, which stores whatever an earlier build wrote and validates only
  // that the envelope carries a numeric `capturedAt`. Without Array.isArray a
  // restored snapshot of the wrong shape reaches `flatMap` (or leaves an
  // `undefined` row for `ArchiveIssueRow` to read `subject` off) and takes the
  // whole route down. The hook re-parses too; this is the consumer-side half.
  const rows: ArchiveIssue[] = useMemo(() => {
    const pages = issues.data?.pages;
    if (!Array.isArray(pages)) return [];
    return pages.flatMap((page) =>
      Array.isArray(page?.items) ? page.items : [],
    );
  }, [issues.data]);
  const searching = debouncedQ.trim().length >= ARCHIVE_SEARCH_MIN;

  const items = useMemo<ArchiveListItem[]>(() => {
    const pinned = rows.filter((row) => row.pinned);
    const rest = rows.filter((row) => !row.pinned);
    const out: ArchiveListItem[] = [];
    if (pinned.length > 0) {
      out.push({ kind: "header", key: "h-pinned", title: "Pinned", spaced: false });
      out.push(
        ...pinned.map((row) => ({
          kind: "row" as const,
          key: `p-${row.slug}`,
          row,
        })),
      );
      if (rest.length > 0) {
        out.push({ kind: "header", key: "h-recent", title: "Recent", spaced: true });
      }
    }
    out.push(
      ...rest.map((row) => ({ kind: "row" as const, key: `r-${row.slug}`, row })),
    );
    return out;
  }, [rows]);

  const publicUrlFor = useCallback(
    (row: ArchiveIssue) => archiveIssueURL(identity, row.slug),
    [identity],
  );

  /**
   * The published page, in the IN-APP browser. `Linking.openURL` handed the
   * user to Safari — coming back is an app switch that cold-starts the app on
   * the archive list with the scroll position and the typed query both gone.
   * `openBrowserAsync` presents SFSafariViewController / a Custom Tab over the
   * screen, so "back" is a dismiss and the list is exactly where it was.
   */
  const openPublicUrl = useCallback(
    (url: string) => {
      void WebBrowser.openBrowserAsync(url, {
        // Match the surface it is launched from rather than flashing white.
        toolbarColor: t.surface,
        controlsColor: t.accent,
        enableBarCollapsing: true,
      }).catch((e: unknown) => {
        Alert.alert(
          "Couldn't open",
          e instanceof Error ? e.message : "No app available to open this URL.",
        );
      });
    },
    [t.accent, t.surface],
  );

  const onOpen = useCallback(
    (row: ArchiveIssue) => {
      const url = publicUrlFor(row);
      if (!url) {
        toast({
          kind: "error",
          message: blockedReason ?? "The archive URL failed safety checks.",
        });
        return;
      }
      openPublicUrl(url);
    },
    [blockedReason, openPublicUrl, publicUrlFor, toast],
  );

  // Both row verbs live in useArchiveRowActions — see that file for why
  // unpublish confirms and pin does not.
  const { onUnpublish, onTogglePin } = useArchiveRowActions({
    onUnpublished: (slug) =>
      setPreviewing((current) => (current?.slug === slug ? null : current)),
  });

  const onShare = useCallback(
    (row: ArchiveIssue) => {
      const url = publicUrlFor(row);
      if (!url) {
        toast({
          kind: "error",
          message: blockedReason ?? "The archive URL failed safety checks.",
        });
        return;
      }
      const title = row.subject || row.slug;
      haptics.tap();
      void Share.share(
        { message: url, title },
        { dialogTitle: `Share "${title}"` },
      ).catch((e: unknown) => {
        Alert.alert("Share failed", e instanceof Error ? e.message : String(e));
      });
    },
    [blockedReason, publicUrlFor, toast],
  );

  const onShareFeed = useCallback(() => {
    const url = baseUrl ? archiveFeedURL(baseUrl, identity) : null;
    if (!url) {
      toast({
        kind: "error",
        message:
          blockedReason ?? "No API base URL is configured for this account.",
      });
      return;
    }
    haptics.tap();
    void Share.share(
      { message: url, title: "Newsletter archive feed" },
      { dialogTitle: "Share RSS feed" },
    ).catch((e: unknown) => {
      Alert.alert("Share failed", e instanceof Error ? e.message : String(e));
    });
  }, [baseUrl, blockedReason, identity, toast]);

  // Rendered per row; `useCallback` keeps FlatList from re-rendering every
  // visible card on each keystroke (the old inline closure re-created itself
  // whenever the query string changed).
  const renderItem = useCallback(
    ({ item }: { item: ArchiveListItem }) => {
      if (item.kind === "header") {
        return (
          <Text
            accessibilityRole="header"
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.bold,
              ...typeStyle("caption"),
              textTransform: "uppercase",
              letterSpacing: 0.6,
              marginTop: item.spaced ? 8 : 0,
              marginBottom: 8,
            }}
          >
            {item.title}
          </Text>
        );
      }
      return (
        <View style={{ marginBottom: 8 }}>
          <ArchiveIssueRow
            row={item.row}
            onPreview={setPreviewing}
            onOpenPublic={onOpen}
            onShare={onShare}
            onUnpublish={canUnpublish ? (row) => void onUnpublish(row) : null}
            onTogglePin={canUnpublish ? (row) => void onTogglePin(row) : null}
          />
        </View>
      );
    },
    [canUnpublish, onOpen, onShare, onTogglePin, onUnpublish, t],
  );

  const statsLine = stats.data
    ? `${plural(stats.data.issues, "issue")} · ${num(stats.data.views)} views · ${num(stats.data.uniqueVisitors)} unique`
    : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Archive"
        subtitle={statsLine}
        onBack={goBackOrMore}
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search every published issue…"
          accessibilityLabel="Search the archive by subject"
          resultCount={rows.length}
          resultNoun="issue"
        />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 8,
            gap: 8,
          }}
        >
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("numeric"),
              flexShrink: 1,
            }}
            numberOfLines={1}
            // The count changes when a search narrows the archive or another
            // page lands. Announcing it is the only confirmation a VoiceOver
            // user gets that typing did anything at all.
            accessibilityLiveRegion="polite"
          >
            {/* The count is of what has been PAGED IN, so it must not read as a
                total when more pages exist — "50 issues" beside a list that
                keeps growing is a lie the old screen told on every scroll. */}
            {rows.length === 0
              ? ""
              : `${plural(rows.length, "issue")}${issues.hasNextPage ? "+" : ""}${searching ? " matched" : ""}`}
          </Text>
          <Pressable
            onPress={onShareFeed}
            hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Share newsletter RSS feed"
            style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                fontFamily: FONT.semibold,
                ...typeStyle("control"),
              }}
            >
              RSS feed {"\u2934\uFE0E"}
            </Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        // Without this the search keyboard covers half the results and the
        // only way to see more is to tap one or leave the screen.
        keyboardDismissMode="on-drag"
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (issues.hasNextPage && !issues.isFetchingNextPage) {
            void issues.fetchNextPage();
          }
        }}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
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
        ListHeaderComponent={
          <>
            <CachedNotice backing={firstPage} now={now} />
            {/* Private subscriber feeds are held back platform-wide; the row
                states that rather than leaving the control merely absent. */}
            <PrivateFeedGateRow canAdmin={canUnpublish} />
          </>
        }
        ListFooterComponent={
          issues.isFetchingNextPage ? (
            <View
              accessible
              accessibilityLabel="Loading more issues"
              style={{ paddingVertical: 16, alignItems: "center" }}
            >
              <ActivityIndicator size="small" color={t.fgMuted} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={issues}
            gate={gate}
            isEmpty
            skeleton={<SkeletonList rows={5} />}
            offlineMessage="You're offline and no copy of your archive has been saved yet. It'll load when you reconnect."
            empty={{
              title: searching ? "Nothing matches" : "Nothing published yet",
              description: searching
                ? `Search covers every published issue, not just this page — nothing matches "${debouncedQ.trim()}".`
                : "Publish a campaign to the archive from the web admin to make past issues browsable.",
            }}
          >
            {null}
          </QueryStates>
        }
      />

      <ArchiveIssuePreviewSheet
        slug={previewing?.slug ?? null}
        fallbackTitle={previewing?.subject ?? ""}
        onClose={() => setPreviewing(null)}
        onOpenPublic={
          previewing && publicUrlFor(previewing)
            ? () => {
                const url = publicUrlFor(previewing);
                if (url) openPublicUrl(url);
              }
            : null
        }
        openPublicBlockedReason={
          previewing && !publicUrlFor(previewing)
            ? (blockedReason ?? "The archive URL failed safety checks.")
            : null
        }
      />
    </SafeAreaView>
  );
}
