/**
 * DMARC — authentication results for your sending domains.
 *
 * What changed, and why:
 *
 *  - THE WINDOW IS EXPLICIT. "The newest 50 reports" is two weeks for one
 *    tenant and under two days for another, and the header summed pass/fail
 *    across it with no denominator. A 7/30/90-day control now decides the
 *    window and the summary names it.
 *  - THE ACTIONABLE HALF EXISTS. `/deliverability/dmarc-insights` returns the
 *    alignment trend, top failing sources and suggested record changes; mobile
 *    rendered only the raw feed desktop deliberately DEMOTED below them.
 *  - IT SURVIVES AIRPLANE MODE, with honest "Cached · 3h ago" provenance.
 *  - THE FRESHNESS LABEL TICKS (it froze at mount, on a screen whose job is
 *    telling you whether the ingestion pipeline is alive).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  Pressable,
  RefreshControl,
  Share,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Card } from "@/components/Card";
import { ChipRow } from "@/components/ChipRow";
import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { DmarcInsightsCard } from "@/components/deliverability/DmarcInsightsCard";
import { DmarcPolicyAdvisorCard } from "@/components/deliverability/DmarcPolicyAdvisorCard";
import { DmarcReportRow } from "@/components/deliverability/DmarcReportRow";
import { DmarcSourceSheet } from "@/components/deliverability/DmarcSourceSheet";
import { HeaderAction } from "@/components/deliverability/HeaderAction";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  DMARC_RANGES,
  dmarcRangeDays,
  useDmarcInsights,
  useDmarcReports,
  type DmarcRangeKey,
  type DmarcReport,
} from "@/hooks/useDmarcOps";
import {
  domainsOf,
  matchesDisposition,
  summarise,
  type DispositionFilter,
} from "@/lib/dmarcView";
import { dmarcCsv } from "@/lib/dmarcExport";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { msg, pluralMsg } from "@/lib/i18n";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const ALL_DOMAINS = "__all__";

/**
 * A GLYPH, not copy — so it is a named constant rather than an inline literal
 * on the `label` prop. The i18n ratchet treats every string reaching a
 * user-facing prop as translatable, and an arrow is the one thing that must
 * not be: it is an icon the app happens to draw with a character.
 */
const SHARE_GLYPH = "\u2934";

/**
 * Built per render rather than at module scope: `msg()` reads the ACTIVE
 * catalogue, and a module-level constant would freeze whichever locale was
 * live at import time.
 */
function dispositionOptions(): readonly {
  value: DispositionFilter;
  label: string;
}[] {
  return [
    { value: "all", label: msg("dmarc.result.all") },
    { value: "passing", label: msg("dmarc.result.passing") },
    { value: "failing", label: msg("dmarc.result.failing") },
  ];
}

/** The expansion key for a report — `id` when the server sent one. */
function dmarcRowKey(row: DmarcReport): string {
  return row.id || `${row.domain}-${row.receivedAt}`;
}

