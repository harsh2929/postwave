/**
 * Integrations tab — connection health roll-up. The mobile question is "are my
 * outbound integrations OK right now?"; if something is failing you can read
 * the full error, share it to escalate, or jump to the web admin surface that
 * manages it.
 *
 * OFFLINE IS NOT EMPTY (the bug this screen existed to demonstrate). The query
 * is gated on `gate.enabled`, so offline it never runs: in TanStack v5 that is
 * status "pending" with fetchStatus "idle", which means `isLoading` is FALSE
 * and `isError` is FALSE. The old ladder fell straight through to
 * "No integrations connected" and rendered "0 Failing · 0 Degraded · 0 Healthy"
 * as fact — the single most dangerous sentence this screen can say. Both the
 * body and the counters now route through the gate: `QueryStates` owns the
 * offline message, and the counters render an em-dash whenever the numbers are
 * not known to be current.
 *
 * Writes stay on the web admin. The per-slug lifecycle routes
 * (POST /api/v1/integrations/{slug}/sync et al) do NOT actually run a sync —
 * they return a "delegated" descriptor naming the real provider endpoint
 * (apps/api/internal/integrations/handlers.go:660-712) — so a "Retry sync"
 * button here would be a button that does nothing. `manage_path` is the honest
 * action, and the server sends it on every connection.
 *
 * What DID land is the read the phone was missing: expanding a card now fetches
 * GET /api/v1/integrations/{slug}/health (a real handler, handlers.go:357-385,
 * same read:reports scope as the list) and shows the checks, the recent sync
 * attempts with their retry counts, and the retry policy. That is the
 * difference between "Slack is failing" and "Slack has failed three times in
 * ten minutes on 429s and will keep retrying" — the second one tells you
 * whether opening a laptop is worth it.
 */
import * as Linking from "expo-linking";
import { ChatChannelPanel } from "@/components/integrations/ChatChannelPanel";
import { AnalyticsDestinationsConsole } from "@/components/integrations/AnalyticsDestinationsConsole";
import { AudienceDestinationsPanel } from "@/components/integrations/AudienceDestinationsPanel";
import { ConnectionFamilyPanel } from "@/components/integrations/ConnectionFamilyPanel";
import { CrmLifecyclePanel } from "@/components/integrations/CrmLifecyclePanel";
import { IntegrationsCatalogPanel } from "@/components/integrations/IntegrationsCatalogPanel";
import { IntegrationsEcosystemPanel } from "@/components/integrations/IntegrationsEcosystemPanel";
import { IntegrationRecipesPanel } from "@/components/integrations/IntegrationRecipesPanel";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  RefreshControl,
  Share,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EmptyState } from "@/components/EmptyState";
