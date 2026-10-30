/**
 * Custom domains — the phone-side DNS setup loop.
 *
 * What this screen answers, and what it could not before:
 *  - "Did DNS propagate yet?" — one boolean pill became per-mechanism
 *    SPF/DKIM/DMARC state from GET /api/v1/dns-health, so "DKIM published,
 *    DMARC missing" is distinguishable from "nothing published".
 *  - "Is this domain still trusted?" — sender reputation is fetched alongside
 *    and rendered as a grade + score, exactly as desktop does.
 *  - "What is the DKIM value?" — the record card expands to the full string;
 *    it used to be clipped at three lines with no way to read the rest.
 *  - "Can I set this up without a laptop?" — add and remove now exist.
 *
 * Both side-signals are tracked SEPARATELY (desktop's D10 lesson): when DNS
 * health fails to load the row renders "—" plus an explicit notice, never an
 * implied "not configured".
 */
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Share, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ChipRow } from "@/components/ChipRow";
import { useConfirm } from "@/components/ConfirmSheet";
import { AddDomainSheet } from "@/components/deliverability/AddDomainSheet";
import {
  CachedNotice,
  type CachedNoticeProps,
} from "@/components/deliverability/CachedNotice";
import { DomainRowCard } from "@/components/deliverability/DomainRowCard";
import { DomainsHeaderActions } from "@/components/deliverability/DomainsHeaderActions";
import { ArchiveDomainCard } from "@/components/settings/ArchiveDomainCard";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { SwipeableRow } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import { useDnsHealth, useSenderReputation } from "@/hooks/useDeliverability";
import {
  useCreateCustomDomain,
  useCustomDomains,
  useDeleteCustomDomain,
  useVerifyCustomDomain,
  type CustomDomain,
} from "@/hooks/useDomainOps";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  indexByDomain,
  writeFailureMessage,
} from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { msg, pluralMsg } from "@/lib/i18n";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

type FilterKey = "all" | "pending" | "verified";

/**
 * Built per render rather than at module scope: `msg()` reads the ACTIVE
 * catalogue, and a module-level constant would freeze whichever locale
 * happened to be live at import time.
 */
function filterOptions(): readonly { value: FilterKey; label: string }[] {
  return [
    { value: "all", label: msg("customDomains.filter.all") },
    { value: "pending", label: msg("customDomains.filter.pending") },
    { value: "verified", label: msg("customDomains.filter.verified") },
  ];
}

