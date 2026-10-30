/**
 * OutboundDeliveriesSheet — "show me only THIS receiver's recent attempts".
 *
 * The Webhooks screen's Deliveries segment is the global feed across every
 * endpoint. It cannot answer the on-call question about one receiver without
 * the operator scanning event types by eye. Desktop answers it with a
 * per-endpoint slideover (components/OutboundWebhookDeliveriesSlideover.tsx)
 * over GET /api/v1/outbound-webhooks/{id}/deliveries; this is the phone's.
 *
 * A SHEET RATHER THAN A ROUTE, like InboundEventsSheet: open → read → maybe
 * replay one → close, and it keeps this surface to a single route file.
 *
 * WHAT IT SAYS AND WHY:
 *   · Keyset-paged, newest first. "Load older" appears only while the server
 *     reports a next cursor; when it reports none the footer says so rather
 *     than implying more might exist.
 *   · The 24h terminal-failure rollup is desktop's own sentence, and it says
 *     "loaded" because the count is bounded by the pages fetched, not the
 *     server.
 *   · Replay on an inactive destination is refused UP FRONT with desktop's
 *     reason (the row's swipe stays, because DeliveryRow is shared with the
 *     global feed; the refusal is a stated toast, never a 409 discovered
 *     afterwards).
 *   · Rows are de-duplicated across pages: a keyset cursor that moved under
 *     a live feed can repeat a delivery, and a FlatList with two identical
 *     keys misrenders.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { DeliveryRow } from "@/components/webhooks/DeliveryRow";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useOutboundEndpointDeliveries } from "@/hooks/useOutboundEndpointDeliveries";
import {
  useOutboundWebhookActions,
  type OutboundDelivery,
  type OutboundWebhook,
} from "@/hooks/useOutboundWebhooks";
import { FONT } from "@/lib/fonts";
import { truncateMiddle } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import {
  deliveriesSummaryLine,
  mergeDeliveryPages,
  replayUnavailableReason,
  terminalFailureRollup,
} from "@/lib/outboundDeliveryPage";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface OutboundDeliveriesSheetProps {
  /** The open endpoint, or null when the sheet is closed. */
  webhook: OutboundWebhook | null;
  onClose: () => void;
}

