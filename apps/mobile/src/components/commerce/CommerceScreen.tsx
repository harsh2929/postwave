/**
 * CommerceScreen — "are my stores still ingesting, and what have they done?"
 *
 * WHY THIS EXISTS. `apps/api/internal/commerce` is one of the largest
 * subsystems in the product — six provider adapters, a webhook claim table, a
 * resumable backfill cursor, twenty-odd routes — and mobile referenced none of
 * it. The desktop's four-tab browse grids are correctly desktop-only; the
 * pipeline-health question is not, because a Shopify backfill that dies on a
 * 401 at 6pm is silently not ingesting orders until someone opens a laptop.
 *
 * THE SCOPE PROBLEM, STATED OUT LOUD. `GET /api/v1/commerce/integrations` is
 * the only route that can ENUMERATE stores and it is mounted behind
 * `ScopeAdmin` (handlers.go:138), while the analytics route beneath it takes
 * `ScopeReadReports` (:166). For a session cookie that admin scope becomes an
 * owner/admin ROLE check (apikeys/middleware.go:211-220). So an editor or
 * viewer gets a 403 on the list and there is no read-scoped fallback. This
 * screen therefore treats 403 as its own explained state — never as "no stores
 * connected", which would be the app inventing a fact about the workspace.
 *
 * THE ONE WRITE. "Resume sync" posts to `/{id}/sync` with an empty body, which
 * makes the server pull from the provider cursor it already holds
 * (handlers.go:1434-1454) and answer 202. It is the real thing, not the
 * delegated no-op the `integrations` package returns for the same verb — which
 * is why it is offered here and deliberately not on the Integrations tab. It
 * is NOT optimistic: 202 means accepted, so claiming "syncing" on the client
 * would be asserting an outcome the response does not carry.
 *
 * THE TWO ADMINISTRATIVE WRITES. Pause (`POST /{id}/pause`) and Disconnect
 * (`DELETE /{id}`) are both ScopeAdmin (handlers.go:143-144), so they are
 * offered only when `canAccessMinimumRole("admin")` clears AND the online gate
 * is open — a viewer sees every store's state and none of the verbs. Both ask
 * first, because neither can be undone from the phone. The flows live in
 * hooks/useStoreConnectionActions; this screen only owns which row's overflow
 * is open and where the disconnect receipt renders.
 *
 * NativeWind v4: static style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { QueryStates } from "@/components/QueryStates";
import { RowActionSheet, type RowAction } from "@/components/RowActionSheet";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { DisconnectOutcomeCard } from "@/components/commerce/DisconnectOutcomeCard";
import { StoreAnalyticsCard } from "@/components/commerce/StoreAnalyticsCard";
import { StoreCard } from "@/components/commerce/StoreCard";
import { StoreLifecycleSection } from "@/components/commerce/StoreLifecycleSection";
import { StoreOrdersSection } from "@/components/commerce/StoreOrdersSection";
import { StoreRecoverySection } from "@/components/commerce/StoreRecoverySection";
import {
  useCommerceAnalytics,
  useCommerceOrders,
  useCommerceStores,
  useResumeCommerceSync,
} from "@/hooks/useCommerce";
import { useCommerceWidgetMirror } from "@/hooks/useCommerceWidgetMirror";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useStoreConnectionActions,
  type StoreConnectionActions,
} from "@/hooks/useStoreConnectionActions";
import {
  disconnectVerb,
  offersStoreAdministration,
  storeConnectionName,
} from "@/lib/commerceConnection";
import {
  commerceSyncErrorMessage,
  isCommerceScopeDenied,
  storesNeedingAttention,
  type CommerceStore,
} from "@/lib/commerceRollup";
import { num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function CommerceScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  useScreenViewed("commerce");

  const stores = useCommerceStores();
  const resume = useResumeCommerceSync();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);

  // Pause and Disconnect are admin-only on the server AND never queued for
  // replay, so a session that is not owner/admin — or not online — gets the
  // card without the verbs rather than a verb that fails after the tap.
  const mode = useAuthStore((s) => s.mode);
  // Held on its own because the lifecycle section needs the ROLE without the
  // online half: its report read is admin-gated, its write is admin AND online.
  const canAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const administers = offersStoreAdministration({
    canAdmin,
    online: gate.enabled,
  });
  const connection = useStoreConnectionActions();
  // Which row's overflow is open. Owned here, not in the card: one sheet for
  // the list rather than one Modal per store (see RowActionSheet's header).
  const [menuStoreId, setMenuStoreId] = useState<string | null>(null);
  const openMenu = useCallback(
    (store: CommerceStore) => setMenuStoreId(store.id),
    [],
  );

  const rows = useMemo(
    () => (Array.isArray(stores.data) ? stores.data : []),
    [stores.data],
  );
  // Nothing chosen yet → the first store, so the numbers below are never blank
  // while a portfolio is on screen. A selection the user made survives a
  // refetch as long as the store is still there.
  const activeId =
    selectedId && rows.some((row) => row.id === selectedId)
      ? selectedId
      : (rows[0]?.id ?? null);
  const analytics = useCommerceAnalytics(activeId);
  const orders = useCommerceOrders(activeId);
  // All three, so a pull refreshes everything the screen is showing. Leaving
  // `orders` out would silently pin the "recent orders" list — the one part of
  // this screen whose whole job is to be current.
  //
  // LOVE#15: `useManualRefresh`, not `isRefetching`. A foreground resume
  // refetches (connectivity.ts bridges AppState into TanStack's focusManager),
  // and a spinner that appears without a gesture reads as a malfunction.
  const refresh = useManualRefresh(
    [stores.refetch, analytics.refetch, orders.refetch],
    { enabled: gate.enabled },
  );

  const scopeDenied = isCommerceScopeDenied(stores.error);
  const attention = storesNeedingAttention(rows);

  /**
   * COMMERCE#70. This screen is the ONLY foreground writer of the widget's
   * commerce record, and that is a property of the API rather than a choice:
   * the analytics route needs an integration id and the only route that can
   * enumerate integrations is admin-scoped, so "which store" is a decision a
   * person makes here and nowhere else. The record therefore carries the id,
   * which is what lets the background task refresh THIS store later without
   * re-enumerating (see hooks/useWidgetBackgroundRefresh.ts) — and it carries
   * the measurement time, so a widget on a device where nobody opens Stores
   * says how old its numbers are instead of implying they are live.
   */
  useCommerceWidgetMirror({
    storeId: activeId,
    storeLabel: activeStoreLabel(rows, activeId),
    analytics: analytics.data,
    dataUpdatedAt: analytics.dataUpdatedAt,
  });

  const onResume = useCallback(
    (store: CommerceStore) => {
      setResumingId(store.id);
      haptics.tap();
      resume.mutate(store.id, {
        onSuccess: () => {
          haptics.success();
          // "Accepted", not "done" — the wording matches what 202 means.
          toast({
            kind: "success",
            message: `Sync requested for ${store.shopDomain || store.provider}.`,
          });
          setResumingId(null);
        },
        onError: (err) => {
          haptics.error();
          toast({ kind: "error", message: commerceSyncErrorMessage(err) });
          setResumingId(null);
        },
      });
    },
    [resume, toast],
  );

  const subtitle =
    stores.data !== undefined && rows.length > 0
      ? `${num(rows.length)} connected · ${attention} need attention`
      : undefined;
  // Resolved against the CURRENT rows, so a store that disappears in a
  // refetch closes its own menu instead of leaving a sheet over a missing row.
  const menuStore = rows.find((row) => row.id === menuStoreId) ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Stores"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {scopeDenied ? (
          <ScopeNotice />
        ) : (
          <QueryStates
            query={stores}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="Store health needs a connection. Reconnect and pull to refresh — this is not the same as having no stores."
            skeleton={<SkeletonList rows={3} lines={3} label="Loading stores" />}
            empty={{
              title: "No stores connected",
              description:
                "Connect Shopify, Stripe, WooCommerce or BigCommerce on the web admin; their ingest health will appear here.",
            }}
          >
            <SectionLabel>Connections</SectionLabel>
            {connection.receipt ? (
              <DisconnectOutcomeCard
                storeName={storeConnectionName(connection.receipt.store)}
                outcome={connection.receipt.result}
                onDismiss={connection.dismissReceipt}
              />
            ) : null}
            {rows.map((store) => (
              <StoreCard
                key={store.id}
                store={store}
                selected={store.id === activeId}
                onSelect={setSelectedId}
                resuming={resumingId === store.id}
                pausing={connection.pausingId === store.id}
                {...(gate.enabled ? { onResume } : {})}
                {...(administers
                  ? { onPause: connection.pause, onMore: openMenu }
                  : {})}
              />
            ))}

            <SectionLabel topMargin={24}>
              {activeName(rows, activeId)}
            </SectionLabel>
            <QueryStates
              query={analytics}
              gate={gate}
              isEmpty={!analytics.data}
              offlineMessage="Reconnect to read this store's numbers."
              skeleton={<SkeletonList rows={2} lines={2} label="Loading store numbers" />}
              empty={{
                title: "No numbers yet",
                description:
                  "Nothing has been ingested for this store, so there is nothing to total.",
              }}
            >
              {analytics.data ? (
                <StoreAnalyticsCard analytics={analytics.data} />
              ) : null}
            </QueryStates>

            {/* Sibling of the analytics block, not a child of it. The totals
                and the newest rows are two independent reads of the same
                store, and nesting them would let one failing query hide the
                other — the aggregate is exactly what stays plausible while
                ingest is dead, so losing the rows is losing the evidence. */}
            <StoreOrdersSection orders={orders} gate={gate} />

            {/* Recovery is the third read of the same store, and the only one
                that is about people rather than money: a back-in-stock row the
                server marked eligible is a promise nobody has kept yet. It
                owns its own query because the list it shows depends on a tab
                choice that belongs to it — see the note on the component. */}
            <StoreRecoverySection integrationId={activeId} gate={gate} />

            {/* The roll-up of the same subsystem the queues above sample, plus
                the only fan-out write on this screen. It carries the role
                itself: the report is admin-scoped for a session, and the
                evaluation additionally needs to be online and confirmed. */}
            <StoreLifecycleSection
              integrationId={activeId}
              storeName={activeStoreLabel(rows, activeId) ?? "this store"}
              gate={gate}
              canAdmin={canAdmin}
            />
          </QueryStates>
        )}
      </ScrollView>

      <RowActionSheet
        visible={menuStore !== null}
        title={menuStore ? storeConnectionName(menuStore) : ""}
        subtitle={
          menuStore ? `${menuStore.provider} · ${menuStore.status}` : undefined
        }
        actions={menuStore ? storeMenuActions(menuStore, connection) : []}
        onClose={() => setMenuStoreId(null)}
      />
    </SafeAreaView>
  );
}

