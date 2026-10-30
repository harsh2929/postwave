// SPDX-License-Identifier: AGPL-3.0-only
//
// Migration history — the recent-migrations table plus the controls desktop's
// MigrationHistorySurface has and web lacked (analytics-106): Refresh, free-text
// search (job id / source / name / status), a page-size choice, and a pager
// that states "N matching · page x of y".
//
// Everything RecentMigrations already does is kept: status filter, sortable
// columns, Continue-into-the-wizard, View, the local dismiss ledger, and the
// principal/tenant reset. It is a drop-in replacement for <RecentMigrations>.
//
// Refresh re-runs the page's own queries — GET /api/v1/migrations (history)
// and GET /api/v1/migrations/sources (capabilities) — through `onRefresh`; the
// page is already admin-gated, so no extra role check lives here.
"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EyeOff, RefreshCw, RotateCcw, Search, X } from "lucide-react";

import { toRecentMigration } from "@/lib/migration-recent";
import {
  continueTarget,
  filterByStatus,
  isDismissable,
  MIGRATION_PAGE_SIZES,
  MIGRATION_STATUS_FILTERS,
  type MigrationPageSize,
  type MigrationSortKey,
  type MigrationStatusFilter,
  paginate,
  parseMigrationPageSize,
  readDismissed,
  searchRecent,
  sortRecent,
  type SortDir,
  writeDismissed,
} from "@/lib/migration-recent-list";
import {
  migrationStatusLabel,
  migrationStatusVariant,
} from "@/lib/migration-status";
import type { MigrationJob } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function isPreviewStatus(status: MigrationJob["status"]): boolean {
  return [
    "pending",
    "authenticating",
    "discovering",
    "dry_run",
    "awaiting_confirmation",
  ].includes(status);
}

