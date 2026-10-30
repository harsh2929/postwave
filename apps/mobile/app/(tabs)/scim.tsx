/**
 * SCIM — provisioning tokens and role mappings.
 *
 * No longer read-only. The screen kept saying "revoke from desktop", which
 * is the wrong answer for the one scenario a phone is for: someone tells you
 * a provisioning bearer leaked while you are away from a laptop. A SCIM
 * token can create and deprovision workspace users, so revoke is now here,
 * behind a type-the-prefix confirm. Minting and rotating — which need the
 * one-shot secret to be captured somewhere safe — deliberately stay on
 * desktop.
 *
 * The IdP-facing base URL is shown too: it is the value you are asked for
 * during an IdP setup call, and it was previously unreachable from the app.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  Share,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { isPausedFirstFetch, QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { MappingEditSheet } from "@/components/scim/MappingEditSheet";
import {
  ScimMappingCard,
  ScimTextAction,
} from "@/components/scim/ScimMappingCard";
import { ScimTokenCard } from "@/components/scim/ScimTokenCard";
import { ScimBaseUrlCard } from "@/components/scim/ScimBaseUrlCard";
import {
  ScimFreshness,
  ScimMetric,
} from "@/components/scim/ScimHeaderStrip";
import { goBackOrMore } from "@/lib/nav";
import {
  useMobileScimRoleMappings,
  useMobileScimTokens,
} from "@/hooks/useScimOps";
import { useRevokeScimToken } from "@/hooks/useGovernanceOps";
import { useDeleteScimMapping } from "@/hooks/useScimMappingOps";
import { scimDeleteConsequence } from "@/lib/scimMappingPolicy";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { governanceActionErrorMessage } from "@/lib/governanceActionPolicy";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { useTheme } from "@/lib/theme";
import type {
  MobileScimRoleMapping,
  MobileScimTokenInfo,
} from "@/api/client";
import { governanceEmptyCopy } from "@/lib/governanceEmptyStates";

export { AppErrorBoundary as ErrorBoundary };

export default function Scim() {
  const { t } = useTheme();
  useScreenViewed("scim");
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const tokens = useMobileScimTokens();
  const mappings = useMobileScimRoleMappings();
  const revoke = useRevokeScimToken();
  const deleteMapping = useDeleteScimMapping();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // null = closed; `initial: null` inside = the "new mapping" form.
  const [mappingSheet, setMappingSheet] = useState<{
    initial: { groupName: string; role: string; precedence: number } | null;
  } | null>(null);
  // Dormancy ages are read off a clock; a screen left open should not keep
  // claiming "Idle 29d" the morning after. Gated on focus because Expo Router
  // keeps unfocused tabs MOUNTED, and MINUTE resolution because relativeTime
  // plus a day-scale dormancy threshold is all the clock reaches here: 59 of
  // every 60 ticks used to re-render this screen and every memoised row on it
  // to repaint an identical string. Measured 60 renders/min → 1. See
  // useTickingNow for the trade-off, and for where minutes are NOT acceptable.
  const focused = useIsFocused();
  const now = useTickingNow(focused, MINUTE_MS);

  const tokenRows = Array.isArray(tokens.data) ? tokens.data : [];
  const mappingRows = Array.isArray(mappings.data) ? mappings.data : [];
  const activeTokens = tokenRows.filter((tkn) => !tkn.revoked_at).length;
  const revokedTokens = tokenRows.length - activeTokens;
  // A failed fetch must not masquerade as a successful "0" summary.
  const tokensFailed = tokens.isError && tokens.data === undefined;
  const mappingsFailed = mappings.isError && mappings.data === undefined;
  // Offline / still-validating cached session: the online gate is closed so the
  // queries stay disabled and never fetch (isLoading/isError both false, data
  // undefined). With no cached rows that is NOT a genuine "0 tokens /
  // unconfigured tenant" result — distinguish it so an admin doesn't conclude
  // SSO provisioning is missing. Cached rows (length > 0) still render normally.
  // A first fetch TanStack PAUSED is the same unknown with the gate open: the
  // gate is auth state, and a validated session that lost signal keeps it.
  const tokensOffline =
    (!gate.enabled || isPausedFirstFetch(tokens)) && tokenRows.length === 0;
  const mappingsOffline =
    (!gate.enabled || isPausedFirstFetch(mappings)) && mappingRows.length === 0;

  const refresh = useManualRefresh([tokens.refetch, mappings.refetch], {
    enabled: gate.enabled,
  });

  const onShareToken = useCallback((token: MobileScimTokenInfo) => {
    void Share.share({
      message: `Moosewave SCIM token ${token.description || ""} prefix: ${
        token.prefix || "unknown"
      }`,
    }).catch(() => {
      /* the sheet was dismissed — nothing to report */
    });
  }, []);

  const onRevoke = useCallback(
    async (token: MobileScimTokenInfo) => {
      const label = token.description || "this SCIM token";
      const phrase = token.prefix || "";
      const ok = await confirm({
        title: `Revoke ${label}?`,
        message:
          "Your identity provider will immediately stop being able to create, update or deprovision users through this token.",
        confirmLabel: "Revoke",
        destructive: true,
        consequence:
          "This cannot be undone. Mint a replacement from the web admin before re-pointing your IdP.",
        ...(phrase ? { confirmPhrase: phrase } : {}),
      });
      if (!ok) return;
      setRevokingId(token.id);
      try {
        await revoke.mutateAsync(token.id);
        // The outcome lands in the hand at the same moment it lands on the
        // screen — a revoke is irreversible, so "it went through" should not
        // depend on the toast still being on screen when you look back.
        haptics.success();
        toast({ kind: "success", message: `Revoked ${label}.` });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message: governanceActionErrorMessage("revoke_scim_token", err),
        });
      } finally {
        setRevokingId(null);
      }
    },
    [confirm, revoke, toast],
  );

  const onDeleteMapping = useCallback(
    async (mapping: MobileScimRoleMapping) => {
      const ok = await confirm({
        title: `Delete the ${mapping.group_name === "*" ? "catch-all" : `“${mapping.group_name}”`} mapping?`,
        message: scimDeleteConsequence(mapping.group_name, mapping.role),
        confirmLabel: "Delete mapping",
        destructive: true,
      });
      if (!ok) return;
      haptics.tap();
      deleteMapping.mutate(mapping.id, {
        onSuccess: () =>
          toast({ kind: "success", message: "Role mapping deleted." }),
        onError: (err) =>
          toast({
            kind: "error",
            message:
              (err as { status?: number }).status === 403
                ? "Only an owner or admin can change role mappings."
                : (err as Error).message ||
                  "The mapping could not be deleted.",
          }),
      });
    },
    [confirm, deleteMapping, toast],
  );

  // Hoisted: an inline `renderItem` is a fresh function every render, which
  // VirtualizedList reads as a changed row renderer and re-renders every
  // mounted card — and `now` ticks on a timer here, so that is once a second.
  const revokeToken = useCallback(
    (token: MobileScimTokenInfo) => void onRevoke(token),
    [onRevoke],
  );
  const keyExtractor = useCallback(
    (token: MobileScimTokenInfo) => token.id,
    [],
  );
  const renderToken = useCallback<ListRenderItem<MobileScimTokenInfo>>(
    ({ item }) => (
      <ScimTokenCard
        token={item}
        now={now}
        busy={revokingId === item.id}
        canAct={gate.enabled}
        onRevoke={revokeToken}
        onShare={onShareToken}
      />
    ),
    [gate.enabled, now, onShareToken, revokeToken, revokingId],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="SCIM" onBack={goBackOrMore} />
      {/* A FlatList, not a ScrollView: this and audit-sinks were the only two
          governance screens rendering an unbounded list with no windowing at
          all, and a tenant whose IdP has churned through provisioning tokens
          mounts every card at once. The tokens are the virtualised data; the
          header and the (much shorter, precedence-ordered) role mappings ride
          along as header/footer. */}
      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        style={{ flex: 1 }}
        data={tokenRows}
        keyExtractor={keyExtractor}
        renderItem={renderToken}
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
        ListHeaderComponent={
          <View>
            <MobileScopeNotice body="Review token health, revoke a leaked token, and check role mappings here. Minting and rotating tokens stays on desktop — the secret is revealed once and needs somewhere safe to land." />

            <ScimBaseUrlCard baseUrl={gate.baseUrl} />

            <View style={{ flexDirection: "row", gap: 8 }}>
              <ScimMetric
                label="Active tokens"
                value={tokensFailed || tokensOffline ? null : activeTokens}
                hint={
                  !tokensFailed && !tokensOffline && revokedTokens > 0
                    ? `${num(revokedTokens)} revoked`
                    : undefined
                }
              />
              <ScimMetric
                label="Mappings"
                value={
                  mappingsFailed || mappingsOffline ? null : mappingRows.length
                }
              />
            </View>
            <ScimFreshness
              stamps={[tokens.dataUpdatedAt, mappings.dataUpdatedAt]}
              now={now}
            />
            <SectionLabel>Provisioning tokens</SectionLabel>
          </View>
        }
        // The five-state ladder is the shared one: error before empty,
        // offline-with-nothing-cached as its own message, skeleton on a FIRST
        // load only. `isError` is narrowed to "failed AND nothing cached" so a
        // flaky refetch keeps the cards on screen.
        ListEmptyComponent={
          <QueryStates
            query={{
              isError: tokensFailed,
              isLoading: tokens.isLoading,
              isPending: tokens.isPending,
              isPaused: tokens.isPaused,
              error: tokens.error,
              refetch: tokens.refetch,
            }}
            gate={gate}
            isEmpty
            skeleton={<SkeletonList rows={2} lines={2} label="Loading SCIM tokens" />}
            offlineMessage="Reconnect to load SCIM tokens. Revoking a token is never queued for later — it has to reach the server now."
            // Shared governance copy (GOVERNANCE#30): "No SCIM tokens" restated
            // the empty list to an admin who may not know what a provisioning
            // token IS. The shared entry says what it does and where it comes
            // from, in the same voice as Audit, Approvals, Sinks and Agency.
            empty={governanceEmptyCopy("scimTokens")}
          >
            {null}
          </QueryStates>
        }
        ListFooterComponent={
          <View>
            <SectionLabel
              right={
                gate.enabled ? (
                  <ScimTextAction
                    label="Add mapping"
                    accessibilityLabel="Add a role mapping"
                    strong
                    onPress={() => setMappingSheet({ initial: null })}
                  />
                ) : undefined
              }
            >
              Role mappings
            </SectionLabel>
        <QueryStates
          query={{
            isError: mappingsFailed,
            isLoading: mappings.isLoading,
            isPending: mappings.isPending,
            isPaused: mappings.isPaused,
            error: mappings.error,
            refetch: mappings.refetch,
          }}
          gate={gate}
          isEmpty={mappingRows.length === 0}
          skeleton={<SkeletonList rows={2} lines={1} label="Loading role mappings" />}
          offlineMessage="Reconnect to load role mappings."
          empty={governanceEmptyCopy("scimMappings")}
        >
              {mappingRows.map((mapping) => (
                <ScimMappingCard
                  key={mapping.id}
                  mapping={mapping}
                  canAct={gate.enabled && !deleteMapping.isPending}
                  onEdit={() =>
                    setMappingSheet({
                      initial: {
                        groupName: mapping.group_name,
                        role: mapping.role,
                        precedence: mapping.precedence,
                      },
                    })
                  }
                  onDelete={() => void onDeleteMapping(mapping)}
                />
              ))}
            </QueryStates>
          </View>
        }
      />
      <MappingEditSheet
        visible={mappingSheet !== null}
        initial={mappingSheet?.initial ?? null}
        onClose={() => setMappingSheet(null)}
      />
    </SafeAreaView>
  );
}

