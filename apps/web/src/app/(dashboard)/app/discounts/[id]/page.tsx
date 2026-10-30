// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, RefreshCw, ShieldCheck, TicketPercent } from "lucide-react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
import { ApiError } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  discountAppliesToLabel,
  canonicalDiscountRecordId,
  discountHistoryIssueLabel,
  discountHistoryState,
  discountValueLabel,
  listDiscountHistory,
  listDiscountRedemptionEvents,
  type DiscountHistoryState,
} from "@/lib/discounts-api";
import { formatCount, formatLocaleDate } from "@/lib/format-currency";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

const EVENTS_PER_PAGE = 25;
const MAX_EVENT_PAGE = Math.floor(10_000 / EVENTS_PER_PAGE) + 1;

function eventPage(value: string | null): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_EVENT_PAGE) : 1;
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export default function DiscountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const queryClient = useQueryClient();
  const { id } = use(params);
  const canonicalRecordId = canonicalDiscountRecordId(id);
  const validRecordId = canonicalRecordId !== null;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawPage = searchParams.get("page");
  const page = eventPage(rawPage);
  const [deniedScope, setDeniedScope] = useState<string | null>(null);
  const [eventsDeniedScope, setEventsDeniedScope] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (rawPage === null || rawPage === String(page)) return;
    const query = new URLSearchParams(searchParams.toString());
    if (page === 1) query.delete("page");
    else query.set("page", String(page));
    const suffix = query.toString();
    router.replace(asRoute(suffix ? `${pathname}?${suffix}` : pathname), {
      scroll: false,
    });
  }, [page, pathname, rawPage, router, searchParams]);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const baseKey = useMemo(
    () => base("discounts", tenantId, role),
    [role, tenantId],
  );
  const cacheScope = `${tenantId}:${role ?? "unknown"}`;
  const historyKey = useMemo(
    () => [...baseKey, "history-record", canonicalRecordId] as const,
    [baseKey, canonicalRecordId],
  );

  const historyQuery = useQuery({
    queryKey: historyKey,
    queryFn: () =>
      listDiscountHistory({
        limit: 1,
        offset: 0,
        recordId: canonicalRecordId!,
      }),
    enabled: meQuery.isSuccess && validRecordId && deniedScope !== cacheScope,
    retry: (failureCount, error) => !isAccessDenied(error) && failureCount < 2,
    staleTime: STALE.list,
  });
  const serverDenied = isAccessDenied(historyQuery.error);
  const historyAccessDenied = serverDenied || deniedScope === cacheScope;
  useEffect(() => {
    if (!serverDenied) return;
    setDeniedScope(cacheScope);
    setEventsDeniedScope(cacheScope);
    queryClient.removeQueries({ queryKey: baseKey, exact: false });
  }, [baseKey, cacheScope, queryClient, serverDenied]);
  const record = useMemo(
    () =>
      historyAccessDenied
        ? null
        : (historyQuery.data?.items?.find(
            (candidate) => candidate.id === canonicalRecordId,
          ) ?? null),
    [canonicalRecordId, historyAccessDenied, historyQuery.data],
  );

  const eventsQuery = useQuery({
    queryKey: [
      ...baseKey,
      "redemption-events",
      canonicalRecordId,
      page,
    ] as const,
    queryFn: () =>
      listDiscountRedemptionEvents(canonicalRecordId!, {
        limit: EVENTS_PER_PAGE,
        offset: (page - 1) * EVENTS_PER_PAGE,
      }),
    enabled:
      meQuery.isSuccess && Boolean(record) && eventsDeniedScope !== cacheScope,
    retry: (failureCount, error) => !isAccessDenied(error) && failureCount < 2,
    staleTime: STALE.list,
  });
  const eventsServerDenied = isAccessDenied(eventsQuery.error);
  const eventsAccessDenied =
    eventsServerDenied || eventsDeniedScope === cacheScope;
  useEffect(() => {
    if (!eventsServerDenied) return;
    setEventsDeniedScope(cacheScope);
    queryClient.removeQueries({
      queryKey: [...baseKey, "redemption-events"],
      exact: false,
    });
  }, [baseKey, cacheScope, canonicalRecordId, eventsServerDenied, queryClient]);

  function changePage(nextPage: number): void {
    const safePage = Math.max(1, Math.min(MAX_EVENT_PAGE, nextPage));
    const query = new URLSearchParams(searchParams.toString());
    if (safePage === 1) query.delete("page");
    else query.set("page", String(safePage));
    const suffix = query.toString();
    router.push(asRoute(suffix ? `${pathname}?${suffix}` : pathname), {
      scroll: false,
    });
  }

  return (
    <PageShell className="max-w-5xl">
      <Breadcrumb
        className="[&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center [&_a]:justify-center sm:[&_a]:min-h-0 sm:[&_a]:min-w-0"
        items={[
          { label: "Discount history", href: "/app/discounts" },
          { label: record?.label ?? "Historical record" },
        ]}
      />

      <header className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <Archive className="h-4 w-4" aria-hidden />
          Historical discount record
        </div>
        <h1 className="mt-2 break-words font-display text-2xl font-semibold tracking-tight md:text-3xl">
          {record?.label ?? "Discount record details"}
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          Stored terms, local counters, and a PII-free recent-event timeline.
        </p>
      </header>

      {meQuery.isError ? (
        <AccessError
          loading={meQuery.isFetching}
          onRetry={() => void meQuery.refetch()}
        />
      ) : !validRecordId ? (
        <TerminalState
          title="Invalid discount archive link"
          description="This saved link does not contain an opaque discount record ID. No code lookup or event request was attempted."
        />
      ) : historyQuery.isPending && !record ? (
        <DiscountDetailSkeleton />
      ) : historyAccessDenied || (historyQuery.isError && !record) ? (
        <TerminalState
          title={
            historyAccessDenied
              ? "Discount history access is unavailable"
              : "Discount history could not be loaded"
          }
          description={
            historyAccessDenied
              ? "This workspace role does not have permission to read the historical report."
              : "The archive request failed, so this record is not being presented as missing."
          }
          onRetry={
            historyAccessDenied ? undefined : () => void historyQuery.refetch()
          }
          retrying={historyQuery.isFetching}
        />
      ) : !record ? (
        <TerminalState
          title="Historical record not found"
          description="The opaque record ID is not present in the current workspace archive, or the saved link is no longer current."
        />
      ) : (
        <>
          {historyQuery.isError ? (
            <div
              role="alert"
              className="rounded-lg border border-warning/40 bg-warning-subtle p-4"
            >
              <p className="font-medium text-warning-emphasis">
                Snapshot refresh failed
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Showing the last verified historical record. Retry to check for
                a newer snapshot.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3 min-h-11 gap-2 sm:min-h-9"
                loading={historyQuery.isFetching}
                onClick={() => void historyQuery.refetch()}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Retry refresh
              </Button>
            </div>
          ) : null}
          <section
            aria-label="Historical discount summary"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Stat label="Stored benefit" value={discountValueLabel(record)} />
            <Stat
              label="Recorded uses"
              value={
                record.max_redemptions !== null
                  ? `${formatCount(record.times_redeemed)} of ${formatCount(record.max_redemptions)}`
                  : `${formatCount(record.times_redeemed)} · no stored cap`
              }
            />
            <Stat
              label="Stored expiry"
              value={
                record.expires_at
                  ? formatLocaleDate(record.expires_at)
                  : "No stored expiry"
              }
            />
            <Stat
              label="Local evaluation"
              value={<HistoryStateBadge state={discountHistoryState(record)} />}
            />
          </section>

          {record.issues.length > 0 ? (
            <Card role="alert" className="border-warning/40">
              <CardHeader>
                <CardTitle as="h2" className="text-base">
                  Stored data needs review
                </CardTitle>
                <CardDescription>
                  This readable legacy record is retained, but affected values
                  are not treated as valid discount terms.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {record.issues.map((issue) => (
                    <li key={issue}>{discountHistoryIssueLabel(issue)}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="text-base">
                Stored record context
              </CardTitle>
              <CardDescription>
                Archive fields only; none of these values verifies a provider or
                checkout.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
              <RecordField
                label="Stored scope"
                value={discountAppliesToLabel(record.applies_to)}
              />
              <RecordField
                label="Recorded at"
                value={formatLocaleDate(record.created_at)}
              />
              <RecordField
                label="Archive identifier"
                value={
                  <span className="break-all font-mono text-xs">
                    {record.id}
                  </span>
                }
              />
            </CardContent>
          </Card>

          <section
            aria-labelledby="detail-evidence-boundary"
            className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/[0.035] p-4 text-sm"
          >
            <ShieldCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
              aria-hidden
            />
            <div>
              <h2 id="detail-evidence-boundary" className="font-medium">
                Inspection only
              </h2>
              <p className="mt-1 leading-5 text-muted-foreground">
                This record cannot be checked, edited, deleted, redeemed, or
                exported here. “Within stored rules” is not a promise that a
                checkout accepts any discount.
              </p>
            </div>
          </section>

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="text-base">
                Recorded redemption events
              </CardTitle>
              <CardDescription>
                Newest first · page {page.toLocaleString()}. Subscriber linkage
                is a boolean; identities are withheld. This bounded page does
                not reconcile the stored counter or prove complete event
                lineage.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {eventsAccessDenied ? (
                <div
                  role="alert"
                  className="rounded-lg border border-warning/40 bg-warning-subtle p-4"
                >
                  <p className="font-medium text-warning-emphasis">
                    Event-history access is unavailable
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This workspace role cannot read the sanitized event
                    timeline.
                  </p>
                </div>
              ) : eventsQuery.isPending ? (
                <TableSkeleton rows={5} columns={["w-28", "w-32"]} />
              ) : eventsQuery.isError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
                >
                  <p className="font-medium text-destructive">
                    Recorded events could not be loaded
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The request failed, so this page is not being shown as
                    empty.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4 min-h-11 gap-2 sm:min-h-9"
                    loading={eventsQuery.isFetching}
                    onClick={() => void eventsQuery.refetch()}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Try again
                  </Button>
                </div>
              ) : eventsQuery.data.items.length === 0 ? (
                <EmptyState
                  icon={TicketPercent}
                  title={
                    page === 1
                      ? "No recorded events"
                      : "No recorded events on this page"
                  }
                  description={
                    page === 1
                      ? "The archive returned a confirmed empty event timeline for this record."
                      : "The saved page number is beyond the currently available event history."
                  }
                  action={
                    page > 1 ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 sm:min-h-9"
                        onClick={() => changePage(page - 1)}
                      >
                        Previous page
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="space-y-4">
                  <TableContainer aria-label="Recorded discount redemption events">
                    <Table className="min-w-[480px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Subscriber linkage</TableHead>
                          <TableHead scope="col">Recorded</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {eventsQuery.data.items.map((event, index) => (
                          <TableRow key={`${event.redeemed_at}:${index}`}>
                            <TableCell>
                              <Badge
                                variant={
                                  event.subscriber_linked
                                    ? "secondary"
                                    : "outline"
                                }
                              >
                                {event.subscriber_linked
                                  ? "Linked record"
                                  : "No linked record"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              <RelativeTime iso={event.redeemed_at} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <nav
                    aria-label="Recorded event pages"
                    className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span>
                      Page {page.toLocaleString()} · up to {EVENTS_PER_PAGE}
                      events
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 sm:min-h-9"
                        aria-label="Previous page"
                        disabled={page === 1}
                        onClick={() => changePage(page - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 sm:min-h-9"
                        aria-label="Next page"
                        disabled={
                          !eventsQuery.data.hasMore || page === MAX_EVENT_PAGE
                        }
                        onClick={() => changePage(page + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </nav>
                  {eventsQuery.data.hasMore && page === MAX_EVENT_PAGE ? (
                    <div
                      role="status"
                      className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm"
                    >
                      <p className="font-medium text-warning-emphasis">
                        Additional events exist beyond this view’s offset
                        boundary
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        The PII-free timeline stops at an offset of 10,000. This
                        page does not claim to show the record’s complete event
                        lineage.
                      </p>
                    </div>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </PageShell>
  );
}

function AccessError({
  loading,
  onRetry,
}: {
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card role="alert" className="border-destructive/30">
      <CardHeader>
        <CardTitle as="h2">Workspace access could not be verified</CardTitle>
        <CardDescription>
          This historical record was not requested because the current workspace
          could not be resolved.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          loading={loading}
          onClick={onRetry}
        >
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function TerminalState({
  title,
  description,
  onRetry,
  retrying = false,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-8 sm:py-12">
        <EmptyState
          icon={TicketPercent}
          title={title}
          description={description}
          action={
            onRetry ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 gap-2 sm:min-h-9"
                loading={retrying}
                onClick={onRetry}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Retry snapshot
              </Button>
            ) : (
              <Button asChild variant="outline" className="min-h-11 sm:min-h-9">
                <Link href="/app/discounts">Back to discount history</Link>
              </Button>
            )
          }
        />
      </CardContent>
    </Card>
  );
}

function DiscountDetailSkeleton() {
  return (
    <div aria-label="Loading historical discount record" className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-28 w-full" />
      <TableSkeleton rows={5} columns={["w-28", "w-32"]} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <div className="mt-2 break-words text-lg font-semibold tabular-nums">
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function RecordField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}

function HistoryStateBadge({ state }: { state: DiscountHistoryState }) {
  if (state === "data_issue") {
    return <Badge variant="warning">Data needs review</Badge>;
  }
  if (state === "expired") {
    return <Badge variant="secondary">Stored expiry passed</Badge>;
  }
  if (state === "cap_reached") {
    return <Badge variant="warning">Stored cap reached</Badge>;
  }
  return <Badge variant="success">Within stored rules</Badge>;
}
