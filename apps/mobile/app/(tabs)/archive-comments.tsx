/**
 * Archive comments — the moderation queue for reader comments on published
 * issues. (DELIVERABILITY#14.)
 *
 * WHY THIS IS A PHONE SURFACE AND THE REST OF ARCHIVE IS NOT
 *
 * A full threaded-comments subsystem shipped server-side
 * (`apps/api/internal/archive_comments`, public post + vote + admin
 * moderation) with zero mobile references, and desktop's own card names Ghost,
 * Buttondown and Substack as the precedent. Triaging short user-generated text
 * — read it, decide, next — is the canonical phone interaction. Writing the
 * issue it sits under is not, and is not here.
 *
 * THE SERVER FACT THAT DECIDES THE WHOLE SCREEN
 *
 * `PublicPost` inserts with status "visible" (archive_comments.go:763). There
 * is no per-tenant "require moderation" flag yet — the package header says so
 * itself. So NOTHING accumulates in Pending, and a queue that opened on Pending
 * would show a reassuring empty screen while spam sat live on a public page.
 * This screen therefore opens on LIVE and says, in the header, that comments
 * publish themselves. The job on a phone is not "approve the backlog", it is
 * "something is already public — take it down".
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   - Replying as the workspace: the admin API has no reply verb at all
 *     (MountAdminRoutes registers a list, moderate, pin, unpin, delete).
 *   - Per-issue filtering: `?campaignId=` exists, but choosing among hundreds
 *     of issues is a picker problem, and the queue is capped at 200 rows of
 *     the newest comments anyway — which is the slice a phone wants.
 *   - The thread: the moderation projection returns a FLAT list with
 *     `Children` empty, so no honest thread view can be built from it.
 *
 * ROLE. The whole surface — read included — is mounted behind
 * `apikeys.RequireScope(apikeys.ScopeAdmin)` (main.go:2924-2927). On the
 * session path that scope is not in `readOnlyScopes`, so
 * `apikeys.sessionRoleAllowsScopes` admits owner|admin only. A viewer is told
 * that, rather than shown an empty queue that is really a 403.
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
import { ArchiveCommentRow } from "@/components/archive/ArchiveCommentRow";
import { ArchiveCommentSheet } from "@/components/archive/ArchiveCommentSheet";
import { useConfirm } from "@/components/ConfirmSheet";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { SwipeableRow } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import {
  useArchiveCommentQueue,
  useArchiveIssueTitles,
  useDeleteArchiveComment,
  useModerateArchiveComment,
  usePinArchiveComment,
} from "@/hooks/useArchiveComments";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import {
  ARCHIVE_COMMENT_FILTERS,
  ARCHIVE_COMMENT_FILTER_LABELS,
  LIVE_TAB_NOTE,
  moderationCopy,
  moderationFailureMessage,
  moderationSuccessMessage,
  orderForFilter,
  statusForAction,
  truncationNotice,
  type ArchiveCommentAction,
  type ArchiveCommentFilter,
  type MobileArchiveComment,
} from "@/lib/archiveCommentQueue";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

export default function ArchiveComments() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("archive-comments");

  const mode = useAuthStore((s) => s.mode);
  const canModerate = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const [filter, setFilter] = useState<ArchiveCommentFilter>("visible");
  const [openId, setOpenId] = useState<string | null>(null);

  const queue = useArchiveCommentQueue(filter);
  const { titles, hasIndex } = useArchiveIssueTitles();
  const moderate = useModerateArchiveComment();
  const pin = usePinArchiveComment();
  const remove = useDeleteArchiveComment();
  const refresh = useRefreshControl(queue);
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * relativeTime ("3h ago"), nothing finer, so 59 of every 60 ticks used to
   * re-render the whole screen — and every row that takes `now` as a prop —
   * to repaint an identical string. Measured: 60 renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  const busy = moderate.isPending || pin.isPending || remove.isPending;
  const page = queue.data ?? null;
  const rows = useMemo(
    () => orderForFilter(page?.items ?? [], filter),
    [page, filter],
  );
  const openComment = useMemo(
    () => rows.find((row) => row.id === openId) ?? null,
    [rows, openId],
  );
  const truncated = page ? truncationNotice(page) : null;

  const act = useCallback(
    async (comment: MobileArchiveComment, action: ArchiveCommentAction) => {
      if (busy) return;
      const copy = moderationCopy(action, comment);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        ...(copy.consequence ? { consequence: copy.consequence } : {}),
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
      });
      if (!ok) return;
      // Acknowledge the press; the success thump waits for the server, so a
      // failing network never feels like a success followed by an error.
      haptics.impact();
      try {
        const status = statusForAction(action);
        if (status) {
          await moderate.mutateAsync({ id: comment.id, status });
        } else if (action === "delete") {
          await remove.mutateAsync({ id: comment.id });
        } else {
          await pin.mutateAsync({ id: comment.id, pinned: action === "pin" });
        }
        haptics.success();
        toast({
          kind: "success",
          message: moderationSuccessMessage(action, comment),
        });
        setOpenId(null);
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: `${copy.confirmLabel} failed. ${moderationFailureMessage(statusOf(error))}`,
        });
      }
    },
    [busy, confirm, moderate, pin, remove, toast],
  );

  /**
   * Hoisted out of the FlatList, and `onPress` hoisted out of the ROW.
   * `ArchiveCommentRow` is `React.memo`'d, and an arrow rebuilt inside
   * `renderItem` is a changed prop on every cell, so the memo could never hold
   * — every visible comment re-rendered on every re-render of this screen,
   * including each moderation mutation settling its pending flag.
   *
   * The swipe wrapper's `right` array stays inline: `SwipeableRow` is not
   * memoised and the actions genuinely differ per row, so hoisting it would
   * buy nothing and cost the per-row identity the actions need.
   */
  const openRow = useCallback(
    (comment: MobileArchiveComment) => setOpenId(comment.id),
    [],
  );
  const closeSheet = useCallback(() => setOpenId(null), []);
  const renderComment = useCallback<ListRenderItem<MobileArchiveComment>>(
    ({ item }) => {
      const row = (
        <ArchiveCommentRow
          comment={item}
          onPress={openRow}
          titles={titles}
          busy={busy}
          now={now}
        />
      );
      if (!canModerate || !online) return row;
      return (
        <SwipeableRow
          accessibilityLabel={`Comment from ${item.displayName || "Unnamed"}`}
          right={
            item.status === "visible"
              ? [
                  {
                    label: "Hide",
                    kind: "neutral" as const,
                    onPress: () => void act(item, "hide"),
                  },
                  {
                    label: "Spam",
                    kind: "danger" as const,
                    onPress: () => void act(item, "spam"),
                  },
                ]
              : [
                  {
                    label: "Restore",
                    kind: "success" as const,
                    onPress: () => void act(item, "restore"),
                  },
                ]
          }
        >
          {row}
        </SwipeableRow>
      );
    },
    [act, busy, canModerate, now, online, openRow, titles],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Comments"
        {...(page
          ? {
              subtitle: `${plural(page.total ?? rows.length, "comment")} · ${ARCHIVE_COMMENT_FILTER_LABELS[filter]}`,
            }
          : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <SegmentedControl
          accessibilityLabel="Comment status"
          options={ARCHIVE_COMMENT_FILTERS.map((value) => ({
            value,
            label: ARCHIVE_COMMENT_FILTER_LABELS[value],
          }))}
          value={filter}
          onChange={setFilter}
        />
      </View>

      <FlatList
        data={page === null ? [] : rows}
        keyExtractor={(row) => row.id}
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
        ListHeaderComponent={
          <QueueHeader
            filter={filter}
            canModerate={canModerate}
            hasIndex={hasIndex}
            hasRows={rows.length > 0}
          />
        }
        ListFooterComponent={truncated ? <Footnote text={truncated} /> : null}
        ListEmptyComponent={
          <QueryStates
            query={queue}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so the queue can't be loaded — and taking a comment down wouldn't reach your published issue. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={5} />}
            empty={{
              title: emptyTitle(filter),
              description: emptyBody(filter),
            }}
          >
            {null}
          </QueryStates>
        }
        renderItem={renderComment}
      />

      <ArchiveCommentSheet
        comment={openComment}
        titles={titles}
        onClose={closeSheet}
        onAction={(comment, action) => void act(comment, action)}
        busy={busy}
        online={online && canModerate}
      />
    </SafeAreaView>
  );
}