import { IntegrationCard } from "@/components/integrations/IntegrationCard";
import type { PillTone } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { trackCommerceAction } from "@/lib/commerceTelemetry";
import { EMDASH, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { countByStatus, manageUrl, type Integration } from "@/lib/integrationRows";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const WEB_ADMIN_INTEGRATIONS_PATH = "/app/integrations";

export default function Integrations() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const integrations = useIntegrations();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useScreenViewed("integrations");

  // LOVE#15: only a REAL pull spins the control. `isRefetching` also fires for
  // the refetch a foreground resume triggers, and this list's payload is the
  // ~600-row catalogue — the one refetch most likely to be in flight when the
  // reader returns to the app.
  const refresh = useManualRefresh([integrations.refetch], {
    enabled: gate.enabled,
  });

  const rows = useMemo(
    () => (Array.isArray(integrations.data) ? integrations.data : []),
    [integrations.data],
  );

  const counts = useMemo(() => countByStatus(rows), [rows]);
  const problemCount = counts.failing + counts.degraded;

  /**
   * The counters are only facts when a fetch actually succeeded. A failed load
   * OR a query the gate never allowed to run both leave `rows` empty, and
   * "0 / 0 / 0" would then read as an all-clear. Show em-dashes instead.
   */
  const metricsUnavailable =
    integrations.data === undefined &&
    (integrations.isError || !gate.enabled || integrations.isLoading);

  const visibleRows = useMemo(
    () => (onlyProblems ? rows.filter((r) => r.status !== "healthy") : rows),
    [rows, onlyProblems],
  );

  const shareError = useCallback(
    (row: Integration) => {
      const message = (row.last_error ?? "").trim();
      if (!message) return;
      void Share.share(
        {
          message: `${row.name} (${row.status}): ${message}`,
          title: `${row.name} error`,
        },
        { dialogTitle: `${row.name} integration error` },
      ).catch(() => {
        toast({ kind: "error", message: "Couldn't open the share sheet." });
      });
    },
    [toast],
  );

  const openManage = useCallback(
    (href: string) => {
      void Linking.openURL(href)
        .then(() => {
          // COMMERCE#58. Connecting/disconnecting a connector happens on the
          // web admin, so this hand-off IS the mobile action for this cluster
          // — and it emitted nothing, leaving "does the phone lead anyone to
          // manage an integration?" unanswerable. Outcome only; no href, no
          // connector name.
          trackCommerceAction("integration_manage", "success");
        })
        .catch(() => {
          trackCommerceAction("integration_manage", "failure");
          toast({ kind: "error", message: "Couldn't open the web admin." });
        });
    },
    [toast],
  );

  const webAdminHref = manageUrl(WEB_ADMIN_INTEGRATIONS_PATH, gate.baseUrl);

  // Hoisted out of the FlatList. An inline `renderItem` is a NEW function on
  // every parent render, and VirtualizedList treats that as "the row renderer
  // changed" — so every mounted cell re-renders, and each of those re-mounts
  // the per-card health query hook. `expandedId` is the only value that can
  // legitimately change the output, so it is the only dependency that should
  // be able to invalidate it.
  const toggleRow = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);
  const keyExtractor = useCallback((row: Integration) => row.id, []);
  const renderIntegration = useCallback<ListRenderItem<Integration>>(
    ({ item: row }) => (
      <IntegrationCard
        row={row}
        expanded={expandedId === row.id}
        onToggle={toggleRow}
        onShareError={shareError}
        manageHref={manageUrl(row.manage_path, gate.baseUrl) ?? webAdminHref}
        onOpenManage={openManage}
      />
    ),
    [expandedId, gate.baseUrl, openManage, shareError, toggleRow, webAdminHref],
  );

  const subtitle =
    integrations.data !== undefined && rows.length > 0
      ? `${num(rows.length)} connected · ${problemCount} need attention`
      : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Integrations"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <FlatList
        // Loading/error/offline short-circuit the list so QueryStates (in
        // ListEmptyComponent) owns those states; the roll-up header still
        // renders above them.
        data={integrations.data === undefined ? [] : visibleRows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{ padding: 16, paddingBottom: 32, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        {...MOBILE_LIST_PERF_PROPS}
        ListHeaderComponent={
          <>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Metric
                label="Failing"
                value={metricsUnavailable ? null : counts.failing}
                tone="danger"
              />
              <Metric
                label="Degraded"
                value={metricsUnavailable ? null : counts.degraded}
                tone="warning"
              />
              <Metric
                label="Healthy"
                value={metricsUnavailable ? null : counts.healthy}
                tone="success"
              />
            </View>

            <SectionLabel
              topMargin={24}
              right={
                problemCount > 0 ? (
                  <FilterToggle
                    onlyProblems={onlyProblems}
                    onToggle={() => setOnlyProblems((v) => !v)}
                  />
                ) : undefined
              }
            >
              Integrations
            </SectionLabel>
            {/* Each self-hides when its family has no rows. */}
            <CrmLifecyclePanel />
            <ConnectionFamilyPanel family="writeback" />
            <ConnectionFamilyPanel family="marketing" />
            {/* The five non-CRM native families (P2.39); analytics carries
                its roll-up (the analytics-destinations console). */}
            <AnalyticsDestinationsConsole />
            <ConnectionFamilyPanel family="lead" />
            <ConnectionFamilyPanel family="review" />
            <ConnectionFamilyPanel family="loyalty" />
            <ConnectionFamilyPanel family="subscription" />
            <AudienceDestinationsPanel />
            <ChatChannelPanel />
            {/* What COULD be connected, folded and fetched only on open. The
                panels above are all "what IS connected"; the catalog is the
                other half of the question and the phone had no answer for it. */}
            <IntegrationsCatalogPanel />
            {/* Reference material, all three folded and fetched on demand:
                the recipe blueprints, then the ecosystem-level coverage /
                readiness / stack reports. */}
            <IntegrationRecipesPanel />
            <IntegrationsEcosystemPanel />
          </>
        }
        ListEmptyComponent={
          <QueryStates
            query={integrations}
            gate={gate}
            isEmpty={rows.length === 0}
            offlineMessage="You're offline, so integration health can't be checked. This is not the same as having none connected — reconnect and pull to refresh."
            skeleton={<SkeletonList rows={5} />}
            empty={{
              title: "No integrations connected",
              description:
                "Connect Slack, Discord, Teams, or a custom webhook on the web admin.",
              ...(webAdminHref
                ? {
                    cta: {
                      label: "Open web admin",
                      onPress: () => openManage(webAdminHref),
                    },
                  }
                : {}),
            }}
          >
            {/* Reached only when rows exist but the filter hides them all. */}
            <EmptyState
              title="Everything is healthy"
              description="No failing or degraded integrations right now."
              cta={{ label: "Show all", onPress: () => setOnlyProblems(false) }}
            />
          </QueryStates>
        }
        renderItem={renderIntegration}
      />
    </SafeAreaView>
  );
}

