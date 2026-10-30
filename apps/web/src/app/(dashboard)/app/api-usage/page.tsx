// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * API usage — what has been spent, and what is merely projected.
 *
 * Three `/api/v1/api-usage/*` paths desktop reached and web did not.
 *
 * A PROJECTION IS NOT A BILL. The server reports what actually happened in the
 * window AND a straight-line 30-day extrapolation from it. Those two numbers
 * look identical in a grid of tiles, and only one of them is money that has
 * been spent. They are separated here, with the projection explicitly labelled
 * as an extrapolation from the observed window rather than a forecast anybody
 * has committed to.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarDays,
  KeyRound,
  ReceiptText,
  TrendingUp,
} from "lucide-react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
} from "@/components/integrations/data-surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { whoami } from "@/lib/auth-api";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  activeDays,
  type CostAggregateRow,
  type CostGroupBy,
  type CostLedgerRow,
  formatCents,
  getCostAggregate,
  getCostLedgerPage,
  getApiUsageKeys,
  getApiUsageSummary,
  getApiUsageTimeseries,
} from "@/lib/api-usage-api";
import { base, STALE } from "@/lib/query-keys";

export default function ApiUsagePage() {
  const queryClient = useQueryClient();
  const [costWindow, setCostWindow] = useState("30d");
  const [costGroup, setCostGroup] = useState<CostGroupBy>("kind");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const canAdmin = meQuery.isSuccess && canReadAdminData(identity);
  const [tenantId, userId, role, viewerState] =
    adminReadIdentityParts(identity);
  const keyBase = useMemo(
    () => [...base("api-usage", tenantId, role), userId, viewerState] as const,
    [role, tenantId, userId, viewerState],
  );
  const adminKeyBase = useMemo(
    () => [...keyBase, "admin-protected"] as const,
    [keyBase],
  );
  const previousAdminKeyRef = useRef<readonly unknown[] | null>(null);

  const summary = useQuery({
    queryKey: [...adminKeyBase, "summary"],
    queryFn: getApiUsageSummary,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.dashboard,
  });
  const keys = useQuery({
    queryKey: [...adminKeyBase, "keys"],
    queryFn: getApiUsageKeys,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.dashboard,
  });
  const series = useQuery({
    queryKey: [...adminKeyBase, "timeseries"],
    queryFn: getApiUsageTimeseries,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.dashboard,
  });
  const costs = useQuery({
    queryKey: [...keyBase, "costs", costWindow, costGroup],
    queryFn: ({ signal }) =>
      getCostAggregate({ since: costWindow, groupBy: costGroup, signal }),
    enabled: meQuery.isSuccess,
    staleTime: STALE.dashboard,
    retry: false,
  });
  const ledger = useInfiniteQuery({
    queryKey: [...keyBase, "cost-ledger", costWindow],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      getCostLedgerPage({
        since: costWindow,
        limit: 50,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      }),
    getNextPageParam: (lastPage, _pages, _lastPageParam, pageParams) =>
      lastPage.nextCursor && !pageParams.includes(lastPage.nextCursor)
        ? lastPage.nextCursor
        : undefined,
    enabled: meQuery.isSuccess && ledgerOpen,
    staleTime: STALE.dashboard,
    retry: false,
  });

  const s = summary.data;
  const keyRows = Array.isArray(keys.data?.keys) ? keys.data.keys : [];
  const points = Array.isArray(series.data?.points) ? series.data.points : [];
  const daysWithActivity = activeDays(points);
  const ledgerRows = useMemo(() => {
    const byId = new Map<number, CostLedgerRow>();
    const pages = Array.isArray(ledger.data?.pages) ? ledger.data.pages : [];
    for (const page of pages) {
      for (const row of page.rows) byId.set(row.id, row);
    }
    return [...byId.values()].sort((a, b) => b.id - a.id);
  }, [ledger.data?.pages]);

  useEffect(() => {
    const previous = previousAdminKeyRef.current;
    if (previous && previous !== adminKeyBase) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
    }
    previousAdminKeyRef.current = adminKeyBase;
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    void queryClient.cancelQueries({ queryKey: adminKeyBase });
    queryClient.removeQueries({ queryKey: adminKeyBase });
  }, [
    adminKeyBase,
    canAdmin,
    meQuery.isPending,
    meQuery.isSuccess,
    queryClient,
  ]);

  if (meQuery.isLoading || meQuery.isError) {
    return (
      <DataSurfaceShell className="max-w-5xl">
        <DataSurfaceHeader
          icon={Activity}
          eyebrow="Developer operations"
          title="API usage"
          description="Monitor what each API key has sent, the measured cost of those requests, and a clearly separated 30-day extrapolation."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Usage requests were not started without a verified workspace context, so no values are being shown as zero."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-5xl">
      <DataSurfaceHeader
        icon={Activity}
        eyebrow="Developer operations"
        title="API usage"
        description="Monitor what each API key has sent, the measured cost of those requests, and a clearly separated 30-day extrapolation."
      />

      <DataSection
        id="au-actual"
        title={s ? `Measured · last ${s.window_days} days` : "Measured usage"}
        description="Observed requests and cost in this reporting window. These values are measurements, not projections."
        aside={
          s?.since ? (
            <Badge variant="outline">
              Since {formatUsageDate(s.since, "unknown")}
            </Badge>
          ) : undefined
        }
      >
        {!canAdmin ? (
          <p
            className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
            role="status"
          >
            {ADMIN_READ_ONLY_MESSAGE} API-key usage was not fetched.
          </p>
        ) : summary.isLoading ? (
          <SectionSkeleton rows={2} />
        ) : summary.isError ? (
          <QueryError
            title="API usage could not be loaded"
            description="Nothing has been shown as zero—an unreadable meter is not a zero bill."
            onRetry={() => void summary.refetch()}
          />
        ) : s ? (
          <>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
              {[
                ["Active keys", String(s.active_keys)],
                ["Sends", s.total_sends.toLocaleString()],
                ["Cost", formatCents(s.total_cost_cents)],
                ["Sends / day", s.avg_sends_per_day.toLocaleString()],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="min-w-0 rounded-lg border bg-muted/15 p-3"
                >
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="mt-1 break-words text-lg font-semibold tabular-nums sm:text-xl">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 rounded-xl border border-warning/35 bg-warning-subtle/60 p-4">
              <div className="flex items-start gap-3">
                <TrendingUp
                  aria-hidden
                  className="mt-0.5 size-5 shrink-0 text-warning-emphasis"
                />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">30-day projection</h3>
                  {/* Labelled as extrapolation, not forecast — nobody has
                      committed to this number and it is not an invoice. */}
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Straight-line extrapolation from the {s.window_days} days
                    above, not a quote:{" "}
                    <strong className="font-medium text-foreground tabular-nums">
                      {s.projected_30d_sends.toLocaleString()} sends
                    </strong>{" "}
                    costing{" "}
                    <strong className="font-medium text-foreground tabular-nums">
                      {formatCents(s.projected_30d_cost_cents)}
                    </strong>{" "}
                    over 30 days.
                  </p>
                  {s.total_sends === 0 ? (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      There were no sends to extrapolate from. Zero here means
                      no observed activity, not a low forecast.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No usage summary was returned.
          </p>
        )}
      </DataSection>

      <DataSection
        id="au-keys"
        title="Per key"
        description="A key-level breakdown uses its own reporting window, which can differ from the measured summary."
        aside={
          keys.isSuccess ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {keyRows.length} used · {keys.data?.window_days ?? 0} days
            </span>
          ) : undefined
        }
      >
        {!canAdmin ? (
          <p
            className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
            role="status"
          >
            {ADMIN_READ_ONLY_MESSAGE} Per-key activity was not fetched.
          </p>
        ) : keys.isLoading ? (
          <SectionSkeleton rows={2} />
        ) : keys.isError ? (
          <QueryError
            title="Per-key usage could not be loaded"
            description="The summary above may still be accurate, but its distribution across keys is unavailable."
            onRetry={() => void keys.refetch()}
          />
        ) : keyRows.length === 0 ? (
          <div className="rounded-xl border border-dashed p-5 text-center">
            <KeyRound
              aria-hidden
              className="mx-auto size-6 text-muted-foreground"
            />
            <p className="mt-2 text-sm font-medium">No key activity</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No API key made a request in this {keys.data?.window_days ?? 0}
              -day window.
            </p>
          </div>
        ) : (
          <UsageKeyRows rows={keyRows} />
        )}
      </DataSection>

      <DataSection
        id="au-series"
        title="Daily activity"
        description="Recent request volume and cost. The bar scale is relative to the busiest reported day."
        aside={
          series.isSuccess ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {points.length} reported · {daysWithActivity} active
            </span>
          ) : undefined
        }
      >
        {!canAdmin ? (
          <p
            className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
            role="status"
          >
            {ADMIN_READ_ONLY_MESSAGE} API-key timeseries data was not fetched.
          </p>
        ) : series.isLoading ? (
          <SectionSkeleton rows={4} />
        ) : series.isError ? (
          <QueryError
            title="Daily usage could not be loaded"
            description="No activity pattern has been inferred from the summary alone."
            onRetry={() => void series.refetch()}
          />
        ) : points.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            No daily usage points were reported for this window.
          </p>
        ) : daysWithActivity === 0 ? (
          <div className="rounded-xl border border-dashed p-5 text-center">
            <CalendarDays
              aria-hidden
              className="mx-auto size-6 text-muted-foreground"
            />
            <p className="mt-2 text-sm font-medium">No recorded activity</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {points.length} days were reported, all with zero sends and zero
              cost. A per-day average over this series would divide by days that
              never had traffic.
            </p>
          </div>
        ) : (
          <DailyUsageRows points={points} />
        )}
      </DataSection>

      <DataSection
        id="au-cost-ledger"
        title="Platform cost ledger"
        description="Server-metered billable work across sends, AI operations, rendering, storage, and migrations. Totals are measured ledger entries, not the API-usage projection above."
        aside={
          costs.data?.since ? (
            <Badge variant="outline">
              Since {formatUsageDate(costs.data.since, "unknown")}
            </Badge>
          ) : undefined
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="cost-window">Reporting window</Label>
            <Select
              id="cost-window"
              value={costWindow}
              onChange={(event) => setCostWindow(event.target.value)}
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cost-group">Group measured cost by</Label>
            <Select
              id="cost-group"
              value={costGroup}
              onChange={(event) =>
                setCostGroup(event.target.value as CostGroupBy)
              }
            >
              <option value="kind">Operation kind</option>
              <option value="api_key_id">API key</option>
              <option value="day">Day</option>
            </Select>
          </div>
        </div>

        {costs.isPending ? (
          <SectionSkeleton rows={4} />
        ) : costs.isError ? (
          <QueryError
            title="Cost aggregate could not be loaded"
            description="No failed meter read is being represented as a zero bill. Retry to verify this ledger window."
            onRetry={() => void costs.refetch()}
          />
        ) : (costs.data?.rows?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed p-5 text-center">
            <ReceiptText
              aria-hidden
              className="mx-auto size-6 text-muted-foreground"
            />
            <p className="mt-2 text-sm font-medium">No metered costs</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The server verified that this ledger window contains no billable
              entries.
            </p>
          </div>
        ) : (
          <CostAggregateRows
            rows={Array.isArray(costs.data?.rows) ? costs.data.rows : []}
            by={costGroup}
          />
        )}

        <div className="mt-4 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            aria-expanded={ledgerOpen}
            aria-controls="cost-ledger-rows"
            onClick={() => setLedgerOpen((open) => !open)}
          >
            <ReceiptText aria-hidden />
            {ledgerOpen ? "Hide itemized ledger" : "Show itemized ledger"}
          </Button>
          {ledgerOpen ? (
            <div id="cost-ledger-rows" className="mt-3 space-y-3">
              {ledger.isPending ? <SectionSkeleton rows={4} /> : null}
              {ledger.isError ? (
                <QueryError
                  title="Itemized cost ledger could not be loaded"
                  description={
                    ledgerRows.length > 0
                      ? "The previously verified rows remain visible, but the next page could not be verified."
                      : "No entries are being hidden behind a false empty state. Retry the ledger request."
                  }
                  onRetry={() => {
                    if (ledgerRows.length > 0 && ledger.hasNextPage) {
                      void loadNextQueryPage(ledger, ledger.isEnabled);
                    } else {
                      void ledger.refetch();
                    }
                  }}
                />
              ) : null}
              {!ledger.isPending &&
              !ledger.isError &&
              ledgerRows.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  The itemized ledger is verified empty for this window.
                </p>
              ) : null}
              {ledgerRows.length > 0 ? (
                <CostLedgerRows rows={ledgerRows} />
              ) : null}
              {ledger.hasNextPage && !ledger.isError ? (
                <Button
                  type="button"
                  variant="outline"
                  loading={ledger.isFetchingNextPage}
                  onClick={() =>
                    void loadNextQueryPage(ledger, ledger.isEnabled)
                  }
                >
                  Load more entries
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </DataSection>
    </DataSurfaceShell>
  );
}

function formatUsageDate(value: string, fallback = "Unknown date"): string {
  return formatWireTimestamp(value, fallback, (date) =>
    date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  );
}

function UsageKeyRows({ rows }: { rows: unknown[] }) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border">
      {rows.map((row, index) => {
        const record =
          row && typeof row === "object" && !Array.isArray(row)
            ? (row as Record<string, unknown>)
            : {};
        const name =
          record.name ?? record.label ?? record.key_prefix ?? record.id;
        const sends = numberValue(record.sends ?? record.total_sends);
        const cost = numberValue(record.cost_cents ?? record.total_cost_cents);
        return (
          <li
            key={`${String(record.id ?? name ?? "key")}-${index}`}
            className="grid min-w-0 gap-2 p-3.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4"
          >
            <span className="min-w-0 break-all font-mono text-xs font-medium">
              {String(name ?? `API key ${index + 1}`)}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {sends.toLocaleString()} sends
            </span>
            <span className="tabular-nums text-muted-foreground sm:text-right">
              {formatCents(cost)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DailyUsageRows({
  points,
}: {
  points: Array<{ date: string; sends: number; cost_cents: number }>;
}) {
  const recent = points.slice(-14);
  const max = Math.max(...recent.map((point) => point.sends), 1);
  return (
    <div>
      {points.length > recent.length ? (
        <p className="mb-3 text-xs text-muted-foreground">
          Showing the most recent {recent.length} of {points.length} days.
        </p>
      ) : null}
      <ol className="space-y-2">
        {recent.map((point) => (
          <li
            key={point.date}
            className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-xs sm:grid-cols-[5rem_minmax(0,1fr)_7rem]"
          >
            <time dateTime={point.date} className="text-muted-foreground">
              {formatUsageDate(point.date)}
            </time>
            <div
              className="h-2.5 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${point.sends.toLocaleString()} sends on ${formatUsageDate(point.date)}`}
            >
              <div
                className="h-full min-w-px rounded-full bg-primary"
                style={{ width: `${Math.max((point.sends / max) * 100, 1)}%` }}
              />
            </div>
            <span className="col-start-2 flex justify-between gap-2 tabular-nums text-muted-foreground sm:col-start-3 sm:block sm:text-right">
              <span>{point.sends.toLocaleString()} sends</span>
              <span className="sm:ml-2">{formatCents(point.cost_cents)}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function CostAggregateRows({
  rows,
  by,
}: {
  rows: CostAggregateRow[];
  by: CostGroupBy;
}) {
  const totals = rows.reduce(
    (sum, row) => ({
      cents: sum.cents + row.cents,
      quantity: sum.quantity + row.quantity,
      count: sum.count + row.count,
    }),
    { cents: 0, quantity: 0, count: 0 },
  );
  return (
    <div
      role="region"
      aria-label={`Measured platform costs grouped by ${costGroupTitle(by)}`}
      tabIndex={0}
      className="overflow-x-auto rounded-xl border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full min-w-[36rem] text-left text-sm">
        <caption className="sr-only">
          Measured platform costs grouped by {costGroupTitle(by)}
        </caption>
        <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {costGroupTitle(by)}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Entries
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Quantity
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, index) => (
            <tr key={`${costAggregateLabel(row, by)}-${index}`}>
              <th scope="row" className="px-3 py-2 font-medium">
                {costAggregateLabel(row, by)}
              </th>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {row.count.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {row.quantity.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {formatCents(row.cents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t bg-muted/20 font-medium">
          <tr>
            <th scope="row" className="px-3 py-2">
              Total
            </th>
            <td className="px-3 py-2 text-right tabular-nums">
              {totals.count.toLocaleString()}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {totals.quantity.toLocaleString()}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {formatCents(totals.cents)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function CostLedgerRows({
  rows,
}: {
  rows: Array<{
    id: number;
    apiKeyId: string | null;
    actorType: string | null;
    kind: string;
    cents: number;
    quantity: number;
    at: string;
  }>;
}) {
  return (
    <div
      role="region"
      aria-label="Itemized platform cost ledger"
      tabIndex={0}
      className="overflow-x-auto rounded-xl border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full min-w-[42rem] text-left text-sm">
        <caption className="sr-only">Itemized platform cost ledger</caption>
        <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              When
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Kind
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Attribution
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Quantity
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                <time dateTime={row.at}>{formatLedgerDate(row.at)}</time>
              </td>
              <td className="px-3 py-2 font-medium">
                {humanizeKind(row.kind)}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {row.apiKeyId
                  ? `Key ${maskIdentifier(row.apiKeyId)}`
                  : row.actorType
                    ? humanizeKind(row.actorType)
                    : "Workspace"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {row.quantity.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {formatCents(row.cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function costGroupTitle(by: CostGroupBy): string {
  return by === "kind" ? "Operation kind" : by === "day" ? "Day" : "API key";
}

function costAggregateLabel(row: CostAggregateRow, by: CostGroupBy): string {
  if (by === "kind") return humanizeKind(row.kind ?? "unattributed");
  if (by === "day") return row.day ? formatUsageDate(row.day) : "Unknown day";
  return row.apiKeyId ? `Key ${maskIdentifier(row.apiKeyId)}` : "Unattributed";
}

function maskIdentifier(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function humanizeKind(value: string): string {
  return value
    .replace(/_/gu, " ")
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === "ai") return "AI";
      if (lower === "api") return "API";
      return lower ? `${lower[0]?.toUpperCase()}${lower.slice(1)}` : "";
    })
    .join(" ");
}

function formatLedgerDate(value: string): string {
  return formatWireTimestamp(value, "Unknown time", (date) =>
    date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  );
}
