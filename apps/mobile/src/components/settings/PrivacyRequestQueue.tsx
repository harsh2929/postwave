/**
 * PrivacyRequestQueue — the tenant's DSAR queue, on a phone.
 *
 * GET /api/v1/privacy/requests has always returned the WHOLE tenant's privacy
 * requests, paged on (requested_at, id). Mobile called it without a cursor,
 * ignored `nextCursor`, sliced the first four rows in wire order and printed
 * "+N more on the web admin" — so on a workspace with real DSAR volume the one
 * request that had blown its statutory deadline was, by construction,
 * invisible. A deadline is exactly the kind of thing you need to see while
 * away from a desk.
 *
 * What this adds beyond "show more rows":
 *   - DEADLINE ORDER, not arrival order. Most-overdue first (src/lib/privacyQueue).
 *   - A count of what is actually at risk, stated in the header.
 *   - The four lifecycle levers the API has always exposed and mobile never
 *     called: verify, legal hold / release, deny, appeal.
 *
 * Every action offered is one the server will accept for that row's current
 * status — the allow-list is derived from the handlers' own guards, so the app
 * never shows a button whose only outcome is a 409.
 *
 * WHY THIS SHEET IS NOT A `KeyboardFormSheet`. That component wraps its
 * children in a ScrollView, and a FlatList inside a plain ScrollView is handed
 * the whole content height by its parent — so its render window covers every
 * row and virtualization is silently defeated. On a queue that pages 100 rows
 * at a time with no ceiling, "looks virtualized, isn't" is the expensive kind
 * of wrong. The list is therefore the sheet's own scroll container, with the
 * heading and the filters as its header, exactly as LandingPageDetailSheet
 * does it. Nothing here takes text input, so the keyboard-avoiding chrome that
 * sheet provides has nothing to avoid.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { listPrivacyRequests } from "@/api/settingsExtras";
import { Chip } from "@/components/Chip";
import { QueryStates } from "@/components/QueryStates";
import { PrivacyRequestActionSheet } from "@/components/settings/PrivacyRequestActionSheet";
import { formatPrivacyLabel } from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import {
  PRIVACY_QUEUE_FILTERS,
  dueLabel,
  dueState,
  matchesFilter,
  sortQueue,
  summarizeQueue,
  type PrivacyQueueFilter,
  type PrivacyQueueRow,
} from "@/lib/privacyQueue";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const PAGE_SIZE = 100;

/** Module constant, so the separator is not a new component type per render. */
function QueueSeparator() {
  return <View style={{ height: 8 }} />;
}

const queueRowKey = (row: PrivacyQueueRow) => row.request_id;

/** A stable empty list, so an error state does not re-diff a new `[]` array. */
const NO_ROWS: readonly PrivacyQueueRow[] = [];

interface QueuePage {
  rows: PrivacyQueueRow[];
  nextCursor: string | null;
}