function QueueHeader({
  filter,
  canModerate,
  hasIndex,
  hasRows,
}: {
  filter: ArchiveCommentFilter;
  canModerate: boolean;
  hasIndex: boolean;
  hasRows: boolean;
}) {
  return (
    <View>
      {canModerate ? null : (
        <MobileScopeNotice
          title="Needs an owner or admin session"
          body="Comment moderation is admin-only on the server, so this queue can't be loaded or acted on with your role."
        />
      )}
      {filter === "visible" ? <Footnote text={LIVE_TAB_NOTE} /> : null}
      {hasRows && !hasIndex ? (
        <Footnote text="Issue names come from your archive index, which hasn't loaded — rows show the issue id instead." />
      ) : null}
    </View>
  );
}

function Footnote({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginBottom: 10,
      }}
    >
      {text}
    </Text>
  );
}

function emptyTitle(filter: ArchiveCommentFilter): string {
  if (filter === "visible") return "No comments on your issues yet";
  if (filter === "pending") return "Nothing waiting";
  if (filter === "hidden") return "Nothing hidden";
  return "Nothing marked as spam";
}

function emptyBody(filter: ArchiveCommentFilter): string {
  if (filter === "visible") {
    return "Readers can comment on any published archive issue. New comments appear here the moment they are posted.";
  }
  if (filter === "pending") {
    return "Comments publish themselves today — this tab fills only once your deployment gains a pre-moderation step.";
  }
  if (filter === "hidden") {
    return "Comments you hide are kept here, with their replies, and can be put back.";
  }
  return "Comments you mark as spam are kept here and can be put back.";
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}
