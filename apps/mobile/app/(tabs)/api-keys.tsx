/**
 * API keys — see what can reach this workspace, and kill anything that leaked.
 *
 * A key gets committed to a public repo on a Saturday. Revoking it is the most
 * time-critical security action a workspace owner ever performs, and until now
 * it required opening a laptop: mobile had no API-key surface at all.
 *
 * SCOPE, DELIBERATELY NARROW. This screen lists and revokes. It does not create
 * (a 13-scope matrix, IP allow-lists and rate limits — and scopes are fixed at
 * creation, so a mis-tap is permanent) and it does not rotate (rotation returns
 * the new plaintext exactly once, and the phone has no hardened
 * capture-then-dismiss ceremony for a reveal-once secret today). Both stay on
 * desktop; the emergency action ships here.
 *
 * Revoke is gated by typing the key's prefix. That is not a speed bump: the
 * prefix is the only part of the key still visible, so typing it is a real
 * check that you are killing the key you meant to.
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
import { InactiveKeysCard } from "@/components/api-keys/InactiveKeysCard";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill, type PillTone } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { SwipeableRow } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import { useApiKeys, useRevokeApiKey } from "@/hooks/useApiKeys";
import type { ApiKeySummary } from "@/hooks/useApiKeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { apiKeyState, isHighRiskKey, sortApiKeys } from "@/lib/apiKeyRows";
import { FONT } from "@/lib/fonts";
import { dateTime, plural, relativeTime } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const STATE_TONE: Record<string, PillTone> = {
  revoked: "neutral",
  expired: "warning",
  sandbox: "info",
  live: "success",
};

export default function ApiKeys() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  useScreenViewed("api-keys");

  const keys = useApiKeys();
  const revoke = useRevokeApiKey();
  const refresh = useRefreshControl(keys);

  // Array.isArray, not `?? []`: a TRUTHY non-array payload passes the nullish
  // guard and then `sortApiKeys` spreads it, throwing "Invalid attempt to spread
  // non-iterable instance" and taking the whole screen down. `listApiKeys`
  // returns an array today, so this is reachable only from a restored persisted
  // cache written by an older shape — which is exactly how MaintenanceBanner
  // shipped its "windows.find is not a function" crash in this repo.
  const rows = useMemo(
    () => sortApiKeys(Array.isArray(keys.data) ? keys.data : []),
    [keys.data],
  );
  const liveCount = useMemo(
    () => rows.filter((k) => !k.revokedAt).length,
    [rows],
  );

  const onRevoke = useCallback(async (key: ApiKeySummary) => {
    const ok = await confirm({
      title: `Revoke ${key.label}?`,
      message:
        "Any script, agent or integration using this key stops working immediately. Revocation cannot be undone — issue a new key instead.",
      consequence: key.lastUsedAt
        ? `This key was last used ${relativeTime(key.lastUsedAt)}.`
        : "This key has never been used.",
      confirmLabel: "Revoke",
      destructive: true,
      ...(key.prefix ? { confirmPhrase: key.prefix } : {}),
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync(key.id);
      toast({ kind: "success", message: `${key.label} revoked.` });
    } catch (err) {
      toast({
        kind: "error",
        message:
          err instanceof Error && err.message
            ? err.message
            : "Couldn't revoke that key.",
      });
    }
  }, [confirm, revoke, toast]);

  // Hoisted out of the FlatList. An inline `renderItem` is a fresh function
  // every render, which VirtualizedList treats as a changed row renderer and
  // re-renders every mounted cell; `KeyRow` now takes the key it acts on so
  // the per-row `() => void onRevoke(row)` thunk disappears with it.
  const revokeRow = useCallback(
    (key: ApiKeySummary) => void onRevoke(key),
    [onRevoke],
  );
  const keyExtractor = useCallback((row: ApiKeySummary) => row.id, []);
  const renderKey = useCallback<ListRenderItem<ApiKeySummary>>(
    ({ item: row }) => (
      <KeyRow apiKey={row} busy={revoke.isPending} onRevoke={revokeRow} />
    ),
    [revoke.isPending, revokeRow],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="API keys"
        {...(keys.data !== undefined
          ? { subtitle: `${plural(liveCount, "active key")}` }
          : {})}
        onBack={goBackOrMore}
      />
      <FlatList
        data={keys.data === undefined ? [] : rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{
          padding: 16,
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
        // Dormant-key alerts sit above the roster so the keys worth revoking
        // are named before the list of everything that could be. The card
        // renders nothing at all when there is nothing to alert about.
        ListHeaderComponent={<InactiveKeysCard />}
        ListEmptyComponent={
          <QueryStates
            query={keys}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so API keys can't be listed — and a revoke would not reach the server. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={4} />}
            empty={{
              title: "No API keys",
              description:
                "Nothing can reach this workspace through the API. Create keys from the web admin.",
            }}
          >
            <View />
          </QueryStates>
        }
        renderItem={renderKey}
      />
    </SafeAreaView>
  );
}

function KeyRow({
  apiKey,
  busy,
  onRevoke,
}: {
  apiKey: ApiKeySummary;
  busy: boolean;
  /** Called with THIS key, so the list needs no per-row thunk. */
  onRevoke: (key: ApiKeySummary) => void;
}) {
  const { t } = useTheme();
  const state = apiKeyState(apiKey);
  const revoked = state === "revoked";
  const highRisk = isHighRiskKey(apiKey);
  const used = apiKey.lastUsedAt
    ? `Last used ${relativeTime(apiKey.lastUsedAt)}`
    : "Never used";
  const usedSpoken = apiKey.lastUsedAt
    ? `Last used ${dateTime(apiKey.lastUsedAt)}`
    : "Never used";

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
              color: revoked ? t.fgMuted : t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
            numberOfLines={1}
          >
            {apiKey.label}
          </Text>
          <Pill label={state} tone={STATE_TONE[state] ?? "neutral"} />
        </View>

        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("numeric"),
            fontFamily: "Menlo",
            marginTop: 6,
          }}
          numberOfLines={1}
        >
          {apiKey.prefix || "—"}
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
          {used}
          {apiKey.actorType === "agent"
            ? ` · agent${apiKey.actorLabel ? ` (${apiKey.actorLabel})` : ""}`
            : ""}
        </Text>

        <Text
          {...typeCap("label")}
          style={{
            color: highRisk ? t.warning : t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
          numberOfLines={2}
        >
          {apiKey.scopes.length > 0 ? apiKey.scopes.join(", ") : "No scopes"}
        </Text>
      </Card>
    </View>
  );

  const spoken = `${apiKey.label}, ${state}${
    highRisk ? ", can write or send" : ""
  }. Prefix ${apiKey.prefix || "unknown"}. ${usedSpoken}. Scopes: ${
    apiKey.scopes.join(", ") || "none"
  }.`;

  if (revoked) {
    // Nothing left to do to a revoked key — do not offer an action that no-ops.
    return (
      <View accessible accessibilityLabel={spoken}>
        {body}
      </View>
    );
  }

  return (
    <SwipeableRow
      right={[
        { label: "Revoke", kind: "danger", onPress: () => onRevoke(apiKey) },
      ]}
      accessibilityLabel={spoken}
      enabled={!busy}
    >
      {body}
    </SwipeableRow>
  );
}
