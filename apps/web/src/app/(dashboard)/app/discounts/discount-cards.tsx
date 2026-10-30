// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  RefreshCw,
  TicketPercent,
} from "lucide-react";

import { TableSkeleton } from "@/components/dashboard/skeletons";
import {
  DiscountRecordFilters,
  discountRecordMatchesFilter,
  type DiscountRecordFilter,
} from "@/components/discounts/DiscountRecordFilters";
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
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  discountAppliesToLabel,
  discountHistoryIssueLabel,
  discountHistoryState,
  discountValueLabel,
  type DiscountHistoryRecord,
  type DiscountHistoryState,
} from "@/lib/discounts-api";
import { formatCount, formatLocaleDate } from "@/lib/format-currency";

type SortKey = "created" | "redemptions" | "label";
type SortDirection = "asc" | "desc";

function HistoryStateBadge({
  state,
  issueCount = 0,
}: {
  state: DiscountHistoryState;
  issueCount?: number;
}) {
  if (state === "data_issue") {
    return (
      <Badge variant="warning">
        Data needs review{issueCount > 0 ? ` · ${issueCount}` : ""}
      </Badge>
    );
  }
  if (state === "expired") {
    return <Badge variant="secondary">Stored expiry passed</Badge>;
  }
  if (state === "cap_reached") {
    return <Badge variant="warning">Stored cap reached</Badge>;
  }
  return <Badge variant="success">Within stored rules</Badge>;
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  const Icon = !active
    ? ChevronsUpDown
    : direction === "asc"
      ? ArrowUp
      : ArrowDown;
  return (
    <TableHead
      scope="col"
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex min-h-11 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 ${active ? "text-foreground" : ""}`}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <Icon className="h-3 w-3 opacity-70" aria-hidden />
      </button>
    </TableHead>
  );
}

function matchesSearch(record: DiscountHistoryRecord, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    record.label,
    discountValueLabel(record),
    record.currency,
    discountAppliesToLabel(record.applies_to),
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function DiscountHistoryCard({
  records,
  error = false,
  accessDenied = false,
  retrying = false,
  search = "",
  page = 1,
  hasMore = false,
  reachedOffsetLimit = false,
  onRetry,
  onClearSearch,
  onPageChange,
  onViewEvents,
}: {
  records: DiscountHistoryRecord[] | null;
  error?: boolean;
  accessDenied?: boolean;
  retrying?: boolean;
  search?: string;
  page?: number;
  hasMore?: boolean;
  reachedOffsetLimit?: boolean;
  onRetry?: () => void;
  onClearSearch?: () => void;
  onPageChange?: (page: number) => void;
  onViewEvents: (
    record: DiscountHistoryRecord,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filter, setFilter] = useState<DiscountRecordFilter>("all");

  const visibleRecords = useMemo(() => {
    if (!records) return null;
    const rows = records.filter((record) => {
      if (!matchesSearch(record, search)) return false;
      return discountRecordMatchesFilter(record, filter);
    });
    rows.sort((left, right) => {
      let comparison: number;
      if (sortKey === "redemptions") {
        comparison = left.times_redeemed - right.times_redeemed;
      } else if (sortKey === "label") {
        comparison = left.label.localeCompare(right.label, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      } else {
        comparison = Date.parse(left.created_at) - Date.parse(right.created_at);
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });
    return rows;
  }, [filter, records, search, sortDirection, sortKey]);

  const narrowed = Boolean(search.trim()) || filter !== "all";

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(key === "label" ? "asc" : "desc");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Historical discount records</CardTitle>
        <CardDescription>
          Sanitized local terms and counters. Labels are archive references, not
          redeemable codes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {records !== null && !accessDenied ? (
          <div className="mb-4 space-y-3">
            <DiscountRecordFilters
              records={records}
              filter={filter}
              onFilterChange={setFilter}
              search={search}
              onClearSearch={onClearSearch}
            />
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {visibleRecords?.length.toLocaleString() ?? "—"} matching on
              archive page {page.toLocaleString()}
            </p>
          </div>
        ) : null}
        {error && records !== null && !accessDenied ? (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-warning/40 bg-warning-subtle p-4"
          >
            <p className="font-medium text-warning-emphasis">
              Snapshot refresh failed
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Showing the last verified historical snapshot. Retry to check for
              a newer one.
            </p>
            {onRetry ? (
              <Button
                type="button"
                variant="outline"
                className="mt-3 min-h-11 gap-2 sm:min-h-9"
                loading={retrying}
                onClick={onRetry}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Retry refresh
              </Button>
            ) : null}
          </div>
        ) : null}
        {error && records === null ? (
          <div
            role="alert"
            className={`rounded-lg border p-4 ${
              accessDenied
                ? "border-warning/40 bg-warning-subtle"
                : "border-destructive/30 bg-destructive/10"
            }`}
          >
            <p
              className={`font-medium ${
                accessDenied ? "text-warning-emphasis" : "text-destructive"
              }`}
            >
              {accessDenied
                ? "Discount history access is unavailable"
                : "Discount history could not be loaded"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {accessDenied
                ? "This workspace role does not have permission to read the historical report."
                : "The snapshot request failed, so no historical data is being inferred."}
            </p>
            {!accessDenied && onRetry ? (
              <Button
                type="button"
                variant="outline"
                className="mt-4 min-h-11 gap-2 sm:min-h-9"
                loading={retrying}
                onClick={onRetry}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Retry snapshot
              </Button>
            ) : null}
          </div>
        ) : visibleRecords === null ? (
          <TableSkeleton
            rows={5}
            columns={["w-28", "w-20", "w-24", "w-20", "w-24", "w-28", "w-24"]}
          />
        ) : visibleRecords.length === 0 ? (
          <EmptyState
            icon={TicketPercent}
            title={
              narrowed
                ? "No historical records match on this page"
                : page > 1
                  ? "No historical records on this page"
                  : "No discount history on file"
            }
            description={
              narrowed
                ? "Change the page search or local-state filter. The underlying archive has not been modified."
                : page > 1
                  ? "This archive page is empty. Return to the previous page to continue reviewing stored records."
                  : "This is a confirmed empty archive, not an invitation to create a provider-backed discount."
            }
            action={
              narrowed && (onClearSearch || filter !== "all") ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => {
                    onClearSearch?.();
                    setFilter("all");
                  }}
                >
                  Reset page filters
                </Button>
              ) : page > 1 && onPageChange ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => onPageChange(page - 1)}
                >
                  Previous page
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableContainer aria-label="Historical discount records">
              <Table className="min-w-[1020px]">
                <TableHeader>
                  <TableRow>
                    <SortHeader
                      label="Record"
                      active={sortKey === "label"}
                      direction={sortDirection}
                      onClick={() => toggleSort("label")}
                    />
                    <TableHead scope="col">Stored benefit</TableHead>
                    <TableHead scope="col">Stored scope</TableHead>
                    <SortHeader
                      label="Recorded uses"
                      active={sortKey === "redemptions"}
                      direction={sortDirection}
                      onClick={() => toggleSort("redemptions")}
                    />
                    <TableHead scope="col">Stored expiry</TableHead>
                    <TableHead scope="col">Local evaluation</TableHead>
                    <SortHeader
                      label="Recorded"
                      active={sortKey === "created"}
                      direction={sortDirection}
                      onClick={() => toggleSort("created")}
                    />
                    <TableHead scope="col" className="text-right">
                      Inspect
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRecords.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/app/discounts/${encodeURIComponent(record.id)}`}
                          className="inline-flex min-h-11 max-w-[220px] items-center break-words text-primary underline-offset-4 hover:underline sm:min-h-0"
                        >
                          {record.label}
                        </Link>
                      </TableCell>
                      <TableCell>{discountValueLabel(record)}</TableCell>
                      <TableCell>
                        {discountAppliesToLabel(record.applies_to)}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {formatCount(record.times_redeemed)}
                        {record.max_redemptions !== null
                          ? ` of ${formatCount(record.max_redemptions)}`
                          : " · no stored cap"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {record.expires_at
                          ? formatLocaleDate(record.expires_at)
                          : "No stored expiry"}
                      </TableCell>
                      <TableCell>
                        <HistoryStateBadge
                          state={discountHistoryState(record)}
                          issueCount={record.issues.length}
                        />
                        {record.issues.length > 0 ? (
                          <span className="sr-only">
                            {record.issues
                              .map(discountHistoryIssueLabel)
                              .join(" ")}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <RelativeTime iso={record.created_at} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 sm:min-h-8"
                          aria-label={`View recent events for ${record.label}`}
                          onClick={(event) =>
                            onViewEvents(record, event.currentTarget)
                          }
                        >
                          Recent events
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
        {!error && records !== null && hasMore && reachedOffsetLimit ? (
          <div
            role="status"
            className="mt-4 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm"
          >
            <p className="font-medium text-warning-emphasis">
              Additional records exist beyond this view’s offset boundary
            </p>
            <p className="mt-1 text-muted-foreground">
              This bounded archive stops at an offset of 10,000. The current
              view does not claim to contain the complete workspace history.
            </p>
          </div>
        ) : null}
        {!error && records !== null && (page > 1 || hasMore) ? (
          <nav
            aria-label="Discount archive pages"
            className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
          >
            <span>Archive page {page.toLocaleString()} · up to 50 records</span>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                aria-label="Previous archive page"
                disabled={page === 1}
                onClick={() => onPageChange?.(page - 1)}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                aria-label="Next archive page"
                disabled={!hasMore || reachedOffsetLimit}
                onClick={() => onPageChange?.(page + 1)}
              >
                Next
              </Button>
            </div>
          </nav>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function CouponPoolsCard() {
  return (
    <Card role="status">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h2">Coupon pools</CardTitle>
          <Badge variant="secondary">Release-held</Badge>
        </div>
        <CardDescription>
          Provider-backed inventory and issuance are separate from the
          historical archive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm">
          <p className="font-medium">Inventory and issuance are unavailable</p>
          <p className="mt-1 max-w-3xl leading-6 text-muted-foreground">
            The production API does not mount coupon-pool list, detail, import,
            assignment, or status-change routes. No empty inventory or
            successful coupon allocation is being simulated here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