function FilterToggle({
  onlyProblems,
  onToggle,
}: {
  onlyProblems: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="button"
      accessibilityState={{ selected: onlyProblems }}
      accessibilityLabel={
        onlyProblems
          ? "Show all integrations"
          : "Show only failing and degraded integrations"
      }
      onPress={onToggle}
      suppressHighlighting
      {...typeCap("control")}
      style={{
        color: t.accent,
        ...typeStyle("control"),
        fontWeight: "600",
        fontFamily: FONT.semibold,
        paddingVertical: 12,
        paddingHorizontal: 4,
      }}
    >
      {onlyProblems ? "Show all" : "Only problems"}
    </Text>
  );
}

/**
 * One counter tile. `value === null` means "not known right now" and renders an
 * em-dash — never a zero, which would be a claim.
 *
 * Dynamic Type: the numeral is the `figure` role — a stat hero inside pinned
 * tile geometry, so it takes the scale's tightest ceiling. Its 22pt size is
 * kept deliberately (this is a compact counter strip, not a dashboard tile),
 * which the scale explicitly allows: a capped odd size beats an uncapped one.
 * The label below it is prose and now WRAPS rather than truncating — the row
 * is flexWrap and the tiles stretch to a common height, so growing text costs
 * a line rather than the end of the word.
 */
function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: PillTone;
}) {
  const { t } = useTheme();
  const color =
    tone === "danger"
      ? t.danger
      : tone === "warning"
        ? t.warning
        : tone === "success"
          ? t.success
          : t.info;
  const display = value === null ? EMDASH : num(value);
  return (
    <View
      accessible
      accessibilityLabel={
        value === null
          ? `${label}: not available`
          : `${label}: ${plural(value, "integration")}`
      }
      style={{
        flexGrow: 1,
        flexBasis: 96,
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
      }}
    >
      <Text
        {...typeCap("figure")}
        style={{
          color,
          fontSize: 22,
          lineHeight: 26,
          fontWeight: "700",
          fontFamily: FONT.display,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
      >
        {display}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
