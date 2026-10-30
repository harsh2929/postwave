/**
 * ApiUsageSection — API sends, metered cost and active keys on Plan & usage.
 *
 * Desktop's Settings › Usage (apps/desktop/src/components/settings/
 * UsageSection.tsx) reads five endpoints; the phone read none of them, so
 * "what is the API costing us this week" was a laptop question. This section
 * brings the AGGREGATES here and pushes the itemized ledger into a sheet
 * (CostLedgerSheet) — a sheet rather than a route because the rhythm is
 * open → scan → done, and it keeps billing to a single route file.
 *
 * TWO ROLE FLOORS, from the routeauth manifest: /api-usage/* is admin,
 * /costs and /costs/ledger are viewer. The section gates the halves
 * separately, so a viewer sees cost totals and the ledger and never fires an
 * admin read whose only possible answer is 403. Nothing here changes money:
 * the window and group-by chips only change what is READ.
 *
 * FAILURE IS NEVER BLANK. Each half has its own loading / failed / empty /
 * offline state; a failed read names itself and offers Retry only when a
 * retry can help (errorPresentation decides); an empty window is stated in
 * words rather than as a row of $0.00 tiles.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  fetchApiUsageKeys,
  fetchApiUsageSummary,
  fetchApiUsageTimeseries,
  fetchCostAggregates,
} from "@/api/apiUsage";
import {
  CostRows,
  KeyRows,
  MutedLine,
  SectionFailure,
  StatGrid,
} from "@/components/billing/ApiUsageParts";
import { CostLedgerSheet } from "@/components/billing/CostLedgerSheet";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Skeleton, SkeletonGroup } from "@/components/Skeleton";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  ApiUsageKeyRow,
  ApiUsagePoint,
  ApiUsageSummary,
  ApiUsageWindow,
  CostAggregateRow,
  CostGroupBy,
} from "@/lib/apiUsage";
import {
  ADMIN_ONLY_USAGE_NOTE,
  API_USAGE_DESCRIPTION,
  API_USAGE_OFFLINE_NOTE,
  API_USAGE_WINDOW_OPTIONS,
  apiUsageAccess,
  COST_GROUP_OPTIONS,
  costSeriesDollars,
  costTotalsEmptyCopy,
  parseApiUsageWindow,
  sendsSeries,
  seriesHasCost,
  seriesLabels,
  summaryStats,
  usageEmptyCopy,
  usageWindowIsEmpty,
  type ApiUsageWindowValue,
} from "@/lib/apiUsageDashboard";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** The slice of a TanStack result the blocks below read. */
interface Read<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