export function OutboundDeliveriesSheet({
  webhook,
  onClose,
}: OutboundDeliveriesSheetProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const actions = useOutboundWebhookActions();
  const history = useOutboundEndpointDeliveries(webhook?.id ?? null);

  // `pages` is whatever the cache holds. Array.isArray, not `?? []`: a
  // persisted entry from an older build, or a harness handing every query the
  // same payload, is a truthy non-array and must become an EMPTY list.
  const pages = history.data?.pages;
  const rows = useMemo(
    () => mergeDeliveryPages(Array.isArray(pages) ? pages : []),
    [pages],
  );
  const hasMore = Boolean(history.hasNextPage);
  const rollup = useMemo(() => terminalFailureRollup(rows), [rows]);
  const replayBlocked = webhook ? replayUnavailableReason(webhook) : null;
  // The same fallback EndpointRow renders as its title, so the sheet is named
  // for what the operator just tapped.
  const title = webhook
    ? webhook.description?.trim() || truncateMiddle(webhook.url, 42)
    : "Deliveries";

  const onReplay = useCallback(
    async (delivery: OutboundDelivery) => {
      if (replayBlocked) {
        haptics.warning();
        toast({ kind: "warning", message: replayBlocked });
        return;
      }
      const ok = await confirm({
        title: "Replay this delivery?",
        message: `${delivery.event_type} will be re-sent to the receiver as a NEW delivery, so receiver-side de-duplication won't swallow it. The original attempt history is left untouched.`,
        confirmLabel: "Replay",
      });
      if (!ok) return;
      try {
        await actions.replay.mutateAsync(delivery.id);
        haptics.success();
        toast({ kind: "success", message: "Replay queued." });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message:
            err instanceof Error && err.message ? err.message : "Couldn't replay it.",
        });
      }
    },
    [actions.replay, confirm, replayBlocked, toast],
  );

  const loadOlder = useCallback(() => {
    if (history.isFetchingNextPage) return;
    void history.fetchNextPage();
  }, [history]);

  return (
    <ReducedMotionModal
      visible={webhook !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "bottom"]}>
        <SheetHeader
          title={title}
          subtitle={
            history.isLoading || history.isError
              ? undefined
              : deliveriesSummaryLine(rows.length, hasMore)
          }
          onClose={onClose}
        />

        {rollup || replayBlocked ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 4 }}>
            {rollup ? <Note text={rollup} tone="warning" /> : null}
            {replayBlocked ? <Note text={replayBlocked} tone="muted" /> : null}
          </View>
        ) : null}

        <FlatList
          data={history.data === undefined ? [] : rows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, flexGrow: 1 }}
          {...MOBILE_LIST_PERF_PROPS}
          ListEmptyComponent={
            <QueryStates
              query={history}
              gate={gate}
              isEmpty={rows.length === 0}
              offlineMessage="You're offline, so this endpoint's deliveries can't be loaded. Reconnect and open it again."
              skeleton={<SkeletonList rows={4} />}
              empty={{
                title: "Nothing has been attempted yet",
                description:
                  "No events matching this endpoint's subscriptions have been enqueued. Attempts will appear here newest first.",
              }}
            >
              <View />
            </QueryStates>
          }
          ListFooterComponent={
            rows.length === 0 ? null : (
              <Footer
                title={title}
                hasMore={hasMore}
                loading={history.isFetchingNextPage}
                error={
                  history.isError && history.error instanceof Error
                    ? history.error.message
                    : null
                }
                onLoadOlder={loadOlder}
              />
            )
          }
          renderItem={({ item }) => (
            <DeliveryRow delivery={item} onReplay={(d) => void onReplay(d)} />
          )}
        />
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function Note({ text, tone }: { text: string; tone: "warning" | "muted" }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: tone === "warning" ? t.warning : t.fgMuted,
        ...typeStyle("label"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}

/**
 * The paging control. Three honest states: more exists (a button), the
 * server said this is the last page (a sentence), or the last page fetch
 * failed (the server's words, and the button again).
 */
function Footer({
  title,
  hasMore,
  loading,
  error,
  onLoadOlder,
}: {
  title: string;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadOlder: () => void;
}) {
  const { t } = useTheme();
  if (!hasMore && !error) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          paddingTop: 8,
        }}
      >
        No older deliveries are recorded for this endpoint.
      </Text>
    );
  }
  return (
    <View style={{ paddingTop: 8, gap: 8 }}>
      {error ? <Note text={error} tone="warning" /> : null}
      <Pressable
        onPress={onLoadOlder}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel={`Load older deliveries for ${title}`}
        accessibilityState={{ disabled: loading, busy: loading }}
        style={{
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.bgSubtle,
          opacity: loading ? 0.5 : 1,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{ color: t.accent, ...typeStyle("control"), fontFamily: FONT.semibold }}
        >
          {loading ? "Loading older…" : "Load older"}
        </Text>
      </Pressable>
    </View>
  );
}

function SheetHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 10,
        gap: 12,
      }}
    >
      <View style={{ flexShrink: 1 }}>
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          {...typeCap("title")}
          style={{ color: t.fg, ...typeStyle("title"), fontFamily: FONT.display }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close delivery history"
        hitSlop={12}
        style={{ minHeight: 44, minWidth: 44, alignItems: "flex-end", justifyContent: "center" }}
      >
        <Text
          {...typeCap("callout")}
          style={{ color: t.accent, ...typeStyle("callout"), fontFamily: FONT.semibold }}
        >
          Close
        </Text>
      </Pressable>
    </View>
  );
}
