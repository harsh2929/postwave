/**
 * Reviews — the moderation queue.
 *
 * A complete review platform shipped server-side (`apps/api/internal/reviews`,
 * plus five provider integrations under `review_integrations`) with zero mobile
 * references: submit, moderate, reply, widgets and flow triggers all existed,
 * and the only way to act on any of it was a laptop. That is the wrong shape
 * for this particular job. An approve/reject/reply queue is a phone
 * interaction: short items, a binary decision, and a backlog you clear in the
 * gaps of a day rather than in a session at a desk.
 *
 * WHAT THIS SCREEN DOES, AND WHY THAT AND NOT MORE
 *
 *   Publish / reject / reply — the three verbs whose latency the customer feels.
 *   A five-star review sitting unpublished is revenue not earned; a one-star
 *   review sitting unanswered is a public complaint with no reply under it.
 *
 * Deliberately NOT here, and each for a reason rather than for time:
 *   - Widget design and embed flavours (`/reviews/widgets`): a layout tool.
 *   - Review-request campaigns (`POST /reviews/requests`): audience authoring.
 *   - Provider connections (`/review-integrations`): OAuth and webhook-secret
 *     ceremonies that belong on a machine with a browser.
 *   - Media approval (`POST /reviews/{id}/media`): the route UPLOADS media
 *     rather than moderating it, so it is an authoring verb, not a queue verb.
 *
 * TWO SERVER FACTS SHAPE THE UI AND ARE EASY TO MISS
 *   1. Approve PUBLISHES. `Repo.ModerateReview` stamps `published_at` and
 *      recomputes the product's average rating, so the tap puts a stranger's
 *      words on the storefront. Both verbs therefore get a real ConfirmSheet:
 *      no endpoint returns a row to `pending`, so an "Undo" toast would be a
 *      lie about what it can do.
 *   2. The list read carries NO replies — only `GET /reviews/{id}` does. The
 *      row cannot claim "already answered"; the sheet fetches the single review
 *      and says "Checking for replies…" until it can.
 *
 * ROLE. Reads are `read:reports`; every verb is `ScopeAdmin`. A viewer sees the
 * queue and is told plainly that deciding needs admin, rather than discovering
 * it via a 403 after a confirm.
 *
 * NEITHER VERB IS OFFERED OFFLINE, and that is a correctness rule rather than a
 * courtesy. The app's default mutation policy is `networkMode: "online"`
 * (lib/queryClient.ts), so TanStack PAUSES a mutation started with no
 * connection: `mutateAsync` returns a promise that neither resolves nor
 * rejects. Every failure path below hangs on that await — no toast, no haptic,
 * and `moderate.isPending` latched true, which the guard at the top of
 * `decide` reads as "a decision is already running" and so blocks every
 * subsequent tap for the life of the screen. The swipe actions carried this
 * because only the reply composer consulted `online`.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useConfirm } from "@/components/ConfirmSheet";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { SwipeableRow } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import { ReviewDetailSheet } from "@/components/reviews/ReviewDetailSheet";
import { ReviewRow } from "@/components/reviews/ReviewRow";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import {
  useModerateReview,
  useReplyToReview,
  useReviewDetail,
  useReviewQueue,
} from "@/hooks/useReviews";
import { useReviewFeaturedToggle } from "@/hooks/useReviewFeaturedToggle";
import { REVIEW_LIST_CAP } from "@/api/reviews";
import { FONT } from "@/lib/fonts";
import { num, plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import {
  isDecidable,
  moderationCopy,
  moderationSuccessMessage,
  orderForQueue,
  REVIEW_QUEUE_FILTERS,
  type MobileReview,
  type ReviewQueueFilter,
} from "@/lib/reviewQueue";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

const FILTER_LABELS: Record<ReviewQueueFilter, string> = {
  pending: "Queue",
  approved: "Published",
  rejected: "Rejected",
};

export default function Reviews() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("reviews");

  const mode = useAuthStore((s) => s.mode);
  const canModerate = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const [filter, setFilter] = useState<ReviewQueueFilter>("pending");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const queue = useReviewQueue(filter);
  const detail = useReviewDetail(openId);
  const moderate = useModerateReview();
  const reply = useReplyToReview();
  const refresh = useRefreshControl(queue);
  // The merchandising toggle's choreography — see the hook.
  const featured = useReviewFeaturedToggle(toast, online, messageFor);

  // Keeps "waiting 3h" honest on a queue left open on a desk all morning,
  // instead of freezing at whatever it said when the screen mounted.
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

  const rows = useMemo(
    () => orderForQueue(queue.data ?? [], filter),
    [queue.data, filter],
  );

  const openReview = useMemo(
    () => rows.find((row) => row.id === openId) ?? null,
    [rows, openId],
  );

  const decide = useCallback(
    async (review: MobileReview, decision: "approve" | "reject") => {
      if (moderate.isPending) return;
      if (!online) {
        haptics.error();
        toast({
          kind: "error",
          message:
            "You're offline. Publishing puts a stranger's words on your storefront, so it is never queued — reconnect and try again.",
        });
        return;
      }
      const copy = moderationCopy(decision, review);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        consequence: copy.consequence,
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
      });
      if (!ok) return;
      // Acknowledge the press; the success thump waits for the server, so a
      // failing network never feels like a success followed by an error.
      haptics.impact();
      try {
        await moderate.mutateAsync({ id: review.id, decision });
        haptics.success();
        toast({
          kind: "success",
          message: moderationSuccessMessage(decision, review),
        });
        setOpenId(null);
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: `${copy.confirmLabel} failed. ${messageFor(error)}`,
        });
      }
    },
    [confirm, moderate, online, toast],
  );

  const sendReply = useCallback(async () => {
    if (!openId || reply.isPending) return;
    const body = draft.trim();
    if (!body) return;
    if (!online) {
      haptics.error();
      toast({
        kind: "error",
        message:
          "You're offline. A reply is published publicly the moment it lands, so it is never queued.",
      });
      return;
    }
    haptics.impact();
    try {
      await reply.mutateAsync({ id: openId, body });
      haptics.success();
      setDraft("");
      toast({ kind: "success", message: "Reply published." });
    } catch (error) {
      haptics.error();
      toast({ kind: "error", message: `Reply failed. ${messageFor(error)}` });
    }
  }, [draft, online, openId, reply, toast]);

  const closeSheet = useCallback(() => {
    setOpenId(null);
    setDraft("");
  }, []);

  const openRow = useCallback((review: MobileReview) => {
    setOpenId(review.id);
    setDraft("");
  }, []);

  const truncated = rows.length >= REVIEW_LIST_CAP;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Reviews"
        {...(queue.data
          ? { subtitle: `${plural(rows.length, "review")} · ${FILTER_LABELS[filter]}` }
          : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <SegmentedControl
          accessibilityLabel="Review status"
          options={REVIEW_QUEUE_FILTERS.map((value) => ({
            value,
            label: FILTER_LABELS[value],
          }))}
          value={filter}
          onChange={setFilter}
        />
      </View>

      <FlatList
        data={queue.data === undefined ? [] : rows}
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
          canModerate ? null : (
            <MobileScopeNotice
              title="Read-only for your role"
              body="Publishing, rejecting and replying need an admin role on this workspace."
            />
          )
        }
        ListFooterComponent={
          truncated ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              Showing the {num(REVIEW_LIST_CAP)} most recent — the server caps
              this list and offers no further pages. Clear the queue here, or
              filter by product on desktop.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <QueryStates
            query={queue}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so the queue can't be loaded — and a decision wouldn't reach your storefront. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={5} />}
            empty={{
              title:
                filter === "pending"
                  ? "Queue clear"
                  : filter === "approved"
                    ? "Nothing published yet"
                    : "Nothing rejected",
              description:
                filter === "pending"
                  ? "Every review has been decided. New ones arrive from your storefront widget and from connected review providers."
                  : "Decisions you make here will show up in this list.",
            }}
          >
            {null}
          </QueryStates>
        }
        renderItem={({ item }) => {
          // `online` as well as the role: a swipe offered with no connection
          // starts a paused mutation that never settles (see the header).
          const swipeable = canModerate && online && isDecidable(item);
          const row = (
            <ReviewRow
              review={item}
              onPress={openRow}
              busy={moderate.isPending && moderate.variables?.id === item.id}
              now={now}
            />
          );
          if (!swipeable) return row;
          return (
            <SwipeableRow
              accessibilityLabel={`Review from ${item.reviewerName || "Anonymous"}`}
              right={[
                {
                  label: "Publish",
                  kind: "success",
                  onPress: () => void decide(item, "approve"),
                },
                {
                  label: "Reject",
                  kind: "danger",
                  onPress: () => void decide(item, "reject"),
                },
              ]}
            >
              {row}
            </SwipeableRow>
          );
        }}
      />

      <ReviewDetailSheet
        review={openReview}
        detail={detail.data ?? null}
        detailLoading={detail.isLoading}
        detailFailed={detail.isError}
        onClose={closeSheet}
        onDecide={(review, decision) => void decide(review, decision)}
        deciding={moderate.isPending}
        canModerate={canModerate}
        online={online}
        onToggleFeatured={
          canModerate && online
            ? (review, next) => void featured.toggleFeatured(review, next)
            : null
        }
        togglingFeatured={featured.toggling}
        draft={draft}
        onDraftChange={setDraft}
        onSendReply={() => void sendReply()}
        replying={reply.isPending}
      />
    </SafeAreaView>
  );
}

function messageFor(error: unknown): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 403) return "Your role no longer allows this.";
  if (status === 404) return "That review is no longer there.";
  if (error instanceof Error && error.message) return error.message;
  return "Please try again.";
}