export function MigrationHistory({
  jobs,
  principalKey,
  tenantId,
  onRefresh,
  refreshing = false,
}: {
  jobs: MigrationJob[];
  principalKey: string;
  tenantId: string;
  /**
   * Re-run the history + sources reads. When it returns a promise the button
   * shows "Refreshing…" until it settles.
   */
  onRefresh?: () => unknown;
  /** External in-flight flag (e.g. jobsQuery.isFetching). */
  refreshing?: boolean;
}) {
  const searchId = useId();
  const statusId = useId();
  const pageSizeId = useId();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<MigrationStatusFilter>("all");
  const [sortKey, setSortKey] = useState<MigrationSortKey>("started");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState<MigrationPageSize>(
    MIGRATION_PAGE_SIZES[0],
  );
  const [page, setPage] = useState(1);
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const refreshRef = useRef<Promise<unknown> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setDismissed(readDismissed(tenantId));
    setQuery("");
    setStatusFilter("all");
    setSortKey("started");
    setSortDir("desc");
    setPageSize(MIGRATION_PAGE_SIZES[0]);
    setPage(1);
    setShowDismissed(false);
  }, [principalKey, tenantId]);

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    writeDismissed(tenantId, next);
  };
  const restore = (id: string) => {
    const next = new Set(dismissed);
    next.delete(id);
    setDismissed(next);
    writeDismissed(tenantId, next);
    if (next.size === 0) setShowDismissed(false);
  };

  const allRows = useMemo(
    () => (Array.isArray(jobs) ? jobs : []).map(toRecentMigration),
    [jobs],
  );

  const visibleRows = useMemo(() => {
    const byDismiss = showDismissed
      ? allRows.filter((r) => dismissed.has(r.id))
      : allRows.filter((r) => !dismissed.has(r.id));
    return sortRecent(
      searchRecent(filterByStatus(byDismiss, statusFilter), query),
      sortKey,
      sortDir,
    );
  }, [
    allRows,
    dismissed,
    showDismissed,
    statusFilter,
    query,
    sortKey,
    sortDir,
  ]);

  const {
    items,
    page: safePage,
    pages,
  } = paginate(visibleRows, page, pageSize);
  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  const dismissedCount = useMemo(
    () => allRows.filter((r) => dismissed.has(r.id)).length,
    [allRows, dismissed],
  );

  const toggleSort = (key: MigrationSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "started" ? "desc" : "asc");
    }
  };
  const sortIndicator = (key: MigrationSortKey) =>
    key === sortKey ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const busy = refreshing || localRefreshing;
  function refresh() {
    if (!onRefresh || busy || refreshRef.current) return;
    const result = onRefresh();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      const tracked = Promise.resolve(result as Promise<unknown>).finally(
        () => {
          refreshRef.current = null;
          if (mountedRef.current) setLocalRefreshing(false);
        },
      );
      refreshRef.current = tracked;
      setLocalRefreshing(true);
      // Failures surface through the page's own query error states.
      tracked.catch(() => undefined);
    }
  }

  const filtersActive = query.trim() !== "" || statusFilter !== "all";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_8rem_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={searchId}>Search migrations</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={searchId}
              type="search"
              className="pl-8"
              value={query}
              placeholder="Job ID, source, name, or status"
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={statusId}>Status</Label>
          <Select
            id={statusId}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as MigrationStatusFilter);
              setPage(1);
            }}
          >
            {MIGRATION_STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={pageSizeId}>Per page</Label>
          <Select
            id={pageSizeId}
            value={String(pageSize)}
            onChange={(e) => {
              setPageSize(parseMigrationPageSize(e.target.value));
              setPage(1);
            }}
          >
            {MIGRATION_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </div>
        {onRefresh ? (
          <Button
            type="button"
            variant="outline"
            onClick={refresh}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            <RefreshCw
              className={cn("h-4 w-4", busy && "animate-spin")}
              aria-hidden
            />
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {dismissedCount > 0 || showDismissed ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowDismissed((v) => !v);
              setPage(1);
            }}
          >
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            {showDismissed
              ? "Show active"
              : `Show dismissed (${dismissedCount})`}
          </Button>
        ) : null}
        {filtersActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setStatusFilter("all");
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <span
          role="status"
          className="ml-auto text-xs tabular-nums text-muted-foreground"
        >
          {visibleRows.length.toLocaleString()} matching migration
          {visibleRows.length === 1 ? "" : "s"}
          {visibleRows.length > 0 ? ` · page ${safePage} of ${pages}` : ""}
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {query.trim()
            ? `No migrations match “${query.trim()}”${statusFilter !== "all" ? " with this status" : ""}.`
            : "No migrations match this filter."}
        </div>
      ) : (
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <SortButton
                    label="Source"
                    onClick={() => toggleSort("source")}
                    indicator={sortIndicator("source")}
                  />
                </TableHead>
                <TableHead>
                  <SortButton
                    label="Started"
                    onClick={() => toggleSort("started")}
                    indicator={sortIndicator("started")}
                  />
                </TableHead>
                <TableHead>
                  <SortButton
                    label="Status"
                    onClick={() => toggleSort("status")}
                    indicator={sortIndicator("status")}
                  />
                </TableHead>
                <TableHead>
                  <SortButton
                    label="Progress"
                    onClick={() => toggleSort("progress")}
                    indicator={sortIndicator("progress")}
                  />
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => {
                const cont = continueTarget(r);
                return (
                  <TableRow key={r.id} data-testid="migration-history-row">
                    <TableCell>
                      {r.label ? (
                        <>
                          <div className="font-medium">{r.label}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {r.source}
                          </div>
                        </>
                      ) : (
                        <div>{r.source}</div>
                      )}
                      {r.audienceScope ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {r.audienceScope}
                        </div>
                      ) : null}
                      <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                        {r.id}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <RelativeTime iso={r.startedAt} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={migrationStatusVariant(r.status)}>
                        {migrationStatusLabel(r.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Progress
                          value={r.progress}
                          className="h-1.5 w-24"
                          aria-label={`${r.source} ${isPreviewStatus(r.status) ? "preview" : "import"} processing progress`}
                        />
                        <span className="tabular-nums text-xs text-muted-foreground">
                          {r.progress}%
                          {isPreviewStatus(r.status) ? " preview" : ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {showDismissed ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => restore(r.id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden />{" "}
                            Restore
                          </Button>
                        ) : (
                          <>
                            {cont ? (
                              <Button asChild size="sm" variant="outline">
                                <Link href={cont.href}>{cont.label}</Link>
                              </Button>
                            ) : null}
                            <Button asChild size="sm" variant="ghost">
                              <Link href={`/app/migrations/${r.id}`}>View</Link>
                            </Button>
                            {isDismissable(r.status) ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Dismiss ${r.source} migration`}
                                title="Hide from this list"
                                onClick={() => dismiss(r.id)}
                              >
                                <X className="h-3.5 w-3.5" aria-hidden />
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {pages > 1 ? (
        <nav
          aria-label="Migration history pages"
          className="flex items-center justify-end gap-2 text-sm"
        >
          <Button
            size="sm"
            variant="ghost"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            Page {safePage} of {pages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={safePage >= pages}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function SortButton({
  label,
  onClick,
  indicator,
}: {
  label: string;
  onClick: () => void;
  indicator: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center rounded-md font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-8"
    >
      {label}
      <span aria-hidden className="tabular-nums">
        {indicator}
      </span>
    </button>
  );
}