export function ApiUsageSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const access = apiUsageAccess(gate.effectiveRole, mode);
  const [days, setDays] = useState<ApiUsageWindow>(30);
  const [by, setBy] = useState<CostGroupBy>("kind");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const online = gate.enabled && Boolean(gate.tenantId);

  const summary = useQuery({
    queryKey: ["billing", "api-usage", "summary", gate.tenantId, days],
    enabled: online && access.usage,
    queryFn: () => fetchApiUsageSummary(days),
    staleTime: 60_000,
  });
  const keys = useQuery({
    queryKey: ["billing", "api-usage", "keys", gate.tenantId, days],
    enabled: online && access.usage,
    queryFn: () => fetchApiUsageKeys(days),
    staleTime: 60_000,
  });
  const series = useQuery({
    queryKey: ["billing", "api-usage", "timeseries", gate.tenantId, days],
    enabled: online && access.usage,
    queryFn: () => fetchApiUsageTimeseries(days),
    staleTime: 60_000,
  });
  const costs = useQuery({
    queryKey: ["billing", "costs", gate.tenantId, days, by],
    enabled: online && access.costs,
    queryFn: () => fetchCostAggregates(days, by),
    staleTime: 60_000,
  });

  // An unrecognised role can read neither half: render nothing rather than
  // a heading over two failure blocks.
  if (!access.costs) return null;

  return (
    <View style={{ marginTop: 24 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("heading"),
          marginBottom: 4,
        }}
      >
        {"API usage & cost"}
      </Text>
      <MutedLine style={{ marginBottom: 12 }}>{API_USAGE_DESCRIPTION}</MutedLine>
      <View style={{ marginBottom: 12 }}>
        <SegmentedControl
          options={API_USAGE_WINDOW_OPTIONS}
          value={String(days) as ApiUsageWindowValue}
          onChange={(next) => setDays(parseApiUsageWindow(next))}
          accessibilityLabel="API usage window"
        />
      </View>
      {!gate.enabled ? (
        <MutedLine>{API_USAGE_OFFLINE_NOTE}</MutedLine>
      ) : (
        <>
          {access.usage ? (
            <UsageBlock
              days={days}
              summary={summary}
              keys={keys}
              series={series}
              onRetry={() => {
                void summary.refetch();
                void keys.refetch();
                void series.refetch();
              }}
            />
          ) : (
            <MutedLine style={{ marginBottom: 16 }}>
              {ADMIN_ONLY_USAGE_NOTE}
            </MutedLine>
          )}
          <CostTotalsBlock
            days={days}
            by={by}
            onGroupChange={setBy}
            costs={costs}
            onRetry={() => void costs.refetch()}
          />
          <Pressable
            onPress={() => {
              haptics.tap();
              setLedgerOpen(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="View the itemized cost ledger"
            style={{
              minHeight: 44,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 16,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                fontFamily: FONT.semibold,
                ...typeStyle("callout"),
              }}
            >
              View cost ledger
            </Text>
          </Pressable>
        </>
      )}
      <CostLedgerSheet
        visible={ledgerOpen}
        days={days}
        onClose={() => setLedgerOpen(false)}
      />
    </View>
  );
}

function UsageBlock({
  days,
  summary,
  keys,
  series,
  onRetry,
}: {
  days: number;
  summary: Read<ApiUsageSummary>;
  keys: Read<ApiUsageKeyRow[]>;
  series: Read<ApiUsagePoint[]>;
  onRetry: () => void;
}) {
  if (summary.isLoading || keys.isLoading || series.isLoading) {
    return (
      <SkeletonGroup label="Loading API usage">
        <View style={{ gap: 8, marginBottom: 16 }}>
          <Skeleton height={72} radius={12} />
          <Skeleton height={72} radius={12} />
        </View>
      </SkeletonGroup>
    );
  }
  if (summary.isError || keys.isError || series.isError) {
    const failed = summary.isError
      ? summary.error
      : keys.isError
        ? keys.error
        : series.error;
    const p = errorPresentation(failed);
    return (
      <SectionFailure
        what="API usage"
        message={p.message}
        retryable={p.retryable}
        onRetry={onRetry}
      />
    );
  }
  const s = summary.data;
  const points = Array.isArray(series.data) ? series.data : [];
  if (!s || usageWindowIsEmpty(s, points)) {
    return (
      <MutedLine style={{ marginBottom: 16 }}>{usageEmptyCopy(days)}</MutedLine>
    );
  }
  return (
    <View style={{ marginBottom: 16 }}>
      <StatGrid stats={summaryStats(s)} />
      <UsageCharts points={points} />
      <KeyRows rows={Array.isArray(keys.data) ? keys.data : []} />
    </View>
  );
}

/**
 * Sends and cost get SEPARATE charts, as on desktop: one y-axis per unit.
 * The cost chart is omitted when every point is zero — a flat line at $0.00
 * reads as data about cost, and there is none.
 */
function UsageCharts({ points }: { points: readonly ApiUsagePoint[] }) {
  if (points.length === 0) return null;
  const labels = seriesLabels(points);
  return (
    <View style={{ gap: 16, marginTop: 16 }}>
      <TimeSeriesChart
        series={[{ id: "sends", label: "Sends", values: sendsSeries(points) }]}
        labels={labels}
        title="API sends per day"
        valueNoun="sends"
        area
      />
      {seriesHasCost(points) ? (
        <TimeSeriesChart
          series={[
            { id: "cost", label: "Cost (USD)", values: costSeriesDollars(points) },
          ]}
          labels={labels}
          title="Metered cost per day (USD)"
          valueNoun="dollars"
          area
        />
      ) : null}
    </View>
  );
}

function CostTotalsBlock({
  days,
  by,
  onGroupChange,
  costs,
  onRetry,
}: {
  days: number;
  by: CostGroupBy;
  onGroupChange: (next: CostGroupBy) => void;
  costs: Read<CostAggregateRow[]>;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  const failure = costs.isError ? errorPresentation(costs.error) : null;
  const rows = Array.isArray(costs.data) ? costs.data : [];
  return (
    <View style={{ marginBottom: 12 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("body")}
        style={{
          color: t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("body"),
          marginBottom: 8,
        }}
      >
        Cost totals
      </Text>
      <View style={{ marginBottom: 10 }}>
        <SegmentedControl
          options={COST_GROUP_OPTIONS}
          value={by}
          onChange={onGroupChange}
          accessibilityLabel="Group cost totals by"
        />
      </View>
      {costs.isLoading ? (
        <SkeletonGroup label="Loading cost totals">
          <Skeleton height={56} radius={12} />
        </SkeletonGroup>
      ) : failure ? (
        <SectionFailure
          what="Cost totals"
          message={failure.message}
          retryable={failure.retryable}
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <MutedLine>{costTotalsEmptyCopy(days)}</MutedLine>
      ) : (
        <CostRows rows={rows} by={by} />
      )}
    </View>
  );
}
