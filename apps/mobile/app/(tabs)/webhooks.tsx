/**
 * Webhooks — outbound delivery health and replay.
 *
 * This is the on-call surface mobile exists for. Before it, the phone's only
 * outbound-webhook view was a Settings section that listed the endpoints that
 * EXIST plus a single `consecutive_failures` line — no delivery history, no
 * health rollup, no replay, and no way to bring back an endpoint the delivery
 * worker had auto-disabled. The operator could see that something was wrong and
 * do nothing about it, which is worse than not looking.
 *
 * Two segments, because the two questions are different:
 *   Endpoints  — "which of my subscriptions are healthy, and can I pause /
 *                 re-enable one?"
 *   Deliveries — "what failed in the last little while, and can I replay it?"
 *
 * Creating endpoints and revealing signing secrets deliberately stay in
 * Settings: the reveal-once secret flow needs a capture-then-dismiss ceremony
 * that does not belong in a monitoring feed.
 *
 * INBOUND IS THE OTHER HALF OF ONE SUBJECT. Desktop merged receive and send
 * into a single tabbed shell (WebhooksHome) because operators think of
 * "webhooks" as one thing. A phone cannot afford that shell, so this screen
 * names the other half explicitly instead of leaving "events aren't flowing"
 * to a guess about which route to open.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { DeliveryRow } from "@/components/webhooks/DeliveryRow";
import { EndpointRow } from "@/components/webhooks/EndpointRow";
import { OutboundDeliveriesSheet } from "@/components/webhooks/OutboundDeliveriesSheet";
import { OutboundWebhookSelectionBar } from "@/components/webhooks/OutboundWebhookSelectionBar";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useOutboundWebhookSelection } from "@/hooks/useOutboundWebhookSelection";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useOutboundDeliveries,
  useOutboundWebhookActions,
  useOutboundWebhookHealth,
  useOutboundWebhooks,
  type DeliveryStatus,
  type OutboundDelivery,
} from "@/hooks/useOutboundWebhooks";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { forwardArrow } from "@/lib/direction";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

type Segment = "endpoints" | "deliveries";

const DELIVERY_FILTERS = [
  { value: "failing", label: "Failing" },
  { value: "exhausted", label: "Exhausted" },
  { value: "delivered", label: "Delivered" },
  { value: "all", label: "All" },
] as const;

type DeliveryFilter = (typeof DELIVERY_FILTERS)[number]["value"];

export default function Webhooks() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("webhooks");

  const [segment, setSegment] = useState<Segment>("endpoints");
  const [filter, setFilter] = useState<DeliveryFilter>("failing");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const endpoints = useOutboundWebhooks();
  const deliveries = useOutboundDeliveries(
    filter === "all" ? "all" : (filter as DeliveryStatus),
  );
  const health = useOutboundWebhookHealth(
    segment === "endpoints" ? expandedId : null,
  );
  const actions = useOutboundWebhookActions();

  const active = segment === "endpoints" ? endpoints : deliveries;
  const refresh = useRefreshControl(active);

  // `?? []` is a NULLISH guard and does NOT catch a truthy non-array — an
  // envelope that arrived as `{items: […]}`, or a cache persisted by an older
  // build. `endpointRows.filter` in the badge memo below runs BEFORE the list
  // does, so that shape took the whole on-call screen down with
  // "endpointRows.filter is not a function" — the same death MaintenanceBanner
  // died. Array.isArray is the guard that actually covers it.
  const endpointRows = useMemo(
    () => (Array.isArray(endpoints.data) ? endpoints.data : []),
    [endpoints.data],
  );
  const deliveryRows = useMemo(
    () => (Array.isArray(deliveries.data) ? deliveries.data : []),
    [deliveries.data],
  );

  const failingCount = useMemo(
    () => endpointRows.filter((w) => !w.active || w.consecutive_failures > 0).length,
    [endpointRows],
  );

  // Multi-select (long-press a row) and the per-endpoint history sheet. The
  // sheet is keyed by id and re-derived from the loaded rows, so a pause or a
  // concurrent delete is reflected in it — and closes it — without a stale
  // copy of the row living in state.
  const selection = useOutboundWebhookSelection({ visible: endpointRows });
  const {
    active: selecting,
    isSelected,
    toggle: toggleSelect,
    begin: beginSelect,
    canSelect,
  } = selection;
  const [deliveriesForId, setDeliveriesForId] = useState<string | null>(null);
  const deliveriesWebhook = useMemo(
    () => endpointRows.find((w) => w.id === deliveriesForId) ?? null,
    [endpointRows, deliveriesForId],
  );
  const deliveriesBlockedReason = canSelect
    ? null
    : "Delivery history needs an owner or admin role.";

  const busy =
    actions.setActive.isPending ||
    actions.reEnable.isPending ||
    actions.replay.isPending ||
    selection.running;

  const onPauseResume = useCallback(
    async (id: string, nextActive: boolean, label: string) => {
      if (!nextActive) {
        const ok = await confirm({
          title: `Pause ${label}?`,
          message:
            "New events will stop being enqueued for this endpoint. History, delivery rows and signing configuration are all retained, so you can resume at any time.",
          confirmLabel: "Pause",
        });
        if (!ok) return;
      }
      try {
        await actions.setActive.mutateAsync({ id, active: nextActive });
        toast({
          kind: "success",
          message: nextActive ? "Webhook resumed." : "Webhook paused.",
        });
      } catch (err) {
        toast({ kind: "error", message: describe(err, "Couldn't update the webhook.") });
      }
    },
    [actions.setActive, confirm, toast],
  );

  const onReEnable = useCallback(
    async (id: string) => {
      try {
        await actions.reEnable.mutateAsync(id);
        toast({ kind: "success", message: "Webhook re-enabled." });
      } catch (err) {
        // The server 409s with an actionable reason (bad destination, broken
        // receiver auth) — surface it verbatim rather than a generic failure.
        toast({ kind: "error", message: describe(err, "Couldn't re-enable it.") });
      }
    },
    [actions.reEnable, toast],
  );

  const onReplay = useCallback(
    async (delivery: OutboundDelivery) => {
      const ok = await confirm({
        title: "Replay this delivery?",
        message: `${delivery.event_type} will be re-sent to the receiver as a NEW delivery, so receiver-side de-duplication won't swallow it. The original attempt history is left untouched.`,
        confirmLabel: "Replay",
      });
      if (!ok) return;
      try {
        await actions.replay.mutateAsync(delivery.id);
        toast({ kind: "success", message: "Replay queued." });
      } catch (err) {
        toast({ kind: "error", message: describe(err, "Couldn't replay it.") });
      }
    },
    [actions.replay, confirm, toast],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Webhooks" onBack={goBackOrMore} />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
        <SegmentedControl
          options={[
            {
              value: "endpoints",
              label: "Endpoints",
              ...(failingCount > 0 ? { badge: failingCount } : {}),
            },
            { value: "deliveries", label: "Deliveries" },
          ]}
          value={segment}
          onChange={(next) => setSegment(next as Segment)}
          accessibilityLabel="Webhook view"
        />
        {segment === "deliveries" ? (
          <SegmentedControl
            options={DELIVERY_FILTERS}
            value={filter}
            onChange={(next) => setFilter(next as DeliveryFilter)}
            accessibilityLabel="Delivery status filter"
            scrollable
          />
        ) : null}
      </View>

      {segment === "endpoints" ? (
        <FlatList
          data={endpoints.data === undefined ? [] : endpointRows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={LIST_CONTENT}
          refreshControl={
            <RefreshControl
              refreshing={refresh.refreshing}
              onRefresh={refresh.onRefresh}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
          {...MOBILE_LIST_PERF_PROPS}
          ListEmptyComponent={
            <QueryStates
              query={endpoints}
              gate={gate}
              isEmpty={endpointRows.length === 0}
              offlineMessage="You're offline, so webhook health can't be checked. Reconnect and pull to refresh."
              skeleton={<SkeletonList rows={4} />}
              empty={{
                title: "No outbound webhooks",
                description:
                  "Create endpoints in Settings, or from the web admin, to push events to your systems.",
              }}
            >
              <View />
            </QueryStates>
          }
          ListFooterComponent={<InboundCrossLink />}
          renderItem={({ item: row }) => (
            <EndpointRow
              webhook={row}
              expanded={expandedId === row.id}
              onToggle={() =>
                setExpandedId((current) => (current === row.id ? null : row.id))
              }
              health={expandedId === row.id ? health.data : undefined}
              healthLoading={expandedId === row.id && health.isLoading}
              busy={busy}
              onPauseResume={() =>
                void onPauseResume(
                  row.id,
                  !row.active,
                  row.description?.trim() || "this webhook",
                )
              }
              onReEnable={() => void onReEnable(row.id)}
              onShowDeliveries={() => setDeliveriesForId(row.id)}
              deliveriesBlockedReason={deliveriesBlockedReason}
              selecting={selecting}
              selected={isSelected(row.id)}
              onToggleSelect={toggleSelect}
              {...(canSelect || selecting ? { onBeginSelect: beginSelect } : {})}
            />
          )}
        />
      ) : (
        <FlatList
          data={deliveries.data === undefined ? [] : deliveryRows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={LIST_CONTENT}
          refreshControl={
            <RefreshControl
              refreshing={refresh.refreshing}
              onRefresh={refresh.onRefresh}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
          {...MOBILE_LIST_PERF_PROPS}
          ListEmptyComponent={
            <QueryStates
              query={deliveries}
              gate={gate}
              isEmpty={deliveryRows.length === 0}
              offlineMessage="You're offline, so the delivery feed can't be loaded. Reconnect and pull to refresh."
              skeleton={<SkeletonList rows={5} />}
              empty={{
                title:
                  filter === "failing"
                    ? "Nothing failing right now"
                    : "No deliveries in this window",
                description:
                  filter === "failing"
                    ? "No webhook deliveries are currently retrying or stuck."
                    : "Try a different status filter.",
              }}
            >
              <View />
            </QueryStates>
          }
          renderItem={({ item: row }) => (
            <DeliveryRow delivery={row} onReplay={(d) => void onReplay(d)} />
          )}
        />
      )}

      {segment === "endpoints" && selecting ? (
        <OutboundWebhookSelectionBar
          count={selection.selected.length}
          verbs={selection.verbs}
          onDone={selection.exit}
          busyLabel={selection.busyLabel}
        />
      ) : null}

      <OutboundDeliveriesSheet
        webhook={deliveriesWebhook}
        onClose={() => setDeliveriesForId(null)}
      />
    </SafeAreaView>
  );
}

const LIST_CONTENT = {
  padding: 16,
  paddingTop: 12,
  paddingBottom: 32,
  flexGrow: 1,
} as const;

/** Prefer the server's own message — it names the repair — over generic copy. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The receive half. Rendered as a list footer rather than a header so it never
 * competes with the failing endpoints this screen exists to surface.
 */
function InboundCrossLink() {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.push("/(tabs)/inbound-webhooks")}
      accessibilityRole="link"
      accessibilityLabel="Open inbound webhooks, the receive half: endpoint URLs, arriving events and replay"
      style={{
        marginTop: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        minHeight: 44,
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.accent,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {`Receiving events instead? Inbound webhooks ${forwardArrow()}`}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        Endpoint URLs, what has arrived, and per-event replay live there.
      </Text>
    </Pressable>
  );
}