/**
 * The overflow holds the one verb that is destructive enough to deserve a
 * second tap before its confirm: Disconnect. A second disconnect answers 200
 * and changes nothing (handlers.go:378), so an already-disconnected store gets
 * the row dimmed with its reason rather than a button that pretends to act.
 */
function storeMenuActions(
  store: CommerceStore,
  connection: StoreConnectionActions,
): RowAction[] {
  const verb = disconnectVerb(store);
  const busy = connection.disconnectingId === store.id;
  return [
    {
      key: "disconnect",
      label: "Disconnect…",
      accessibilityLabel: `Disconnect ${storeConnectionName(store)}`,
      hint: "Imported customers, products, and orders are kept",
      destructive: true,
      disabled: busy || !verb.enabled,
      disabledReason: busy ? "Disconnecting…" : verb.reason,
      onPress: () => {
        void connection.disconnect(store);
      },
    },
  ];
}

function activeName(
  rows: readonly CommerceStore[],
  activeId: string | null,
): string {
  return activeStoreLabel(rows, activeId) ?? "Store numbers";
}

/**
 * The selected store's own name, or null when there is not one.
 *
 * Split out of `activeName` because the widget mirror must NOT fall back to
 * the section-heading text: publishing "Store numbers" as a shop's name to the
 * home screen would put a UI label where a measured fact belongs.
 */
function activeStoreLabel(
  rows: readonly CommerceStore[],
  activeId: string | null,
): string | null {
  const active = rows.find((row) => row.id === activeId);
  if (!active) return null;
  return active.shopDomain || active.provider || null;
}

/**
 * The 403 branch. It says WHICH permission is missing and what the session can
 * still do, because "Forbidden" tells an operator nothing they can act on —
 * and rendering an empty portfolio here would be a claim about the workspace
 * rather than about the session.
 */
function ScopeNotice() {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="Store connections need an owner or admin session. Your session can read a store's numbers but cannot list the stores."
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 16,
        gap: 8,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Needs an owner or admin session
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Listing store connections is an admin-scoped read on this server, so
        your current role can&apos;t enumerate them. Ask an owner or admin to
        check the pipeline, or open Commerce on the web admin.
      </Text>
    </View>
  );
}
