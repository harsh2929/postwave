// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  usePathname,
  useRouter,
  useSearchParams,
  type ReadonlyURLSearchParams,
} from "next/navigation";
import {
  Award,
  BarChart3,
  Download,
  Gift,
  ImagePlus,
  Plus,
  RefreshCw,
  Trash2,
  Trophy,
} from "lucide-react";
import { toast } from "sonner";

import {
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { ReferralInstallCard } from "@/components/commerce/ReferralInstallCard";
import { ReferralLeaderboardCard } from "@/components/commerce/ReferralLeaderboardCard";
import { PageShell } from "@/components/dashboard/page-shell";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Asset } from "@/lib/assets-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { downloadTextFile } from "@/lib/download";
import { formatLocaleDate } from "@/lib/format-currency";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  getCurrentReferralProgram,
  getReferralStats,
  listReferralPayouts,
  referralPayoutsCsv,
  saveReferralProgram,
  updateReferralPayout,
  type ReferralMilestone,
  type ReferralPayout,
  type ReferralPayoutPage,
  type ReferralPayoutStatus,
  type ReferralProgram,
  type ReferralProgramInput,
  type ReferralStats,
} from "@/lib/referrals-api";
import {
  REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
  REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
  REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
  REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON,
} from "@/lib/referral-operational-availability";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { asRoute } from "@/lib/typed-routes";

// The library picker opens on demand from a milestone row; loading it lazily
// keeps the route under the dashboard bundle budget.
const AssetPickerDialog = dynamic(
  () =>
    import("@/components/assets/asset-picker-dialog").then(
      (module) => module.AssetPickerDialog,
    ),
  { loading: () => null },
);

const REFERRAL_TABS = ["overview", "payouts", "program"] as const;
type ReferralTab = (typeof REFERRAL_TABS)[number];
const PAYOUT_STATUSES = ["all", "pending", "approved", "paid"] as const;
type PayoutFilter = (typeof PAYOUT_STATUSES)[number];

export function referralTab(value: string | null): ReferralTab {
  return REFERRAL_TABS.includes(value as ReferralTab)
    ? (value as ReferralTab)
    : "overview";
}

export function referralPayoutFilter(value: string | null): PayoutFilter {
  return PAYOUT_STATUSES.includes(value as PayoutFilter)
    ? (value as PayoutFilter)
    : "all";
}

function updateSearch(
  current: ReadonlyURLSearchParams,
  updates: Record<string, string | null>,
): string {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(updates)) {
    if (!value) next.delete(key);
    else next.set(key, value);
  }
  return next.toString();
}

