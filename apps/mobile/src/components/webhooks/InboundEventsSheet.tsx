/**
 * InboundEventsSheet — "is anything actually arriving, and did it verify?"
 *
 * The inbound-webhooks screen could show that an endpoint EXISTED and hand
 * back its public URL. It could not show a single event, which meant the one
 * question the screen's own doc comment claims it answers — "see whether
 * events are flowing" — had no data behind it. The list endpoint returns no
 * counts either (repo.go ListPage selects id/slug/name/enabled/transform/
 * created_at and nothing else), so the aggregate tiles could never fill in.
 *
 * A SHEET RATHER THAN A ROUTE, for the reason LandingPageDetailSheet is one:
 * open → read → maybe replay one → close, and it keeps this surface to a
 * single route file.
 *
 * WHAT THE SERVER WILL AND WON'T DO, restated in the UI:
 *   · Replay RE-EXECUTES trigger actions (sequence enrolment, tag writes).
 *     That is the point — you are re-firing an event whose trigger you just
 *     fixed — so the confirm says so in those words.
 *   · An event whose signature did NOT verify can never be replayed
 *     (422 event_not_verified). The control is disabled with the reason
 *     beside it rather than live-and-then-refused.
 *   · Only the most recent page is fetched. When older events exist the
 *     footer says so instead of implying the feed is complete.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import * as Clipboard from "expo-clipboard";
import { useCallback, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { InboundEventRow } from "@/components/webhooks/InboundEventRow";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useInboundWebhookActions,
  useInboundWebhookEvents,
  type InboundEvent,
} from "@/hooks/useInboundWebhookOps";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { invalidSignatureCount } from "@/lib/inboundEventPolicy";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InboundEventsSheetProps {
  /** The open endpoint, or null when the sheet is closed. */
  endpoint: { id: string; name: string; slug: string } | null;
  onClose: () => void;
}

export function InboundEventsSheet({
  endpoint,
  onClose,
}: InboundEventsSheetProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const actions = useInboundWebhookActions();
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const events = useInboundWebhookEvents(endpoint?.id ?? null);
  const rows: InboundEvent[] = events.data?.items ?? [];
  const failed = invalidSignatureCount(rows);

  const onCopyBody = useCallback(
    (event: InboundEvent) => {
      Clipboard.setStringAsync(event.body)
        .then(() => {
          haptics.success();
          toast({ kind: "success", message: "Payload copied" });
        })
        .catch(() => {
          haptics.error();
          toast({
            kind: "error",
            message:
              "Couldn't reach the clipboard. Long-press the payload to select it instead.",
          });
        });
    },
    [toast],
  );

  const onReplay = useCallback(
    async (event: InboundEvent) => {
      if (!endpoint) return;
      const ok = await confirm({
        title: "Replay this event?",
        message:
          "The stored payload is re-run through your triggers, and any trigger that matches WILL act again — enrolling in a sequence, adding or removing a tag, starting an automation. Nothing is sent back to the upstream system.",
        confirmLabel: "Replay",
      });
      if (!ok) return;
      setReplayingId(event.id);
      try {
        const result = await actions.replay.mutateAsync({
          endpointId: endpoint.id,
          eventId: event.id,
        });
        const executed = result.matches.filter((m) => m.executed).length;
        haptics.success();
        toast({
          kind: "success",
          message:
            result.matches.length === 0
              ? "Replayed · no trigger matched this payload"
              : `Replayed · ${plural(result.matches.length, "trigger")} matched, ${executed} ran`,
        });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message:
            err instanceof Error && err.message
              ? err.message
              : "Couldn't replay the event.",
        });
      } finally {
        setReplayingId(null);
      }
    },
    [actions.replay, confirm, endpoint, toast],
  );

  return (
    <ReducedMotionModal
      visible={endpoint !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <SheetHeader
          title={endpoint?.name || endpoint?.slug || "Recent events"}
          subtitle={
            events.isLoading || events.isError
              ? undefined
              : summaryLine(rows.length, failed)
          }
          failed={failed !== null && failed > 0}
          onClose={onClose}
        />

        <FlatList
          data={events.data === undefined ? [] : rows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: 32,
            gap: 8,
            flexGrow: 1,
          }}
          {...MOBILE_LIST_PERF_PROPS}
          ListEmptyComponent={
            <QueryStates
              query={events}
              gate={gate}
              isEmpty={rows.length === 0}
              offlineMessage="You're offline, so the event feed can't be loaded. Reconnect and open this endpoint again."
              skeleton={<SkeletonList rows={4} />}
              empty={{
                title: "Nothing has arrived yet",
                description:
                  "No events have reached this endpoint. Check that the upstream system has the public URL and is signing with the current secret.",
              }}
            >
              <View />
            </QueryStates>
          }
          ListFooterComponent={
            events.data?.nextCursor ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  paddingTop: 12,
                }}
              >
                Older events exist beyond this page. Open the endpoint in the
                web admin for the full history.
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <InboundEventRow
              event={item}
              replaying={replayingId === item.id}
              busy={actions.replay.isPending}
              onReplay={() => void onReplay(item)}
              onCopyBody={() => onCopyBody(item)}
            />
          )}
        />
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/**
 * The count line. `failed` is null when NOTHING has arrived, which is a
 * different sentence from "none of them failed" — absence is not zero.
 */
function summaryLine(total: number, failed: number | null): string {
  if (failed === null) return "No events yet";
  const base = `${plural(total, "event")} shown`;
  return failed > 0 ? `${base} · ${failed} failed signature` : base;
}

function SheetHeader({
  title,
  subtitle,
  failed,
  onClose,
}: {
  title: string;
  subtitle: string | undefined;
  failed: boolean;
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
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontFamily: FONT.display,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            {...typeCap("label")}
            style={{
              // Never colour alone: the word "failed" is in the string
              // itself, so the tint only reinforces it.
              color: failed ? t.warning : t.fgMuted,
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
        accessibilityLabel="Close recent events"
        hitSlop={12}
        style={{
          minHeight: 44,
          minWidth: 44,
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          Close
        </Text>
      </Pressable>
    </View>
  );
}