export default function Dmarc() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const now = useNowTicker();
  const { toast } = useToast();
  useScreenViewed("dmarc");

  const [range, setRange] = useState<DmarcRangeKey>("30d");
  const [domain, setDomain] = useState<string>(ALL_DOMAINS);
  const [disposition, setDisposition] = useState<DispositionFilter>("all");
  // Rows were inert. Tapping one now expands the reporter, published policy,
  // arrival time and report id in place — four lines of text, not a screen.
  const [openRow, setOpenRow] = useState<string | null>(null);
  // A failing source IP opened from the insights card; "" keeps the sheet
  // closed and its detail read un-run.
  const [openSourceIp, setOpenSourceIp] = useState("");

  const reports = useDmarcReports(range);
  const rows = useMemo(() => (Array.isArray(reports.data?.value) ? reports.data?.value : []), [reports.data]);
  const allDomains = useMemo(() => domainsOf(rows), [rows]);

  // Insights are per-domain server-side. With exactly one sending domain the
  // choice is not a choice, so make it automatically rather than showing an
  // empty insights card next to a single chip.
  const insightsDomain =
    domain !== ALL_DOMAINS
      ? domain
      : allDomains.length === 1
        ? (allDomains[0] ?? "")
        : "";
  const insights = useDmarcInsights(insightsDomain, range);
  const refresh = useManualRefresh([reports.refetch, insights.refetch]);

  // Re-normalise a stale domain selection: if the chosen domain drops out of
  // the data on a refetch (it stopped sending, or the window changed), its chip
  // stops rendering yet `domain` still points at it — silently filtering every
  // row away with no visible active chip. Fall back so the list never gets
  // stuck empty behind an invisible selection.
  useEffect(() => {
    if (domain !== ALL_DOMAINS && !allDomains.includes(domain)) {
      setDomain(ALL_DOMAINS);
    }
  }, [allDomains, domain]);

  const domainRows = useMemo(
    () =>
      domain === ALL_DOMAINS ? rows : rows.filter((r) => r.domain === domain),
    [rows, domain],
  );
  const visible = useMemo(
    () => domainRows.filter((r) => matchesDisposition(r, disposition)),
    [domainRows, disposition],
  );

  const windowLabel =
    DMARC_RANGES.find((r) => r.value === range)?.label ?? "30 days";
  const summary = useMemo(
    () => summarise(domainRows, { windowLabel, now }),
    [domainRows, now, windowLabel],
  );

  const filtered = domain !== ALL_DOMAINS || disposition !== "all";
  // Whole sentences per outcome instead of `sideSignalNotice(noun, …)`: that
  // helper glues a noun onto a fixed English frame, which is exactly the shape
  // a translator cannot rewrite. The three branches are otherwise identical to
  // what it produced.
  const insightsUnavailable = !insightsDomain
    ? msg("dmarc.insights.pickDomain")
    : insights.isError
      ? gate.enabled
        ? msg("dmarc.insights.failed")
        : msg("dmarc.insights.offline")
      : null;

  const onShareFailed = useCallback(
    (message: string) => toast({ kind: "error", message }),
    [toast],
  );

  /**
   * Export what is ON SCREEN — `visible`, i.e. after the domain and result
   * filters — because exporting something other than what the operator is
   * looking at is the classic export bug. The toast names the row count and
   * says out loud when the set was capped, so a partial export is never
   * mistaken for the whole window.
   */
  const shareReports = useCallback(() => {
    if (visible.length === 0) return;
    haptics.tap();
    const csv = dmarcCsv(visible, {
      windowLabel,
      domain: domain === ALL_DOMAINS ? "" : domain,
    });
    void Share.share({ message: csv.body, title: csv.title })
      .then(() => {
        if (csv.truncated) {
          toast({
            kind: "info",
            message: pluralMsg("dmarc.share.truncated", visible.length, {
              included: csv.included,
            }),
          });
        }
      })
      .catch(() =>
        toast({ kind: "error", message: msg("dmarc.share.failed") }),
      );
  }, [domain, toast, visible, windowLabel]);

  const keyExtractor = useCallback(
    (row: DmarcReport, index: number) => row.id || `dmarc-${index}`,
    [],
  );

  // Which report is expanded, derived from the row rather than captured in a
  // per-row closure — see the DmarcReportRow prop comment.
  const toggleRow = useCallback((row: DmarcReport) => {
    const key = dmarcRowKey(row);
    setOpenRow((current) => (current === key ? null : key));
  }, []);

  const renderRow = useCallback<ListRenderItem<DmarcReport>>(
    ({ item: row }) => (
      <DmarcReportRow
        row={row}
        expanded={openRow === dmarcRowKey(row)}
        onToggle={toggleRow}
        now={now}
      />
    ),
    [now, openRow, toggleRow],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={msg("dmarc.title")}
        subtitle={rows.length > 0 ? summary.caption : undefined}
        onBack={goBackOrMore}
        right={
          visible.length > 0 ? (
            <HeaderAction
              label={SHARE_GLYPH}
              accessibilityLabel={pluralMsg("dmarc.share.a11y", visible.length)}
              onPress={shareReports}
            />
          ) : undefined
        }
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <SegmentedControl
          options={DMARC_RANGES.map((r) => ({
            value: r.value,
            label: r.label,
          }))}
          value={range}
          onChange={setRange}
          accessibilityLabel={msg("dmarc.range.a11y")}
        />
      </View>
      {/* The domain row renders at ONE domain too. It used to disappear below
          two, which left the summary describing an unnamed domain — the reader
          could not tell whose alignment they were looking at. */}
      {allDomains.length > 0 ? (
        <View style={{ paddingTop: 8 }}>
          <ChipRow
            options={[
              { value: ALL_DOMAINS, label: msg("dmarc.domain.all") },
              ...allDomains.map((d) => ({ value: d, label: d })),
            ]}
            value={domain}
            onChange={setDomain}
            accessibilityLabel={msg("dmarc.domain.a11y")}
          />
        </View>
      ) : null}
      <View style={{ paddingTop: 4, paddingBottom: 8 }}>
        <ChipRow
          options={dispositionOptions()}
          value={disposition}
          onChange={setDisposition}
          accessibilityLabel={msg("dmarc.result.a11y")}
        />
      </View>

      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={visible}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
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
        ListHeaderComponent={
          <>
            <CachedNotice backing={reports.data} now={now} />
            <DmarcInsightsCard
              insights={insights.data}
              loading={insights.isLoading && Boolean(insightsDomain)}
              unavailableReason={insightsUnavailable}
              onShareFailed={onShareFailed}
              onOpenSource={setOpenSourceIp}
            />
            {/* What the observed p= means, with the observation-only
                boundary — copy desktop's advisor renders beside the same
                number this card shows inline. */}
            {insights.data && !insightsUnavailable ? (
              <DmarcPolicyAdvisorCard
                latestPolicy={insights.data.latestPolicy}
                domain={insightsDomain}
              />
            ) : null}
            {rows.length > 0 ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.bold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  marginBottom: 8,
                  marginTop: 2,
                }}
              >
                {msg("dmarc.section.rawReports")}
              </Text>
            ) : null}
            {rows.length > 0 && visible.length === 0 ? (
              <FilterMiss
                onReset={() => {
                  setDomain(ALL_DOMAINS);
                  setDisposition("all");
                }}
              />
            ) : null}
          </>
        }
        ListEmptyComponent={
          rows.length > 0 ? null : (
            <QueryStates
              query={reports}
              gate={gate}
              isEmpty
              skeleton={<SkeletonList rows={5} />}
              offlineMessage={msg("dmarc.empty.offline")}
              empty={{
                title: filtered
                  ? msg("dmarc.empty.filtered.title")
                  : msg("dmarc.empty.title"),
                description: filtered
                  ? msg("dmarc.empty.filtered.body", { window: windowLabel })
                  : msg("dmarc.empty.body"),
              }}
            >
              {null}
            </QueryStates>
          )
        }
      />
      <DmarcSourceSheet
        ip={openSourceIp}
        days={dmarcRangeDays(range)}
        domain={insightsDomain}
        onClose={() => setOpenSourceIp("")}
      />
    </SafeAreaView>
  );
}

/**
 * The reset affordance used to be a filter Chip, so VoiceOver announced it as
 * one more selectable filter ("Reset filters, not selected") rather than as
 * the button that clears them.
 */
function FilterMiss({ onReset }: { onReset: () => void }) {
  const { t } = useTheme();
  return (
    <Card
      style={{
        alignItems: "flex-start",
        gap: 8,
        marginBottom: 10,
      }}
    >
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontFamily: FONT.semibold,
        }}
      >
        {msg("dmarc.filterMiss.title")}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {msg("dmarc.filterMiss.body")}
      </Text>
      <Pressable
        onPress={onReset}
        accessibilityRole="button"
        accessibilityLabel={msg("dmarc.filterMiss.reset.a11y")}
        hitSlop={8}
        style={{
          minHeight: 44,
          justifyContent: "center",
          paddingHorizontal: 2,
        }}
      >
        <Text
          {...typeCap("callout")}
          importantForAccessibility="no"
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          {msg("dmarc.filterMiss.reset")}
        </Text>
      </Pressable>
    </Card>
  );
}