export default function ReferralsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tab = referralTab(searchParams.get("tab"));
  const payoutFilter = referralPayoutFilter(searchParams.get("status"));

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const role = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const canWrite = Boolean(
    meQuery.isSuccess && !meQuery.data?.viewer_mode && roleCanWrite(role),
  );
  const userId = meQuery.data?.user_id ?? "anon";
  const viewerState = meQuery.data?.viewer_mode
    ? "viewer-mode"
    : "durable-mode";
  const keyBase = useMemo(
    () =>
      [
        ...base("referrals", meQuery.data?.tenant_id ?? "anon", role),
        userId,
        viewerState,
      ] as const,
    [meQuery.data?.tenant_id, role, userId, viewerState],
  );
  const previousKeyRef = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    const previous = previousKeyRef.current;
    if (previous && previous !== keyBase) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
    }
    previousKeyRef.current = keyBase;
    if (meQuery.isSuccess) return;
    void queryClient.cancelQueries({ queryKey: keyBase });
    queryClient.removeQueries({ queryKey: keyBase });
  }, [keyBase, meQuery.isSuccess, queryClient]);

  const statsQuery = useQuery({
    queryKey: [...keyBase, "stats"],
    queryFn: getReferralStats,
    enabled: meQuery.isSuccess && tab === "overview",
    staleTime: STALE.dashboard,
  });
  // The leaderboard card owns its window-scoped queries under this prefix.
  const leaderboardKey = useMemo(() => [...keyBase, "leaderboard"], [keyBase]);
  const leaderboardFetching =
    useIsFetching({ queryKey: leaderboardKey }) > 0;
  const payoutsQuery = useQuery({
    queryKey: [...keyBase, "payouts", payoutFilter],
    queryFn: () =>
      listReferralPayouts(payoutFilter === "all" ? undefined : payoutFilter),
    enabled:
      meQuery.isSuccess &&
      tab === "payouts" &&
      REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
    staleTime: STALE.list,
  });
  const programQuery = useQuery({
    queryKey: [...keyBase, "program"],
    queryFn: getCurrentReferralProgram,
    enabled: meQuery.isSuccess && tab === "program",
    staleTime: STALE.reference,
  });

  const selectTab = (value: string) => {
    const nextTab = referralTab(value);
    const query = updateSearch(searchParams, {
      tab: nextTab === "overview" ? null : nextTab,
      status:
        nextTab === "payouts" && payoutFilter !== "all" ? payoutFilter : null,
    });
    router.push(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  };

  const refreshCurrent = () => {
    if (tab === "overview") {
      void Promise.all([
        statsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: leaderboardKey }),
      ]);
    } else if (tab === "payouts") {
      void payoutsQuery.refetch();
    } else {
      void programQuery.refetch();
    }
  };
  const refreshing =
    tab === "overview"
      ? statsQuery.isFetching || leaderboardFetching
      : tab === "payouts"
        ? payoutsQuery.isFetching
        : programQuery.isFetching;

  return (
    <PageShell className="max-w-5xl">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Award className="h-4 w-4" aria-hidden />
            Growth operations
          </div>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight md:text-3xl">
            Referrals
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Inspect credited conversions, fulfill earned rewards, and manage the
            milestone program without overstating failed or filtered data.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full gap-2 sm:min-h-9 sm:w-auto"
          loading={refreshing}
          disabled={!meQuery.isSuccess}
          onClick={refreshCurrent}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Refresh
        </Button>
      </header>

      {meQuery.isError ? (
        <Card role="alert" className="border-destructive/30">
          <CardHeader>
            <CardTitle as="h2">
              Workspace access could not be verified
            </CardTitle>
            <CardDescription>
              Referral data was not requested because the current workspace and
              role could not be resolved.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              loading={meQuery.isFetching}
              onClick={() => void meQuery.refetch()}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={selectTab}>
          <TabsList aria-label="Referral administration sections" tabIndex={0}>
            <TabsTrigger value="overview" className="gap-2">
              <BarChart3 className="h-4 w-4" aria-hidden />
              Overview
            </TabsTrigger>
            <TabsTrigger value="payouts" className="gap-2">
              <Gift className="h-4 w-4" aria-hidden />
              Reward fulfillment
            </TabsTrigger>
            <TabsTrigger value="program" className="gap-2">
              <Trophy className="h-4 w-4" aria-hidden />
              Program
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6 pt-3">
            <ReferralOverview
              statsQuery={statsQuery}
              keyBase={keyBase}
              leaderboardEnabled={meQuery.isSuccess && tab === "overview"}
            />
          </TabsContent>
          <TabsContent value="payouts" className="pt-3">
            {REFERRAL_PAYOUT_OPERATIONS_AVAILABLE ? (
              <PayoutsPanel
                canWrite={canWrite}
                filter={payoutFilter}
                query={payoutsQuery}
                onFilterChange={(status) => {
                  const query = updateSearch(searchParams, {
                    tab: "payouts",
                    status: status === "all" ? null : status,
                  });
                  router.push(asRoute(`${pathname}?${query}`), {
                    scroll: false,
                  });
                }}
                onChanged={() =>
                  void queryClient.invalidateQueries({
                    queryKey: [...keyBase, "payouts"],
                    exact: false,
                  })
                }
              />
            ) : (
              <ReferralReleaseHold
                title="Reward fulfillment is review-gated"
                reason={REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON}
              />
            )}
          </TabsContent>
          <TabsContent value="program" className="space-y-6 pt-3">
            <ProgramPanel
              canWrite={canWrite && REFERRAL_PROGRAM_MUTATIONS_AVAILABLE}
              writeUnavailableReason={
                REFERRAL_PROGRAM_MUTATIONS_AVAILABLE
                  ? undefined
                  : REFERRAL_PROGRAM_MUTATIONS_UNAVAILABLE_REASON
              }
              tenantId={meQuery.data?.tenant_id ?? ""}
              query={programQuery}
              onSaved={(next) =>
                queryClient.setQueryData([...keyBase, "program"], next)
              }
            />
            <ReferralInstallCard
              canAdmin={canWrite}
              hasProgram={Boolean(programQuery.data)}
            />
          </TabsContent>
        </Tabs>
      )}
    </PageShell>
  );
}

