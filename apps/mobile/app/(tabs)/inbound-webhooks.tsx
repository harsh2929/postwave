/**
 * Inbound webhooks — receive endpoints, what has arrived on them, and the
 * levers you reach for when something is wrong.
 *
 * The operator hands these URLs to upstream systems (Stripe, GitHub,
 * Shopify, …). The phone now covers the whole life of one: mint it in front
 * of the partner's console and capture the shown-once secret, hand the URL
 * back when an integration needs reconnecting, watch whether events are
 * flowing and verifying, re-fire one whose trigger you just fixed, rename it,
 * turn a flooding endpoint off, rotate a leaked secret, and delete it.
 *
 * WHAT CHANGED, AND WHY.
 *
 *  1. IT WAS READ-ONLY. `enabled` was a Pill. The endpoint that backs it,
 *     PATCH /api/v1/inbound-webhooks/{id}, is a single boolean and is the
 *     most phone-shaped write on the surface. It is now a confirm-gated
 *     control in the row.
 *  2. IT CLAIMED TO SHOW EVENT FLOW AND SHOWED NONE. The list endpoint
 *     (repo.go ListPage) returns no counts at all, so the aggregate tiles
 *     could never fill in — the screen's stated job had no data behind it.
 *     GET /{id}/events now backs a real feed, with per-event replay.
 *  3. COPYING A URL COST THREE TAPS. `expo-clipboard` was not a dependency
 *     when this file was written, so it used the share sheet and said so.
 *     Copy is now the primary tap; Share stays for handing it to another app.
 *  4. THE URL TRUNCATED AT THE END, hiding the slug — the only part that
 *     distinguishes two endpoints. `truncateMiddle` keeps both ends.
 *  5. THE SEARCH FIELD WAS HAND-ROLLED: no clear button, no search return
 *     key, no result announcement. `SearchField` has all three.
 *
 * The other half of the subject — OUTBOUND delivery health — is a separate
 * screen, so both now cross-link rather than leaving an operator to guess
 * which half "events aren't flowing" belongs to.
 */
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfirm } from "@/components/ConfirmSheet";
import { EmptyState } from "@/components/EmptyState";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SkeletonList } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { useToast } from "@/components/Toast";
import { WebhookSecretCard } from "@/components/settings/WebhookSecretCard";
import { InboundEndpointAdminActions } from "@/components/inbound-webhooks/InboundEndpointAdminActions";
import { InboundEndpointCreateControl } from "@/components/inbound-webhooks/InboundEndpointCreateControl";
import { InboundTriggerRulesLink } from "@/components/inbound-webhooks/InboundTriggerRulesLink";
import { InboundTriggerRulesSheet } from "@/components/inbound-webhooks/InboundTriggerRulesSheet";
import { InboundEndpointRow } from "@/components/webhooks/InboundEndpointRow";
import { InboundEventsSheet } from "@/components/webhooks/InboundEventsSheet";
import { useDebounced } from "@/hooks/useDebounced";
import { useInboundShownOnceSecret } from "@/hooks/useInboundShownOnceSecret";
import { useInboundUrlHandoff } from "@/hooks/useInboundUrlHandoff";
import { useInboundWebhookActions } from "@/hooks/useInboundWebhookOps";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  type InboundWebhookRow,
  useInboundWebhooks,
} from "@/hooks/useInboundWebhookOps";
import { INBOUND_ROTATION_GRACE_HOURS } from "@/api/inboundWebhooks";
import { trackCommerceAction } from "@/lib/commerceTelemetry";
import { plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { forwardArrow } from "@/lib/direction";

// Route-scoped boundary: a malformed endpoint row fails this screen only.
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/** The consequence of turning an endpoint off, in the server's own terms. */
const DISABLE_CONSEQUENCE =
  "The public URL starts answering upstream senders with 410 Gone, so their own retries and alerting will fire. Nothing is deleted — the endpoint, its secret and its retained events all stay, and you can enable it again at any time.";

/** Rotation copy. The grace window is what makes this safe from a phone. */
const ROTATE_CONSEQUENCE = `A new signing secret is minted and shown once. The current secret keeps verifying for ${INBOUND_ROTATION_GRACE_HOURS} hours, so the upstream system will not break immediately — but it WILL start failing after that unless you paste the new value into it.`;

export default function InboundWebhooks() {
  const offlineGate = useOnlineQueryGate();
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const hooks = useInboundWebhooks();
  const refresh = useRefreshControl(hooks);
  const actions = useInboundWebhookActions();
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 200);
  const [openEvents, setOpenEvents] = useState<InboundWebhookRow | null>(null);
  // The endpoint whose TRIGGER RULES sheet is open; never stacks with events.
  const [openTriggers, setOpenTriggers] = useState<InboundWebhookRow | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  useScreenViewed("inbound-webhooks");

  // Array.isArray, not `?? []`: a NULLISH guard passes a truthy `{}` or
  // `{items: []}` through to `.filter` below (and to `.some` on the
  // secret-membership test), which threw "items.filter is not a function" the
  // moment a needle was typed. Reachable from a restored persisted query cache
  // written by an older response shape — the same route by which api-keys
  // shipped "Invalid attempt to spread non-iterable instance".
  const endpoints = useMemo<InboundWebhookRow[]>(
    () => (Array.isArray(hooks.data) ? hooks.data : []),
    [hooks.data],
  );

  const rows: InboundWebhookRow[] = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase();
    if (!needle) return endpoints;
    return endpoints.filter((row) =>
      `${row.name ?? ""} ${row.slug ?? ""}`.toLowerCase().includes(needle),
    );
  }, [endpoints, debouncedQ]);

  const total = endpoints.length;
  const hasCachedRows = total > 0;
  const busy = actions.setEnabled.isPending || actions.rotate.isPending;
  // The shown-once signing secret, whole: where it lives, whether it may be
  // drawn against the endpoints currently loaded, and which sentence it has
  // earned. Handed the UNFILTERED endpoints, because a search that hides the
  // row must not hide the once-only secret that belongs to it.
  const secret = useInboundShownOnceSecret(
    endpoints,
    INBOUND_ROTATION_GRACE_HOURS,
  );
  // Pulled out as its own binding so the rotate callback below can depend on
  // the STABLE hand-off rather than on `secret`, whose identity changes with
  // every render (see the dependency note there).
  const { onRotated } = secret;

  // Copy / share the public URL. Extracted to a hook by responsibility when
  // the trigger-rules sheet was mounted below, to stay inside the budget.
  const { onCopyUrl, onShareUrl } = useInboundUrlHandoff();

  const onToggleEnabled = useCallback(
    async (row: InboundWebhookRow) => {
      const label = row.name || row.slug;
      if (row.enabled) {
        const ok = await confirm({
          title: `Disable ${label}?`,
          message: DISABLE_CONSEQUENCE,
          confirmLabel: "Disable",
        });
        if (!ok) return;
      }
      setPendingId(row.id);
      try {
        await actions.setEnabled.mutateAsync({
          id: row.id,
          enabled: !row.enabled,
        });
        trackCommerceAction("webhook_manage", "success");
        toast({
          kind: "success",
          message: row.enabled ? "Endpoint disabled." : "Endpoint enabled.",
        });
      } catch (err) {
        trackCommerceAction("webhook_manage", "failure");
        toast({ kind: "error", message: describe(err, "Couldn't update the endpoint.") });
      } finally {
        setPendingId(null);
      }
    },
    [actions.setEnabled, confirm, toast],
  );

  const onRotate = useCallback(
    async (row: InboundWebhookRow) => {
      const label = row.name || row.slug;
      const ok = await confirm({
        title: `Rotate the secret for ${label}?`,
        message: ROTATE_CONSEQUENCE,
        confirmLabel: "Rotate",
        destructive: true,
        confirmPhrase: "ROTATE",
      });
      if (!ok) return;
      setPendingId(row.id);
      try {
        const result = await actions.rotate.mutateAsync(row.id);
        // Hand it over BEFORE anything else can unmount this tree — the secret
        // is returned exactly once and this component no longer owns it.
        onRotated(result.endpointId, result.secret);
        trackCommerceAction("webhook_manage", "success");
        toast({ kind: "success", message: "Secret rotated. Save the new one." });
      } catch (err) {
        trackCommerceAction("webhook_manage", "failure");
        toast({ kind: "error", message: describe(err, "Couldn't rotate the secret.") });
      } finally {
        setPendingId(null);
      }
    },
    // `onRotated`, NOT `secret`: the hook returns a fresh object every render
    // (its `visible`/`copy` legitimately change), so depending on the whole
    // thing would give `onRotate` a new identity each time — and through
    // `rotate` and `renderEndpoint` that is exactly the VirtualizedList cell
    // memoisation the comment below exists to protect. The hand-off itself is
    // a stable useCallback.
    [actions.rotate, confirm, onRotated, toast],
  );

  // The row's handlers are synchronous by contract and these two are async, so
  // each call site used to wrap them in `(target) => void handler(target)` —
  // inside `renderItem`, which meant two fresh closures per row per render on
  // top of the fresh `renderItem` itself. Wrapped once, here.
  const toggleEnabled = useCallback(
    (row: InboundWebhookRow) => void onToggleEnabled(row),
    [onToggleEnabled],
  );
  const rotate = useCallback(
    (row: InboundWebhookRow) => void onRotate(row),
    [onRotate],
  );
  const keyExtractor = useCallback(
    (row: InboundWebhookRow, index: number) =>
      row.id || row.slug || `row-${index}`,
    [],
  );
  // Hoisted for the reason in the finding: a new `renderItem` identity on
  // every render defeats VirtualizedList's cell memoization, so every
  // keystroke in the search field above re-rendered every mounted endpoint.
  const renderEndpoint = useCallback<ListRenderItem<InboundWebhookRow>>(
    ({ item: row }) => (
      <>
        <InboundEndpointRow
          row={row}
          pending={pendingId === row.id}
          busy={busy}
          onCopyUrl={onCopyUrl}
          onShareUrl={onShareUrl}
          onToggleEnabled={toggleEnabled}
          onOpenEvents={setOpenEvents}
          onRotate={rotate}
        />
        {/* The rules acting on this endpoint's events; a setter, not a closure. */}
        <InboundTriggerRulesLink endpoint={row} onPress={setOpenTriggers} />
        {/* Rename and delete: admin-only, never offered offline, and delete
            behind a typed phrase — the row's reversible levers stay above. */}
        <InboundEndpointAdminActions endpoint={row} />
      </>
    ),
    [busy, onCopyUrl, onShareUrl, pendingId, rotate, toggleEnabled],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Inbound webhooks"
        subtitle={
          hooks.isLoading || hooks.isError ? undefined : plural(total, "endpoint")
        }
        onBack={goBackOrMore}
        right={
          <InboundEndpointCreateControl
            onCreated={secret.onCreated}
            secretShown={secret.visible}
          />
        }
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search endpoints…"
          accessibilityLabel="Search endpoints"
          resultCount={debouncedQ.trim() ? rows.length : undefined}
          resultNoun="endpoint"
        />
      </View>
      <FlatList
        // Drag-to-dismiss: this screen has a search field, so the keyboard covers
        // roughly half the viewport and nothing else here closes it.
        keyboardDismissMode="on-drag"
        data={rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        refreshControl={
          // The shared isRefetching idiom. The hand-rolled `refreshing` state
          // this replaces also set state after an unmount on a fast back-out.
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListHeaderComponent={
          (hooks.isError && hasCachedRows) || secret.visible ? (
            <View style={{ gap: 10, marginBottom: 12 }}>
              {/* Soft failure: a refetch errored but cached rows are still on
                  screen — the empty-state error branch below won't fire, so
                  this slim banner keeps the staleness from being silent. */}
              {hooks.isError && hasCachedRows ? (
                <StaleDataBanner onRetry={() => void hooks.refetch()} />
              ) : null}
              {secret.visible && secret.endpointId ? (
                <WebhookSecretCard
                  revision={secret.revision}
                  expectedId={secret.endpointId}
                  {...secret.copy}
                  onDismiss={secret.onDismiss}
                />
              ) : null}
            </View>
          ) : null
        }
        ListEmptyComponent={
          // The five-state ladder lives in QueryStates, not here: error before
          // empty, skeleton only on a FIRST load, and "no endpoints" reserved
          // for a fetch that genuinely succeeded and returned nothing. A
          // refetch that failed while cached rows are still held is NOT an
          // error state — the StaleDataBanner above owns that case — so the
          // isError this hands down is narrowed to "failed with nothing to
          // show". `isEmpty` is the UNFILTERED count, so children below cover
          // the "loaded fine, the search hides them all" case.
          <QueryStates
            query={{
              isError: hooks.isError && !hasCachedRows,
              isLoading: hooks.isLoading,
              isPending: hooks.isPending,
              isPaused: hooks.isPaused,
              error: hooks.error,
              refetch: hooks.refetch,
            }}
            isEmpty={!hasCachedRows}
            skeleton={<SkeletonList rows={5} />}
            gate={offlineGate}
            offlineMessage={"Inbound endpoints need a connection. Nothing has been loaded on this device yet."}
            empty={{
              title: "No inbound endpoints",
              // This used to send the operator to the web admin, which is no
              // longer true and was the only place the screen still said so.
              // "New" is in the header, and admin-only — which is why the
              // sentence points at it rather than promising anyone can.
              description:
                "An inbound endpoint gives you a URL to paste into Stripe, GitHub, Shopify and the like. An admin can mint one here with New — Moosewave returns its signing secret once, on this screen.",
            }}
          >
            <EmptyState
              title="Nothing matches"
              description={`No endpoints match "${debouncedQ}".`}
            />
          </QueryStates>
        }
        ListFooterComponent={hasCachedRows ? <OutboundCrossLink /> : null}
        renderItem={renderEndpoint}
      />

      <InboundEventsSheet
        endpoint={openEvents}
        onClose={() => setOpenEvents(null)}
      />
      <InboundTriggerRulesSheet endpoint={openTriggers} onClose={() => setOpenTriggers(null)} />
    </SafeAreaView>
  );
}

/** Prefer the server's own message — it names the repair — over generic copy. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Webhooks are ONE subject to an operator; mobile splits them across two
 * routes because receiving and sending have different shapes on a phone.
 * Desktop merged them into a tabbed shell (WebhooksHome). The phone can't
 * afford that, so each half names the other instead of leaving "events aren't
 * flowing" to a guess about which screen to open.
 */
function OutboundCrossLink() {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.push("/(tabs)/webhooks")}
      accessibilityRole="link"
      accessibilityLabel="Open webhook health, the outbound half: delivery failures, replay and re-enable"
      style={{
        marginTop: 4,
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
        {`Sending events out instead? Webhook health ${forwardArrow()}`}
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
        Outbound delivery failures, replay and re-enable live there.
      </Text>
    </Pressable>
  );
}