export function usePrivacyQueue(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery({
    queryKey: ["privacy-requests-queue", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    initialPageParam: null as string | null,
    getNextPageParam: (last: QueuePage) => last.nextCursor,
    staleTime: 60_000,
    queryFn: async ({ pageParam }): Promise<QueuePage> => {
      const res = await listPrivacyRequests(
        pageParam as string | null,
        PAGE_SIZE,
      );
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return {
        rows: res.data?.requests ?? [],
        nextCursor: res.data?.nextCursor ?? null,
      };
    },
  });
}

export function PrivacyRequestQueue({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const now = useNowTicker();
  const [filter, setFilter] = useState<PrivacyQueueFilter>("urgent");
  const [selected, setSelected] = useState<PrivacyQueueRow | null>(null);
  const queue = usePrivacyQueue(visible);

  const rows = useMemo(
    () => (Array.isArray(queue.data?.pages) ? queue.data?.pages : []).flatMap((page) => page.rows),
    [queue.data],
  );
  const summary = useMemo(() => summarizeQueue(rows, now), [rows, now]);
  const visibleRows = useMemo(
    () => sortQueue(rows.filter((r) => matchesFilter(r, filter, now)), now),
    [rows, filter, now],
  );

  const renderRow = useCallback<ListRenderItem<PrivacyQueueRow>>(
    ({ item }) => (
      <QueueRow row={item} now={now} onPress={() => setSelected(item)} />
    ),
    [now],
  );

  const header = (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            accessibilityRole="header"
            {...typeCap("title")}
            style={{ color: t.fg, fontFamily: FONT.bold, ...typeStyle("title") }}
          >
            Privacy requests
          </Text>
          <Text
            {...typeCap("caption")}
            // The spoken sentence beside the compacted counts, so VoiceOver
            // never has to infer "3 · 2 · 12".
            accessibilityLabel={`${summary.overdue} overdue, ${summary.dueSoon} due within three days, ${summary.open} open in total.`}
            style={{
              color: summary.overdue > 0 ? t.danger : t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
              marginTop: 4,
            }}
          >
            {summary.overdue > 0
              ? `${summary.overdue} overdue · ${summary.dueSoon} due soon · ${summary.open} open`
              : `${summary.dueSoon} due soon · ${summary.open} open`}
          </Text>
          {summary.undated > 0 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
                marginTop: 2,
              }}
            >
              {summary.undated} with no deadline recorded
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close the privacy request queue"
          hitSlop={8}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              fontFamily: FONT.semibold,
              ...typeStyle("control"),
            }}
          >
            Done
          </Text>
        </Pressable>
      </View>

      <View
        style={{
          flexDirection: "row",
          gap: 6,
          flexWrap: "wrap",
          marginTop: 12,
          marginBottom: 12,
        }}
      >
        {PRIVACY_QUEUE_FILTERS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={filter === option.value}
            onPress={() => {
              haptics.tap();
              setFilter(option.value);
            }}
          />
        ))}
      </View>

      <QueryStates
        query={queue}
        gate={gate}
        isEmpty={visibleRows.length === 0}
        skeleton={<SkeletonList rows={4} lines={3} label="Loading requests" />}
        offlineMessage="You're offline, so the privacy queue can't be checked. Deadlines keep running — reconnect to see what's outstanding."
        empty={{
          title:
            rows.length === 0
              ? "No privacy requests"
              : "Nothing in this filter",
          description:
            rows.length === 0
              ? "Data-subject requests filed against this workspace will appear here with their statutory deadline."
              : "Switch to All to see every request on file.",
        }}
      >
        {/* QueryStates owns loading / empty / error / offline and renders its
            children only once the read has succeeded. The requests are the
            list's data, so there is nothing left for it to render here. */}
        {null}
      </QueryStates>
    </>
  );

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Privacy request queue"
      >
        <FlatList
          // Withheld on a failed read for the reason QueryStates encodes: an
          // error REPLACES the queue rather than sitting above a stale copy of
          // it, which is what wrapping the list in QueryStates used to do.
          data={queue.isError ? NO_ROWS : visibleRows}
          keyExtractor={queueRowKey}
          renderItem={renderRow}
          ItemSeparatorComponent={QueueSeparator}
          {...MOBILE_LIST_PERF_PROPS}
          contentContainerStyle={{ padding: 20, paddingBottom: 24 }}
          ListHeaderComponent={header}
          ListFooterComponent={
            queue.hasNextPage ? (
              <Pressable
                onPress={() => void queue.fetchNextPage()}
                disabled={queue.isFetchingNextPage}
                accessibilityRole="button"
                accessibilityLabel="Load more privacy requests"
                accessibilityState={{ disabled: queue.isFetchingNextPage }}
                style={{
                  marginTop: 12,
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: t.border,
                }}
              >
                <Text
                  {...typeCap("callout")}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.semibold,
                    ...typeStyle("callout"),
                  }}
                >
                  {queue.isFetchingNextPage ? "Loading…" : "Load more"}
                </Text>
              </Pressable>
            ) : null
          }
        />

        <PrivacyRequestActionSheet
          request={selected}
          onClose={() => setSelected(null)}
          onCompleted={() => {
            setSelected(null);
            void queue.refetch();
          }}
        />
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function urgencyTone(
  state: ReturnType<typeof dueState>,
  t: ThemeTokens,
): { fg: string; label: string } {
  switch (state) {
    case "overdue":
      return { fg: t.danger, label: "Overdue" };
    case "due_soon":
      return { fg: t.warning, label: "Due soon" };
    case "unknown":
      return { fg: t.fgMuted, label: "No deadline" };
    case "closed":
      return { fg: t.fgSubtle, label: "Closed" };
    default:
      return { fg: t.fgMuted, label: "On track" };
  }
}

function QueueRow({
  row,
  now,
  onPress,
}: {
  row: PrivacyQueueRow;
  now: number;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const state = dueState(row, now);
  const tone = urgencyTone(state, t);
  const subject = row.subject_email?.trim() || "No subject address on file";
  const deadline = dueLabel(row, now);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // The state is spoken, never colour-alone: `tone.label` carries what the
      // red text means for anyone who cannot see it.
      accessibilityLabel={`${formatPrivacyLabel(row.type)} for ${subject}. ${tone.label}. ${deadline}. Status ${formatPrivacyLabel(row.status)}.${row.legal_hold ? " Legal hold applied." : ""}`}
      accessibilityHint="Opens the actions for this request"
      style={{
        minHeight: 44,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: state === "overdue" ? t.danger : t.borderSubtle,
        backgroundColor: t.surface,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          justifyContent: "space-between",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("body"),
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {formatPrivacyLabel(row.type)}
        </Text>
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: tone.fg,
            fontFamily: FONT.bold,
            ...typeStyle("badgeSmall"),
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {tone.label}
        </Text>
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("label"),
        }}
        numberOfLines={1}
      >
        {subject}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
        numberOfLines={1}
      >
        {deadline} · {formatPrivacyLabel(row.region)} ·{" "}
        {formatPrivacyLabel(row.status)}
        {row.legal_hold ? " · legal hold" : ""}
      </Text>
    </Pressable>
  );
}
