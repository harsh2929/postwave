/**
 * Agent mandates — see what your agents are allowed to do, and end it.
 *
 * A mandate is the bound a PERSON puts on an agent: these actions, on these
 * resources, this many times, until this moment. The server is explicit that a
 * mandate an agent could issue to itself would not be a bound at all, which is
 * why the whole surface is session-only.
 *
 * Until this screen, no client existed on ANY surface — not web, not desktop,
 * not the SDK. The governance capability the platform leads with was reachable
 * only by hand-rolled HTTP.
 *
 * ── SCOPE, DELIBERATELY NARROW ─────────────────────────────────────────────
 * Lists and revokes. It does not MINT: creation returns the bearer token
 * exactly once, and mobile has no hardened capture-then-dismiss ceremony for a
 * reveal-once secret — the same reasoning that keeps API-key rotate off this
 * platform. Granting stays at a desk; withdrawing ships here, because "this
 * agent is doing something I did not intend" happens away from one.
 *
 * ── WHY THERE IS NO TYPE-TO-CONFIRM GATE ───────────────────────────────────
 * `api-keys.tsx` makes you type the key prefix, because revoking the wrong key
 * breaks a live integration. Revoking a mandate moves in the SAFE direction: it
 * REMOVES an agent's authority. Adding friction to the safe act would mean an
 * operator hesitating over the thing we want them to be able to do instantly.
 * A plain destructive confirm, carrying the consequence sentence, is the right
 * weight.
 *
 * Revoked and expired mandates stay in the list on purpose — "what was this
 * agent allowed to do an hour ago" is the same question asked after the fact.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useMemo } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill, type PillTone } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { SwipeableRow } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import { useAgentMandates, useRevokeAgentMandate } from "@/hooks/useAgentMandates";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  liveMandateCount,
  mandateIsRevocable,
  mandateScopeSentence,
  mandateState,
  sortMandates,
  toMandate,
  type AgentMandateLike,
} from "@/lib/agentMandates";
import { FONT } from "@/lib/fonts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { dateTime, plural, relativeTime } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const STATE_TONE: Record<string, PillTone> = {
  revoked: "neutral",
  expired: "neutral",
  exhausted: "warning",
  active: "success",
};

export default function AgentMandates() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  useScreenViewed("agent-mandates");

  // Reading the mandate roster is viewer-floored on purpose — see the nav row.
  // Revoking is admin, so the action is gated here rather than by hiding the
  // whole screen from the people most likely to notice an agent misbehaving.
  const mayRevoke = canAccessMinimumRole("admin", gate.effectiveRole);
  const mandates = useAgentMandates();
  const revoke = useRevokeAgentMandate();
  const refresh = useRefreshControl(mandates);

  // Array.isArray, not `?? []`. The nullish guard catches undefined and null
  // and nothing else, so a truthy non-array — a paged `{items:[]}` envelope, a
  // `{}` from a proxy that answered the wrong shape — walked straight into
  // `.map` and took the whole governance screen down with "map is not a
  // function". This hook does not parse its payload, so the screen must.
  const rows = useMemo(
    () =>
      sortMandates(
        (Array.isArray(mandates.data) ? mandates.data : []).map(toMandate),
      ),
    [mandates.data],
  );
  const live = useMemo(() => liveMandateCount(rows), [rows]);

  const onRevoke = useCallback(
    async (mandate: AgentMandateLike) => {
      const ok = await confirm({
        title: `Revoke "${mandate.purpose}"?`,
        message:
          "The agent loses this authority immediately. Anything it was part-way through stops.",
        consequence: mandate.lastUsedAt
          ? `Last used ${relativeTime(mandate.lastUsedAt)}. Revoking cannot be undone — a replacement must be granted from a desk.`
          : "Never used. Revoking cannot be undone — a replacement must be granted from a desk.",
        confirmLabel: "Revoke",
        destructive: true,
      });
      if (!ok) return;
      try {
        await revoke.mutateAsync(mandate.id);
        toast({ kind: "success", message: `${mandate.purpose} revoked.` });
      } catch (err) {
        toast({
          kind: "error",
          message:
            err instanceof Error && err.message
              ? err.message
              : "Couldn't revoke that mandate.",
        });
      }
    },
    [confirm, revoke, toast],
  );

  // Hoisted for the same reason api-keys.tsx hoists its renderer: an inline
  // `renderItem` is a fresh function every render, which VirtualizedList treats
  // as a changed row renderer and re-renders every mounted cell.
  const revokeRow = useCallback(
    (mandate: AgentMandateLike) => void onRevoke(mandate),
    [onRevoke],
  );
  const keyExtractor = useCallback((row: AgentMandateLike) => row.id, []);
  const renderRow = useCallback<ListRenderItem<AgentMandateLike>>(
    ({ item: row }) => (
      <MandateRow
        mandate={row}
        busy={revoke.isPending}
        canRevoke={mayRevoke}
        onRevoke={revokeRow}
      />
    ),
    [mayRevoke, revoke.isPending, revokeRow],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Agent mandates"
        {...(mandates.data !== undefined
          ? { subtitle: plural(live, "active mandate") }
          : {})}
        onBack={goBackOrMore}
      />
      {mayRevoke ? null : (
        <MobileScopeNotice
          title="Read-only for your role"
          body="Withdrawing a mandate needs an admin role on this workspace. Seeing what agents are permitted to do does not."
        />
      )}
      <FlatList
        data={mandates.data === undefined ? [] : rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{ padding: 16, paddingBottom: 32, flexGrow: 1 }}
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
            query={mandates}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so mandates can't be listed — and a revoke would not reach the server. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={4} />}
            empty={{
              title: "No mandates granted",
              description:
                "No agent currently holds delegated authority in this workspace. Mandates are granted from the web admin.",
            }}
          >
            <View />
          </QueryStates>
        }
        renderItem={renderRow}
      />
    </SafeAreaView>
  );
}

function MandateRow({
  mandate,
  busy,
  canRevoke,
  onRevoke,
}: {
  mandate: AgentMandateLike;
  busy: boolean;
  /** False below admin: DELETE is ScopeAdmin server-side. */
  canRevoke: boolean;
  /** Called with THIS mandate, so the list needs no per-row thunk. */
  onRevoke: (mandate: AgentMandateLike) => void;
}) {
  const { t } = useTheme();
  const state = mandateState(mandate);
  const dead = state !== "active";
  const scope = mandateScopeSentence(mandate);
  const used = mandate.lastUsedAt
    ? `Last used ${relativeTime(mandate.lastUsedAt)}`
    : "Never used";
  const usedSpoken = mandate.lastUsedAt
    ? `Last used ${dateTime(mandate.lastUsedAt)}`
    : "Never used";
  const budget =
    state === "active"
      ? `${plural(mandate.usesRemaining, "use")} left`
      : state === "exhausted"
        ? "No uses left"
        : state;

  const body = (
    <View style={{ marginBottom: 8 }}>
      <Card>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: dead ? t.fgMuted : t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
            numberOfLines={2}
          >
            {mandate.purpose}
          </Text>
          <Pill label={state} tone={STATE_TONE[state] ?? "neutral"} />
        </View>

        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
          numberOfLines={3}
        >
          {scope}
        </Text>

        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {`${used} · ${budget}`}
        </Text>
      </Card>
    </View>
  );

  const spoken = `${mandate.purpose}, ${state}. Grants ${scope} ${usedSpoken}. ${budget}.`;

  if (!canRevoke || !mandateIsRevocable(mandate)) {
    // Nothing left to withdraw — do not offer an action that no-ops.
    return (
      <View accessible accessibilityLabel={spoken}>
        {body}
      </View>
    );
  }

  return (
    <SwipeableRow
      right={[
        { label: "Revoke", kind: "danger", onPress: () => onRevoke(mandate) },
      ]}
      accessibilityLabel={spoken}
      enabled={!busy}
    >
      {body}
    </SwipeableRow>
  );
}