export default function CustomDomains() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const now = useNowTicker();
  useScreenViewed("custom-domains");

  const domains = useCustomDomains();
  const health = useDnsHealth();
  const reputation = useSenderReputation();
  const verify = useVerifyCustomDomain();
  const create = useCreateCustomDomain();
  const remove = useDeleteCustomDomain();
  const refresh = useManualRefresh([
    domains.refetch,
    health.refetch,
    reputation.refetch,
  ]);

  const mode = useAuthStore((s) => s.mode);
  const canWrite = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const [filter, setFilter] = useState<FilterKey>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // `verify` is one shared mutation, so its `variables` only reflect the most
  // recent call — deriving per-row progress from it clears one row's spinner
  // while its request is still running. Track in-flight ids locally.
  const [verifyingIds, setVerifyingIds] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);

  // Memoised because the `?? []` fallback allocates a NEW array every render
  // while the query is pending, which invalidates both memos below on every
  // single render — they'd re-filter the whole domain list for nothing.
  const all = useMemo(() => (Array.isArray(domains.data?.value) ? domains.data?.value : []), [domains.data]);
  const healthByDomain = useMemo(
    () => indexByDomain(health.data ?? []),
    [health.data],
  );
  const reputationByDomain = useMemo(
    () => indexByDomain(reputation.data ?? []),
    [reputation.data],
  );

  const rows = useMemo(() => {
    if (filter === "verified") return all.filter((r) => r.verified);
    if (filter === "pending") return all.filter((r) => !r.verified);
    return all;
  }, [all, filter]);

  const subtitle = useMemo(() => {
    if (all.length === 0) return undefined;
    const verified = all.filter((r) => r.verified).length;
    return pluralMsg("customDomains.subtitle", all.length, { verified });
  }, [all]);

  // Whole sentences per outcome rather than `sideSignalNotice(noun, …)`, which
  // glues a noun onto a fixed English frame. Same two outcomes as before.
  const healthNotice = !health.isError
    ? null
    : gate.enabled
      ? msg("customDomains.health.failed")
      : msg("customDomains.health.offline");

  const onVerify = useCallback(
    (row: CustomDomain) => {
      setVerifyingIds((prev) => ({ ...prev, [row.id]: true }));
      verify
        .mutateAsync(row.id)
        .then((res) => {
          const ok = Boolean(res?.verified);
          if (ok) haptics.success();
          else haptics.warning();
          toast({
            kind: ok ? "success" : "warning",
            message: ok
              ? msg("customDomains.verify.ok", { domain: row.domain })
              : msg("customDomains.verify.pending", { domain: row.domain }),
          });
        })
        .catch((e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: writeFailureMessage(
              e,
              msg("customDomains.verify.failed", { domain: row.domain }),
            ),
          });
        })
        .finally(() =>
          setVerifyingIds((prev) => {
            const next = { ...prev };
            delete next[row.id];
            return next;
          }),
        );
    },
    [toast, verify],
  );

  const onDelete = useCallback(
    async (row: CustomDomain) => {
      // Removing a domain invalidates published DNS and any links already sent
      // on it — irreversible in effect, so it earns a typed confirmation.
      const ok = await confirm({
        title: msg("customDomains.remove.title"),
        message: msg("customDomains.remove.body", { domain: row.domain }),
        confirmLabel: msg("customDomains.remove.confirm"),
        destructive: true,
        confirmPhrase: row.domain,
        consequence: msg("customDomains.remove.warning"),
      });
      if (!ok) return;
      remove
        .mutateAsync(row.id)
        .then(() => {
          haptics.success();
          toast({
            kind: "success",
            message: msg("customDomains.remove.ok", { domain: row.domain }),
          });
        })
        .catch((e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: writeFailureMessage(
              e,
              msg("customDomains.remove.failed", { domain: row.domain }),
            ),
          });
        });
    },
    [confirm, remove, toast],
  );

  const onShareRecord = useCallback(
    (record: { type: string; name: string; value: string }) => {
      // Name AND value together — a value with no host is not actionable in a
      // registrar form.
      void Share.share({
        message: `${record.type} ${record.name}\n${record.value}`,
      }).catch(() =>
        toast({ kind: "error", message: msg("customDomains.share.failed") }),
      );
    },
    [toast],
  );

  const renderItem = useCallback(
    ({ item: row }: { item: CustomDomain }) => {
      const card = (
        <DomainRowCard
          row={row}
          health={healthByDomain[row.domain.toLowerCase()]}
          healthUnknown={health.isError || !health.data}
          reputation={reputationByDomain[row.domain.toLowerCase()]}
          expanded={Boolean(expanded[row.id])}
          onToggleRecords={() =>
            setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))
          }
          onVerify={() => onVerify(row)}
          verifying={Boolean(verifyingIds[row.id])}
          onShareRecord={onShareRecord}
          now={now}
        />
      );
      if (!canWrite) return card;
      return (
        <SwipeableRow
          accessibilityLabel={
            row.verified
              ? msg("customDomains.row.a11y.verified", { domain: row.domain })
              : msg("customDomains.row.a11y.pending", { domain: row.domain })
          }
          right={[
            {
              label: msg("customDomains.remove.confirm"),
              kind: "danger",
              onPress: () => void onDelete(row),
            },
          ]}
        >
          {card}
        </SwipeableRow>
      );
    },
    [
      canWrite,
      expanded,
      health.data,
      health.isError,
      healthByDomain,
      now,
      onDelete,
      onShareRecord,
      onVerify,
      reputationByDomain,
      verifyingIds,
    ],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={msg("customDomains.title")}
        subtitle={subtitle}
        onBack={goBackOrMore}
        right={
          canWrite ? (
            <DomainsHeaderActions onAdd={() => setAddOpen(true)} />
          ) : null
        }
      />
      <View style={{ paddingBottom: 8 }}>
        <ChipRow
          options={filterOptions()}
          value={filter}
          onChange={setFilter}
          accessibilityLabel={msg("customDomains.filter.a11y")}
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 4,
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
          <DomainsListHeader
            backing={domains.data}
            now={now}
            healthNotice={healthNotice}
          />
        }
        ListEmptyComponent={
          <QueryStates
            query={domains}
            gate={gate}
            isEmpty
            skeleton={<SkeletonList rows={4} />}
            offlineMessage={msg("customDomains.empty.offline")}
            empty={{
              title:
                filter === "pending"
                  ? msg("customDomains.empty.pending.title")
                  : filter === "verified"
                    ? msg("customDomains.empty.verified.title")
                    : msg("customDomains.empty.title"),
              description: msg("customDomains.empty.body"),
              ...(canWrite && filter === "all"
                ? {
                    cta: {
                      label: msg("customDomains.empty.cta"),
                      onPress: () => setAddOpen(true),
                    },
                  }
                : {}),
            }}
          >
            {null}
          </QueryStates>
        }
        renderItem={renderItem}
      />
      <AddDomainSheet
        visible={addOpen}
        submitting={create.isPending}
        onClose={() => setAddOpen(false)}
        onSubmit={(input) => {
          create
            .mutateAsync(input)
            .then(() => {
              haptics.success();
              setAddOpen(false);
              toast({
                kind: "success",
                message: msg("customDomains.add.ok", { domain: input.domain }),
              });
            })
            .catch((e: unknown) => {
              haptics.error();
              toast({
                kind: "error",
                message: writeFailureMessage(
                  e,
                  msg("customDomains.add.failed"),
                ),
              });
            });
        }}
      />
    </SafeAreaView>
  );
}

/**
 * List header: the "showing a cached copy" notice plus the DNS-health notice.
 *
 * Extracted from the screen body so the screen's own function stays inside its
 * ratchet, and because the two notices are one idea — "here is why this list
 * may not be what you expect" — rather than two lines that happened to be
 * adjacent.
 */
function DomainsListHeader({
  backing,
  now,
  healthNotice,
}: {
  backing: CachedNoticeProps["backing"];
  now: number;
  healthNotice: string | null;
}) {
  const { t } = useTheme();
  return (
    <>
      <CachedNotice backing={backing} now={now} />
      {/* The PUBLISHING vanity host, above the sending domains: same errand
          (create a CNAME, wait for DNS, watch the cert), different subsystem.
          Admin-only, including its read, so it renders nothing for anyone
          who could not load it. */}
      <ArchiveDomainCard />
      {healthNotice ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginBottom: 10,
          }}
        >
          {healthNotice}
        </Text>
      ) : null}
    </>
  );
}