function ReferralOverview({
  statsQuery,
  keyBase,
  leaderboardEnabled,
}: {
  statsQuery: UseQueryResult<ReferralStats, Error>;
  keyBase: readonly unknown[];
  leaderboardEnabled: boolean;
}) {
  const funnel = statsQuery.data?.funnel;
  const recent = Array.isArray(statsQuery.data?.recent)
    ? statsQuery.data.recent
    : [];

  return (
    <>
      <section aria-labelledby="referral-conversions">
        <div className="mb-3">
          <h2 id="referral-conversions" className="text-lg font-semibold">
            Credited conversions
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Rolling conversion counts exclude fraud-filtered events.
          </p>
        </div>
        {statsQuery.isPending ? (
          <div
            className="grid gap-3 sm:grid-cols-3"
            aria-label="Loading conversion totals"
            aria-busy="true"
            role="status"
          >
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full" />
            ))}
          </div>
        ) : statsQuery.isError ? (
          <QueryError
            title="Referral totals could not be loaded"
            description="No zero values are shown because the stats request failed."
            retrying={statsQuery.isFetching}
            onRetry={() => void statsQuery.refetch()}
          />
        ) : funnel ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Last 7 days" value={funnel.conversions_7d} />
            <Metric label="Last 30 days" value={funnel.conversions_30d} />
            <Metric label="Last 90 days" value={funnel.conversions_90d} />
          </div>
        ) : (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Referral totals are unavailable.
          </p>
        )}
        {funnel ? (
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/15 p-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Historical link clicks
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">
                {funnel.clicks_total.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-lg border bg-muted/15 p-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Fraud-filtered conversions
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">
                {funnel.fraud_filtered_count.toLocaleString()}
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

      <ReferralLeaderboardCard keyBase={keyBase} enabled={leaderboardEnabled} />

      <Card>
        <CardHeader>
          <CardTitle as="h2">Recent credited conversions</CardTitle>
          <CardDescription>
            Newest first. Subscriber identities link to their workspace records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statsQuery.isPending ? (
            <TableSkeleton rows={4} columns={["w-36", "w-36", "w-24"]} />
          ) : statsQuery.isError ? (
            <p className="text-sm text-muted-foreground">
              Recent conversions are unavailable with the failed stats request.
            </p>
          ) : recent.length === 0 ? (
            <EmptyState
              icon={Award}
              title="No credited conversions yet"
              description="A conversion appears here only after referral attribution is credited."
            />
          ) : (
            <TableContainer aria-label="Recent referral conversions">
              <Table className="min-w-[600px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Referrer</TableHead>
                    <TableHead>Referred subscriber</TableHead>
                    <TableHead>Credited</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((row, index) => (
                    <TableRow
                      key={`${row.referrer_id}-${row.referee_id}-${row.created_at}-${index}`}
                    >
                      <TableCell>
                        <SubscriberLink id={row.referrer_id} />
                      </TableCell>
                      <TableCell>
                        <SubscriberLink id={row.referee_id} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <RelativeTime iso={row.created_at} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function SubscriberLink({ id }: { id: string }) {
  return (
    <Link
      href={`/app/subscribers/${encodeURIComponent(id)}`}
      className="inline-flex min-h-11 min-w-11 max-w-[240px] items-center justify-center break-all font-mono text-xs text-primary underline-offset-4 hover:underline sm:min-h-0 sm:min-w-0 sm:justify-start"
    >
      {id}
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">
          {value.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function PayoutsPanel({
  canWrite,
  filter,
  query,
  onFilterChange,
  onChanged,
}: {
  canWrite: boolean;
  filter: PayoutFilter;
  query: UseQueryResult<ReferralPayoutPage, Error>;
  onFilterChange: (filter: PayoutFilter) => void;
  onChanged: () => void;
}) {
  const exportGuard = useRef(false);
  const [exporting, setExporting] = useState(false);
  const rows = Array.isArray(query.data?.items) ? query.data.items : [];

  const exportCsv = async () => {
    if (exportGuard.current) return;
    exportGuard.current = true;
    setExporting(true);
    try {
      const csv = await referralPayoutsCsv();
      downloadTextFile(
        `referral-rewards-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
        "text/csv;charset=utf-8",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export the reward checklist.",
      );
    } finally {
      exportGuard.current = false;
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle as="h2">Reward fulfillment</CardTitle>
          <CardDescription className="max-w-2xl leading-5">
            Milestone rewards move forward only: pending → approved → paid.
            “Paid” records fulfillment; it does not itself transfer money.
          </CardDescription>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Select
            aria-label="Filter reward fulfillment by status"
            value={filter}
            className="w-full sm:w-36"
            onChange={(event) =>
              onFilterChange(event.target.value as PayoutFilter)
            }
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="paid">Paid</option>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full gap-2 sm:min-h-9 sm:w-auto"
            loading={exporting}
            onClick={() => void exportCsv()}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <TableSkeleton
            rows={5}
            columns={["w-32", "w-20", "w-40", "w-20", "w-24"]}
          />
        ) : query.isError ? (
          <QueryError
            title="Reward fulfillment could not be loaded"
            description="The request failed, so no empty checklist is being inferred."
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Gift}
            title={
              filter === "all"
                ? "No earned rewards yet"
                : `No ${filter} rewards`
            }
            description="Rows are derived from credited, fraud-filtered milestone achievements."
          />
        ) : (
          <div className="space-y-3">
            <TableContainer aria-label="Referral reward fulfillment checklist">
              <Table className="min-w-[820px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Referrer</TableHead>
                    <TableHead>Milestone</TableHead>
                    <TableHead>Reward</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.referrer_id ? (
                          <SubscriberLink id={row.referrer_id} />
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.milestone.toLocaleString()} referrals
                      </TableCell>
                      <TableCell className="max-w-[260px] break-words">
                        {row.reward_label || "Unlabelled reward"}
                      </TableCell>
                      <TableCell>
                        <PayoutStatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatLocaleDate(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {canWrite && row.status !== "paid" ? (
                          <PayoutAction row={row} onChanged={onChanged} />
                        ) : row.status === "paid" ? (
                          <span className="text-xs text-muted-foreground">
                            Complete
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Admin only
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <p className="text-xs text-muted-foreground">
              Showing {rows.length.toLocaleString()} of{" "}
              {query.data?.total.toLocaleString() ??
                rows.length.toLocaleString()}{" "}
              matching reward records.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PayoutAction({
  row,
  onChanged,
}: {
  row: ReferralPayout;
  onChanged: () => void;
}) {
  const guard = useRef(false);
  if (!REFERRAL_PAYOUT_OPERATIONS_AVAILABLE) {
    return <span className="text-xs text-muted-foreground">Review-gated</span>;
  }
  const next = row.status === "pending" ? "approved" : "paid";
  const label = next === "approved" ? "Approve" : "Mark paid";
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant={next === "approved" ? "outline" : "default"}
          size="sm"
          className="min-h-11 sm:min-h-8"
        >
          {label}
        </Button>
      }
      title={`${label} this reward?`}
      description={
        next === "approved"
          ? "Approval confirms the milestone reward is valid and ready for fulfillment."
          : "Mark paid only after the reward has actually been fulfilled. This action does not move money."
      }
      confirmLabel={label}
      confirmVariant={next === "approved" ? "default" : "destructive"}
      onConfirm={async () => {
        if (guard.current) return;
        guard.current = true;
        try {
          await updateReferralPayout(row.id, next);
          toast.success(
            next === "approved" ? "Reward approved." : "Reward marked paid.",
          );
          onChanged();
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not update the reward.",
          );
        } finally {
          guard.current = false;
        }
      }}
    />
  );
}

function PayoutStatusBadge({ status }: { status: ReferralPayoutStatus }) {
  if (status === "paid") return <Badge variant="success">Paid</Badge>;
  if (status === "approved") return <Badge variant="warning">Approved</Badge>;
  return <Badge variant="secondary">Pending</Badge>;
}

function ProgramPanel({
  canWrite,
  writeUnavailableReason,
  tenantId,
  query,
  onSaved,
}: {
  canWrite: boolean;
  writeUnavailableReason?: string;
  tenantId: string;
  query: UseQueryResult<ReferralProgram | null, Error>;
  onSaved: (next: ReferralProgram) => void;
}) {
  const holdNoteId = useId();
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle as="h2">Referral program</CardTitle>
          <CardDescription className="max-w-2xl leading-5">
            Saving replaces the active program. A concurrency guard prevents a
            stale browser tab from silently overwriting another admin’s work.
          </CardDescription>
        </div>
        {query.data ? (
          <Badge variant={query.data.active ? "success" : "secondary"}>
            {query.data.active ? "Active" : "Inactive"}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        {writeUnavailableReason ? (
          <div
            id={holdNoteId}
            role="note"
            className="mb-4 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis"
          >
            <p className="font-medium">Program changes are review-gated.</p>
            <p className="mt-1">{writeUnavailableReason}</p>
          </div>
        ) : null}
        {query.isPending ? (
          <div className="space-y-4" aria-label="Loading referral program">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : query.isError ? (
          <QueryError
            title="Referral program could not be loaded"
            description="Saving is unavailable until the current program state is known."
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : !query.data && !canWrite ? (
          <EmptyState
            icon={Trophy}
            title="No referral program is configured"
            description="Only workspace owners and admins can create the first program."
          />
        ) : (
          <ProgramEditor
            key={query.data?.id || "new-program"}
            initial={query.data}
            canWrite={canWrite}
            holdNoteId={writeUnavailableReason ? holdNoteId : undefined}
            tenantId={tenantId}
            onSaved={onSaved}
            onReload={() => void query.refetch()}
          />
        )}
      </CardContent>
    </Card>
  );
}

type RewardKind = NonNullable<ReferralMilestone["reward_kind"]> | "";
interface MilestoneDraft {
  key: string;
  count: string;
  rewardLabel: string;
  rewardKind: RewardKind;
  /** Library asset id for the reward image ("" = none). */
  imageAssetId: string;
  preserved: Omit<
    ReferralMilestone,
    "count" | "reward_label" | "reward_kind" | "reward_image_asset_id"
  >;
}

let milestoneKey = 0;
function draftMilestone(value?: ReferralMilestone): MilestoneDraft {
  const {
    count = 1,
    reward_label: rewardLabel = "",
    reward_kind: rewardKind = "",
    reward_image_asset_id: imageAssetId = "",
    ...preserved
  } = value ?? {};
  milestoneKey += 1;
  return {
    key: `milestone-${milestoneKey}`,
    count: String(count),
    rewardLabel,
    rewardKind,
    imageAssetId,
    preserved,
  };
}

function toLocalDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function ProgramEditor({
  initial,
  canWrite,
  holdNoteId,
  tenantId,
  onSaved,
  onReload,
}: {
  initial: ReferralProgram | null;
  canWrite: boolean;
  /** Id of the release-hold note when program writes are review-gated. */
  holdNoteId?: string;
  tenantId: string;
  onSaved: (next: ReferralProgram) => void;
  onReload: () => void;
}) {
  const guard = useRef(false);
  const readOnlyReasonId = useId();
  // The milestone row whose reward image is being chosen, or null.
  const [pickingKey, setPickingKey] = useState<string | null>(null);
  const pickerDescribedBy = holdNoteId ?? (canWrite ? undefined : readOnlyReasonId);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>(() =>
    initial?.milestones?.length
      ? initial.milestones.map(draftMilestone)
      : [draftMilestone({ count: 3, reward_label: "Free month" })],
  );
  const [expiresAt, setExpiresAt] = useState(() =>
    toLocalDateTime(initial?.expires_at),
  );
  const [verificationDays, setVerificationDays] = useState(
    initial?.verification_window_days
      ? String(initial.verification_window_days)
      : "",
  );
  const [refereeKind, setRefereeKind] = useState(
    initial?.referee_reward_kind ?? "",
  );
  const [refereeLabel, setRefereeLabel] = useState(
    initial?.referee_reward_label ?? "",
  );
  const [notice, setNotice] = useState<{
    kind: "success" | "error" | "conflict";
    text: string;
  } | null>(null);

  const parsedCounts = milestones.map((row) => Number(row.count));
  const countsValid = parsedCounts.every(
    (value) => Number.isInteger(value) && value >= 1 && value <= 1_000_000,
  );
  const countsUnique = new Set(parsedCounts).size === parsedCounts.length;
  const labelsValid = milestones.every(
    (row) =>
      row.rewardLabel.trim().length > 0 && row.rewardLabel.trim().length <= 200,
  );
  const verificationNumber = verificationDays.trim()
    ? Number(verificationDays)
    : undefined;
  const verificationValid =
    verificationNumber === undefined ||
    (Number.isInteger(verificationNumber) &&
      verificationNumber >= 1 &&
      verificationNumber <= 3650);
  const expiryTimestamp = expiresAt ? new Date(expiresAt).getTime() : undefined;
  const expiryValid =
    expiryTimestamp === undefined ||
    (Number.isFinite(expiryTimestamp) && expiryTimestamp > Date.now());
  const refereeLabelValid = refereeLabel.trim().length <= 200;
  const formValid =
    milestones.length > 0 &&
    milestones.length <= 50 &&
    countsValid &&
    countsUnique &&
    labelsValid &&
    verificationValid &&
    expiryValid &&
    refereeLabelValid;

  const mutation = useMutation({
    mutationFn: (input: ReferralProgramInput) =>
      saveReferralProgram(
        input,
        initial
          ? { expectedProgramId: initial.id }
          : { expectNoActiveProgram: true },
      ),
    onSuccess: (result) => {
      if ("conflict" in result) {
        setNotice({
          kind: "conflict",
          text: "Someone else changed the active program. Reload the server version before saving again; your current edits have not been submitted.",
        });
        return;
      }
      onSaved(result);
      setNotice({ kind: "success", text: "Referral program saved." });
      toast.success("Referral program saved.");
    },
    onError: (error) => {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "The referral program could not be saved.",
      });
    },
    onSettled: () => {
      guard.current = false;
    },
  });

  const patchMilestone = (key: string, patch: Partial<MilestoneDraft>) => {
    setNotice(null);
    setMilestones((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canWrite || !formValid || guard.current) return;
        guard.current = true;
        setNotice(null);
        const input: ReferralProgramInput = {
          milestones: milestones
            .map((row) => ({
              ...row.preserved,
              count: Number(row.count),
              reward_label: row.rewardLabel.trim(),
              ...(row.rewardKind ? { reward_kind: row.rewardKind } : {}),
              ...(row.imageAssetId
                ? { reward_image_asset_id: row.imageAssetId }
                : {}),
            }))
            .sort((a, b) => a.count - b.count),
          ...(expiresAt
            ? { expires_at: new Date(expiresAt).toISOString() }
            : {}),
          ...(refereeKind ? { referee_reward_kind: refereeKind } : {}),
          ...(refereeLabel.trim()
            ? { referee_reward_label: refereeLabel.trim() }
            : {}),
          ...(verificationNumber
            ? { verification_window_days: verificationNumber }
            : {}),
          ...(initial?.referee_reward_image_asset_id
            ? {
                referee_reward_image_asset_id:
                  initial.referee_reward_image_asset_id,
              }
            : {}),
          ...(initial?.reward_value_cents
            ? { reward_value_cents: initial.reward_value_cents }
            : {}),
          ...(initial?.reward_currency
            ? { reward_currency: initial.reward_currency }
            : {}),
          ...(initial?.reward_sku ? { reward_sku: initial.reward_sku } : {}),
        };
        mutation.mutate(input);
      }}
    >
      <section aria-labelledby="program-milestones" className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 id="program-milestones" className="font-medium">
              Milestones
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Counts must be unique. Rewards are evaluated against credited,
              fraud-filtered conversions.
            </p>
          </div>
          {canWrite ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full gap-2 sm:min-h-9 sm:w-auto"
              disabled={mutation.isPending || milestones.length >= 50}
              onClick={() =>
                setMilestones((rows) => [...rows, draftMilestone()])
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add milestone
            </Button>
          ) : null}
        </div>

        <div className="space-y-3">
          {milestones.map((row, index) => (
            <div
              key={row.key}
              className="grid gap-3 rounded-lg border bg-muted/10 p-4 sm:grid-cols-[8rem_10rem_minmax(0,1fr)_auto] sm:items-end"
            >
              <div className="space-y-1.5">
                <Label htmlFor={`${row.key}-count`}>Referrals</Label>
                <Input
                  id={`${row.key}-count`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1_000_000}
                  step={1}
                  required
                  value={row.count}
                  disabled={!canWrite || mutation.isPending}
                  onChange={(event) =>
                    patchMilestone(row.key, { count: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${row.key}-kind`}>Reward kind</Label>
                <Select
                  id={`${row.key}-kind`}
                  value={row.rewardKind}
                  disabled={!canWrite || mutation.isPending}
                  onChange={(event) =>
                    patchMilestone(row.key, {
                      rewardKind: event.target.value as RewardKind,
                    })
                  }
                >
                  <option value="">Server default (custom)</option>
                  <option value="swag">Swag</option>
                  <option value="free">Free service</option>
                  <option value="annual">Annual reward</option>
                  <option value="custom">Custom</option>
                </Select>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`${row.key}-label`}>Reward label</Label>
                <Input
                  id={`${row.key}-label`}
                  maxLength={200}
                  required
                  value={row.rewardLabel}
                  disabled={!canWrite || mutation.isPending}
                  placeholder="Free month"
                  onChange={(event) =>
                    patchMilestone(row.key, {
                      rewardLabel: event.target.value,
                    })
                  }
                />
              </div>
              {canWrite ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11 text-destructive hover:text-destructive sm:min-h-9 sm:min-w-9"
                  aria-label={`Remove milestone ${index + 1}`}
                  disabled={mutation.isPending || milestones.length === 1}
                  onClick={() =>
                    setMilestones((rows) =>
                      rows.filter((item) => item.key !== row.key),
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
              {/* Reward image (desktop: ProgramEditor "Choose image"). Held
                  the way desktop holds it: aria-disabled, described by the
                  release-hold note, and the picker never opens. */}
              <div className="col-span-full flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 gap-2 sm:min-h-8"
                  disabled={mutation.isPending}
                  aria-disabled={!canWrite || undefined}
                  aria-describedby={pickerDescribedBy}
                  onClick={() => {
                    if (canWrite) setPickingKey(row.key);
                  }}
                >
                  <ImagePlus className="h-4 w-4" aria-hidden />
                  {row.imageAssetId ? "Change image" : "Choose image"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {row.imageAssetId ? "Reward image selected" : "No image"}
                </span>
              </div>
            </div>
          ))}
        </div>
        {!canWrite && !holdNoteId ? (
          <p id={readOnlyReasonId} className="text-xs text-muted-foreground">
            Only workspace owners and admins can change reward images.
          </p>
        ) : null}
        {pickingKey !== null ? (
          <AssetPickerDialog
            open
            tenantId={tenantId}
            title="Choose a reward image"
            onOpenChange={(open) => {
              if (!open) setPickingKey(null);
            }}
            onPick={(asset: Asset) => {
              patchMilestone(pickingKey, { imageAssetId: asset.id });
            }}
          />
        ) : null}
        {!countsValid ? (
          <p className="text-sm text-destructive" role="alert">
            Every milestone count must be a whole number from 1 to 1,000,000.
          </p>
        ) : !countsUnique ? (
          <p className="text-sm text-destructive" role="alert">
            Milestone counts must be unique.
          </p>
        ) : !labelsValid ? (
          <p className="text-sm text-destructive" role="alert">
            Every reward needs a label of 200 characters or fewer.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="program-rules"
        className="space-y-3 border-t pt-5"
      >
        <div>
          <h3 id="program-rules" className="font-medium">
            Program rules
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Optional expiry and verification settings are sent with the full
            replacement so existing values are not silently discarded.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="referral-program-expiry">Program expires</Label>
            <Input
              id="referral-program-expiry"
              type="datetime-local"
              min={toLocalDateTime(new Date().toISOString())}
              aria-invalid={!expiryValid}
              aria-describedby={
                !expiryValid ? "referral-program-expiry-error" : undefined
              }
              value={expiresAt}
              disabled={!canWrite || mutation.isPending}
              onChange={(event) => {
                setNotice(null);
                setExpiresAt(event.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Blank means the program has no scheduled expiry.
            </p>
            {!expiryValid ? (
              <p
                id="referral-program-expiry-error"
                className="text-xs text-destructive"
                role="alert"
              >
                Choose a future expiry, or leave this blank.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="referral-verification-days">
              Verification window (days)
            </Label>
            <Input
              id="referral-verification-days"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              step={1}
              aria-invalid={!verificationValid}
              aria-describedby={
                !verificationValid
                  ? "referral-verification-days-error"
                  : undefined
              }
              value={verificationDays}
              disabled={!canWrite || mutation.isPending}
              onChange={(event) => {
                setNotice(null);
                setVerificationDays(event.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Blank keeps the server default.
            </p>
            {!verificationValid ? (
              <p
                id="referral-verification-days-error"
                className="text-xs text-destructive"
                role="alert"
              >
                Use a whole number from 1 to 3,650, or leave this blank.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="referral-referee-kind">
              New-subscriber reward kind
            </Label>
            <Select
              id="referral-referee-kind"
              value={refereeKind}
              disabled={!canWrite || mutation.isPending}
              onChange={(event) => {
                setNotice(null);
                setRefereeKind(event.target.value);
              }}
            >
              <option value="">Server default (custom)</option>
              <option value="swag">Swag</option>
              <option value="free">Free service</option>
              <option value="annual">Annual reward</option>
              <option value="custom">Custom</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="referral-referee-label">
              New-subscriber reward label
            </Label>
            <Input
              id="referral-referee-label"
              maxLength={200}
              aria-invalid={!refereeLabelValid}
              aria-describedby={
                !refereeLabelValid ? "referral-referee-label-error" : undefined
              }
              value={refereeLabel}
              disabled={!canWrite || mutation.isPending}
              placeholder="10% welcome credit"
              onChange={(event) => {
                setNotice(null);
                setRefereeLabel(event.target.value);
              }}
            />
            {!refereeLabelValid ? (
              <p
                id="referral-referee-label-error"
                className="text-xs text-destructive"
                role="alert"
              >
                Use 200 characters or fewer.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {notice ? (
        <div
          role={notice.kind === "success" ? "status" : "alert"}
          className={
            notice.kind === "success"
              ? "rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success-emphasis"
              : notice.kind === "conflict"
                ? "rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis"
                : "rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
          }
        >
          <p>{notice.text}</p>
          {notice.kind === "conflict" ? (
            <Button
              type="button"
              variant="outline"
              className="mt-3 min-h-11 sm:min-h-9"
              onClick={onReload}
            >
              Reload server version
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
        {!canWrite ? (
          <p className="text-xs text-muted-foreground">
            Only workspace owners and admins can replace the referral program.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {initial
              ? `Editing program ${initial.id}`
              : "Creating the first active program"}
          </p>
        )}
        <Button
          type="submit"
          className="min-h-11 w-full sm:min-h-9 sm:w-auto"
          loading={mutation.isPending}
          disabled={!canWrite || !formValid}
        >
          {initial ? "Save program" : "Create program"}
        </Button>
      </div>
    </form>
  );
}

function ReferralReleaseHold({
  title,
  reason,
}: {
  title: string;
  reason: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{title}</CardTitle>
        <CardDescription>
          This boundary is intentionally unavailable; no reward records or
          mutation controls were requested.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="rounded-md border border-warning/40 bg-warning-subtle p-4 text-sm text-warning-emphasis">
          {reason}
        </p>
      </CardContent>
    </Card>
  );
}

function QueryError({
  title,
  description,
  retrying,
  onRetry,
}: {
  title: string;
  description: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
    >
      <p className="font-medium text-destructive">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <Button
        type="button"
        variant="outline"
        className="mt-4 min-h-11 sm:min-h-9"
        loading={retrying}
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}
