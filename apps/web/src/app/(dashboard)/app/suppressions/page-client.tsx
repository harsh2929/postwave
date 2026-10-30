// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Download,
  FileUp,
  RefreshCw,
  Search,
  ShieldBan,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { PageShell } from "@/components/dashboard/page-shell";
import {
  useRegisterCommands,
  type PageCommand,
} from "@/components/command-registry";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { RelativeTime } from "@/components/relative-time";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { downloadTextFile } from "@/lib/download";
import {
  addSuppression,
  bulkDeleteSuppressions,
  bulkImportSuppressions,
  classifySuppressionSearch,
  exportSuppressionsCsv,
  getSuppressionTrend,
  listSuppressionAudit,
  listSuppressions,
  parseEmailList,
  patchSuppressionExpiry,
  removeSuppression,
  suppressionExportFilename,
  suppressionSearchQuery,
  type SuppressionChannel,
  type SuppressionEntry,
  type SuppressionReason,
  type SuppressionScope,
} from "@/lib/suppressions-admin-api";
import {
  MANUAL_SUPPRESSION_REASONS,
  reasonBadgeVariant,
  reasonLabel,
  SUPPRESSION_REASON_LABELS,
} from "@/lib/suppression-reasons";
import { base, qk, STALE } from "@/lib/query-keys";
import { useAdminGate } from "@/lib/use-admin-gate";
import { AdminGateNotice } from "@/components/admin-gate-notice";
import { subscriberAuthorityFromMe } from "@/lib/subscriber-authority";
import {
  SuppressionBulkReasonAction,
  SuppressionProviderMirrorAction,
} from "./suppression-audience-actions";
import {
  EMPTY_SUPPRESSION_DATE_RANGE,
  SuppressionDateRangeFilter,
  suppressionDateRangeLabel,
  suppressionWithinDateRange,
  type SuppressionDateRange,
} from "./_components/suppression-date-range";
import { SuppressionDetailDialog } from "./_components/suppression-detail-dialog";
import { SuppressionImportCsvDialog } from "./_components/suppression-import-csv-dialog";
import { SuppressionStatStrip } from "./_components/suppression-stat-strip";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_SIZE = 100;

type SortKey = "added_desc" | "added_asc" | "reason";

function normalizeReasonFilter(value: string | null): string {
  const reason = value?.trim() ?? "";
  return Object.prototype.hasOwnProperty.call(SUPPRESSION_REASON_LABELS, reason)
    ? reason
    : "";
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function suppressionExpiryMinDate(now: Date = new Date()): string {
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return dateInputValue(tomorrow);
}

export function suppressionExpiryError(
  value: string,
  now: Date = new Date(),
): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return "Choose a valid expiry date.";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return "Choose a valid expiry date.";
  }
  if (value < suppressionExpiryMinDate(now)) {
    return "Expiry must be a future date.";
  }
  return null;
}

export default function SuppressionsPage() {
  const queryClient = useQueryClient();
  const adminGate = useAdminGate();
  const { canWrite, loading: gateLoading } = adminGate;

  // URL-persisted list state (GOV-022): hydrate from the URL so refreshes,
  // shared links, and browser history restore the operator's place. Local
  // state drives edits; the URL drives external/back-forward navigation.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const lastSearchParamsKey = useRef("");
  const syncingFromUrl = useRef(false);
  const [urlStateReady, setUrlStateReady] = useState(false);
  const [appliedQ, setAppliedQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [page, setPage] = useState(1);
  const [reasonFilter, setReasonFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("added_desc");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [historyFor, setHistoryFor] = useState<SuppressionEntry | null>(null);
  const [expiryFor, setExpiryFor] = useState<SuppressionEntry | null>(null);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const expiryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [showImportCsv, setShowImportCsv] = useState(false);
  const [detailFor, setDetailFor] = useState<SuppressionEntry | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Date-added range is a local view over the loaded page (the list endpoint
  // has no date parameter), so it lives outside the URL/query-key contract.
  const [dateRange, setDateRange] = useState<SuppressionDateRange>(
    EMPTY_SUPPRESSION_DATE_RANGE,
  );

  // Deep link from the ⌘K "Suppress an address" action (GOV-056): open the Add
  // dialog once the admin gate resolves. The write-back effect drops ?add=1.
  const addDeepLink = useRef(false);

  // The client component is also rendered on the server. Keep that first
  // render deterministic, then hydrate list state from the browser's actual
  // URL. Reading query-backed values in useState initializers produced a
  // clear-search button on only one side of hydration after a reload.
  useEffect(() => {
    const initialKey = window.location.search.replace(/^\?/u, "");
    const params = new URLSearchParams(initialKey);
    const pageNumber = Number(params.get("page"));
    const rawSort = params.get("sort");

    lastSearchParamsKey.current = initialKey;
    addDeepLink.current = params.get("add") === "1";
    setAppliedQ(params.get("q")?.trim() ?? "");
    setQInput(params.get("q")?.trim() ?? "");
    setPage(
      Number.isFinite(pageNumber) && pageNumber >= 1
        ? Math.floor(pageNumber)
        : 1,
    );
    setReasonFilter(normalizeReasonFilter(params.get("reason")));
    setSort(
      rawSort === "added_asc" || rawSort === "reason" ? rawSort : "added_desc",
    );
    setUrlStateReady(true);
  }, []);

  useEffect(() => {
    if (!urlStateReady) return;
    if (new URLSearchParams(searchParamsKey).get("add") === "1") {
      addDeepLink.current = true;
    }
    if (addDeepLink.current && canWrite) {
      addDeepLink.current = false;
      setShowAdd(true);
    }
  }, [canWrite, searchParamsKey, urlStateReady]);

  // Debounced live search (GOV-012): typing settles into the applied query
  // after a short pause, resetting to page 1.
  useEffect(() => {
    const trimmed = qInput.trim();
    if (trimmed === appliedQ) return;
    const t = window.setTimeout(() => {
      setAppliedQ(trimmed);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(t);
  }, [qInput, appliedQ]);

  // The dashboard shell persists across soft navigation. Initializers above
  // only run once, so explicitly reconcile a URL changed by Back/Forward or a
  // second link to this same route.
  useEffect(() => {
    if (!urlStateReady) return;
    const locationKey = window.location.search.replace(/^\?/u, "");
    // Next may publish a stale search-param snapshot for one render while a
    // soft navigation or hydration catches up with the address bar. The
    // browser URL is authoritative; wait until both agree before treating the
    // change as Back/Forward input.
    if (searchParamsKey !== locationKey) return;
    if (lastSearchParamsKey.current === searchParamsKey) return;
    lastSearchParamsKey.current = searchParamsKey;

    const params = new URLSearchParams(searchParamsKey);
    const nextQ = params.get("q")?.trim() ?? "";
    const pageNumber = Number(params.get("page"));
    const nextPage =
      Number.isFinite(pageNumber) && pageNumber >= 1
        ? Math.floor(pageNumber)
        : 1;
    const nextReason = normalizeReasonFilter(params.get("reason"));
    const rawSort = params.get("sort");
    const nextSort: SortKey =
      rawSort === "added_asc" || rawSort === "reason" ? rawSort : "added_desc";
    syncingFromUrl.current =
      appliedQ !== nextQ ||
      page !== nextPage ||
      reasonFilter !== nextReason ||
      sort !== nextSort;

    setAppliedQ((current) => (current === nextQ ? current : nextQ));
    setQInput((current) => (current === nextQ ? current : nextQ));
    setPage((current) => (current === nextPage ? current : nextPage));
    setReasonFilter((current) =>
      current === nextReason ? current : nextReason,
    );
    setSort((current) => (current === nextSort ? current : nextSort));
  }, [appliedQ, page, reasonFilter, searchParamsKey, sort, urlStateReady]);

  // Native browser history is the contract for Back/Forward. Next's
  // `useSearchParams` normally follows it, but listening directly also covers
  // same-document history entries created outside the router (for example a
  // copied filter link restored by browser history).
  useEffect(() => {
    if (!urlStateReady) return;

    const syncFromHistory = () => {
      const locationKey = window.location.search.replace(/^\?/u, "");
      const params = new URLSearchParams(locationKey);
      const nextQ = params.get("q")?.trim() ?? "";
      const pageNumber = Number(params.get("page"));
      const nextPage =
        Number.isFinite(pageNumber) && pageNumber >= 1
          ? Math.floor(pageNumber)
          : 1;
      const nextReason = normalizeReasonFilter(params.get("reason"));
      const rawSort = params.get("sort");
      const nextSort: SortKey =
        rawSort === "added_asc" || rawSort === "reason"
          ? rawSort
          : "added_desc";

      lastSearchParamsKey.current = locationKey;
      syncingFromUrl.current =
        appliedQ !== nextQ ||
        page !== nextPage ||
        reasonFilter !== nextReason ||
        sort !== nextSort;
      setAppliedQ(nextQ);
      setQInput(nextQ);
      setPage(nextPage);
      setReasonFilter(nextReason);
      setSort(nextSort);
    };

    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, [appliedQ, page, reasonFilter, sort, urlStateReady]);

  // Reflect list state into the URL (mirror, never the source of truth).
  useEffect(() => {
    if (!urlStateReady) return;
    if (syncingFromUrl.current) {
      syncingFromUrl.current = false;
      return;
    }
    const params = new URLSearchParams();
    if (appliedQ) params.set("q", appliedQ);
    if (page > 1) params.set("page", String(page));
    if (reasonFilter) params.set("reason", reasonFilter);
    if (sort !== "added_desc") params.set("sort", sort);
    const query = params.toString();
    const locationKey = window.location.search.replace(/^\?/u, "");
    if (query === locationKey) {
      lastSearchParamsKey.current = query;
      return;
    }
    // These filters are entirely client-side. A synchronous history update
    // prevents earlier router.replace responses from restoring old filters
    // after a newer edit, and avoids an RSC request for every filter choice.
    // Next's history integration still updates useSearchParams.
    lastSearchParamsKey.current = query;
    window.history.replaceState(
      null,
      "",
      query ? `${pathname}?${query}` : pathname,
    );
  }, [
    appliedQ,
    page,
    reasonFilter,
    sort,
    pathname,
    searchParamsKey,
    urlStateReady,
  ]);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const authority = useMemo(
    () =>
      canWrite && meQuery.data ? subscriberAuthorityFromMe(meQuery.data) : null,
    [canWrite, meQuery.data],
  );
  const suppressionsBaseKey = useMemo(
    () => base("suppressions", tenantId, role),
    [role, tenantId],
  );
  // How the search box reaches the server (GOV/audience-118, desktop parity):
  // a full address searches `email=` exactly, ≥3 characters search `q=` by
  // prefix, and 1–2 characters are too short for the store — those narrow the
  // loaded page client-side instead of scan-storming the index.
  const search = useMemo(() => classifySuppressionSearch(appliedQ), [appliedQ]);
  const listSearch = useMemo(
    () => suppressionSearchQuery(appliedQ),
    [appliedQ],
  );
  const suppressionsKey = useMemo(
    () =>
      [
        ...suppressionsBaseKey,
        { ...listSearch, page, size: PAGE_SIZE },
      ] as const,
    [listSearch, page, suppressionsBaseKey],
  );
  const suppressionsQuery = useQuery({
    queryKey: suppressionsKey,
    queryFn: () => listSuppressions({ ...listSearch, page, size: PAGE_SIZE }),
    enabled: meQuery.isFetched && urlStateReady,
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 403) && failureCount < 2,
    staleTime: STALE.list,
  });

  const trendQuery = useQuery({
    queryKey: useMemo(
      () => [...suppressionsBaseKey, "trend", 30] as const,
      [suppressionsBaseKey],
    ),
    queryFn: () => getSuppressionTrend(30),
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
  });

  const error =
    suppressionsQuery.error instanceof ApiError &&
    suppressionsQuery.error.status === 403
      ? "You need admin access to manage suppressions."
      : suppressionsQuery.error instanceof Error
        ? suppressionsQuery.error.message
        : suppressionsQuery.isError
          ? "Could not load suppressions — this is a failed request, not an empty suppression list."
          : null;

  // Memoised so the `?? []` fallback keeps a stable identity while the query is
  // pending — otherwise every render produced a fresh array, re-running the
  // filter/sort memo and the selection-pruning effect below.
  const rawItems = useMemo(
    () =>
      Array.isArray(suppressionsQuery.data?.items)
        ? suppressionsQuery.data?.items
        : [],
    [suppressionsQuery.data],
  );
  const total = suppressionsQuery.data?.total ?? 0;
  const loading =
    !urlStateReady ||
    meQuery.isLoading ||
    (suppressionsQuery.isPending && !suppressionsQuery.data);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const dateFilterActive = Boolean(dateRange.from || dateRange.to);
  const isFiltered = appliedQ !== "" || reasonFilter !== "" || dateFilterActive;

  // Reason filter, date-added range, short-query narrowing, and sort are all
  // applied to the current page client-side — the List endpoint supports only
  // email/q/page/size, so these refine what has actually been loaded.
  const items = useMemo(() => {
    let filtered = reasonFilter
      ? rawItems.filter((s) => (s.reason ?? "") === reasonFilter)
      : rawItems;
    if (search.mode === "client") {
      filtered = filtered.filter((s) =>
        s.email.toLowerCase().includes(search.value),
      );
    }
    if (dateRange.from || dateRange.to) {
      filtered = filtered.filter((s) =>
        suppressionWithinDateRange(s.created_at, dateRange),
      );
    }
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === "reason") {
        return (a.reason ?? "").localeCompare(b.reason ?? "");
      }
      const at = Date.parse(a.created_at);
      const bt = Date.parse(b.created_at);
      return sort === "added_asc" ? at - bt : bt - at;
    });
    return sorted;
  }, [dateRange, rawItems, reasonFilter, search, sort]);

  // Everything but Total is computed from the loaded rows, so the strip must
  // say when a filter narrowed them rather than present a scoped breakdown as
  // the whole list.
  const statScope = useMemo(() => {
    const parts = [
      reasonFilter ? reasonLabel(reasonFilter) : null,
      dateFilterActive ? suppressionDateRangeLabel(dateRange) : null,
      search.mode === "client" ? `matching “${search.value}”` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }, [dateFilterActive, dateRange, reasonFilter, search]);
  const selectedEntries = useMemo(
    () => items.filter((entry) => selected.has(entry.email)),
    [items, selected],
  );

  // Clamp only against a `total` the server actually reported. `page` is part
  // of the query key and nothing keeps previous data, so the first render after
  // "Next" (or after hydrating `?page=3`) has no data, `total` 0 and
  // `totalPages` 1 — clamping there would bounce every page change straight
  // back to 1 and strip `page` from the URL again.
  useEffect(() => {
    if (suppressionsQuery.isSuccess && page > totalPages) setPage(totalPages);
  }, [page, suppressionsQuery.isSuccess, totalPages]);

  // Drop selections that are no longer visible when the page/filter changes.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(items.map((s) => s.email));
      const next = new Set<string>();
      for (const email of prev) if (visible.has(email)) next.add(email);
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const invalidateSuppressions = useCallback((): void => {
    void queryClient.invalidateQueries({
      queryKey: suppressionsBaseKey,
      exact: false,
    });
  }, [queryClient, suppressionsBaseKey]);

  // Explicit refresh (desktop parity): re-reads the list AND the trend rather
  // than only the visible page, so the strip, chart, and table agree.
  const refreshing = suppressionsQuery.isFetching || trendQuery.isFetching;
  const refreshList = useCallback((): void => {
    invalidateSuppressions();
  }, [invalidateSuppressions]);

  const clearSearch = (): void => {
    setQInput("");
    setAppliedQ("");
    setPage(1);
  };

  const clearFilters = (): void => {
    clearSearch();
    setReasonFilter("");
    setDateRange(EMPTY_SUPPRESSION_DATE_RANGE);
  };

  const toggleSort = (key: SortKey): void => {
    setSort((current) => {
      if (key === "reason") return "reason";
      // Added header toggles between newest-first and oldest-first.
      return current === "added_desc" ? "added_asc" : "added_desc";
    });
  };

  const allVisibleSelected =
    items.length > 0 && items.every((s) => selected.has(s.email));
  const someVisibleSelected = items.some((s) => selected.has(s.email));

  const toggleSelectAll = (): void => {
    setSelected((prev) => {
      if (items.every((s) => prev.has(s.email))) {
        const next = new Set(prev);
        for (const s of items) next.delete(s.email);
        return next;
      }
      const next = new Set(prev);
      for (const s of items) next.add(s.email);
      return next;
    });
  };

  const toggleSelect = (email: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  const [exporting, setExporting] = useState(false);
  const runExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const csv = await exportSuppressionsCsv(reasonFilter || undefined);
      downloadTextFile(
        suppressionExportFilename(reasonFilter || undefined),
        csv,
        "text/csv;charset=utf-8",
      );
      toast.success("Suppression list exported.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not export suppressions.",
      );
    } finally {
      setExporting(false);
    }
  };

  // GOV-056: expose the core actions in the ⌘K palette. A ref carries the
  // latest handlers so the registered command array can stay stable (no
  // re-register churn) while never running a stale closure.
  const suppressionActionsRef = useRef({
    add: () => setShowAdd(true),
    export: () => void runExport(),
  });
  suppressionActionsRef.current = {
    add: () => setShowAdd(true),
    export: () => void runExport(),
  };
  const suppressionCommands = useMemo<PageCommand[]>(
    () => [
      {
        id: "add-suppression",
        label: "Add suppression",
        keywords: "block email suppress",
        run: () => suppressionActionsRef.current.add(),
      },
      {
        id: "export-suppressions",
        label: "Export suppressions",
        keywords: "download csv",
        run: () => suppressionActionsRef.current.export(),
      },
    ],
    [],
  );
  // The palette renders whatever a page registers with no role filter of its
  // own, so a read-only member would otherwise reach the Add dialog and the
  // export the header withholds — and only learn about it from a raw 403.
  // The hook canonicalises an empty array, so this does not re-register.
  useRegisterCommands(canWrite ? suppressionCommands : []);

  const runBulkRemove = async (): Promise<void> => {
    const emails = Array.from(selected);
    try {
      const res = await bulkDeleteSuppressions(emails);
      const blocked = res.blocked.length;
      if (blocked > 0) {
        toast.warning(
          `Removed ${res.deleted_count}; ${blocked} could not be removed (bounce/complaint holds are protected).`,
        );
      } else {
        toast.success(
          `Removed ${res.deleted_count} address${res.deleted_count === 1 ? "" : "es"} from the suppression list.`,
        );
      }
      setSelected(new Set());
      invalidateSuppressions();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not remove selection.",
      );
    }
  };

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Suppressions
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Addresses Moosewave will never email — bounces, complaints, and
            manual holds. Add, bulk-import, export, or remove entries.
          </p>
        </div>
        {/* Reserve the CTA row height while the admin gate resolves so the
            header doesn't jump when the buttons appear (GOV-013). */}
        {gateLoading ? (
          <div className="flex gap-2" aria-hidden>
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-28" />
          </div>
        ) : (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
            {/* Refresh is a read verb, so it stays available to read-only
                callers — the gate only withholds the write actions below. */}
            <Button
              type="button"
              variant="outline"
              onClick={refreshList}
              disabled={refreshing}
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            {canWrite ? (
              <>
                <SuppressionProviderMirrorAction
                  authority={authority}
                  onChanged={invalidateSuppressions}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void runExport()}
                  disabled={exporting}
                >
                  <Download className="h-4 w-4" />
                  {exporting ? "Exporting…" : "Export"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowImportCsv(true)}
                >
                  <FileUp className="h-4 w-4" />
                  Import CSV
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowImport(true)}
                >
                  Bulk import
                </Button>
                <Button type="button" onClick={() => setShowAdd(true)}>
                  Add address
                </Button>
              </>
            ) : null}
          </div>
        )}
      </header>

      <AdminGateNotice
        gate={adminGate}
        readOnlyMessage="You have read-only access. Only workspace admins can add, import, export, or remove suppressions."
      />

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      )}

      {!loading && !error ? (
        <SuppressionStatStrip
          rows={items}
          total={total}
          reasonScope={statScope}
        />
      ) : null}

      {trendQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          Could not load the suppression trend. The chart is hidden because the
          request failed, not because nothing was suppressed.
        </div>
      ) : (
        <TrendCard
          points={Array.isArray(trendQuery.data) ? trendQuery.data : []}
          loading={trendQuery.isPending}
        />
      )}

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle>Suppressed addresses</CardTitle>
            <CardDescription>
              {total > 0
                ? isFiltered
                  ? `${total} match${total === 1 ? "" : "es"}`
                  : `${total} suppressed`
                : "Manage the suppression list."}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search by email…"
                className="pl-8 pr-8"
                aria-label="Search suppressed addresses by email"
              />
              {qInput ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={clearSearch}
                  className="absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <Select
              value={reasonFilter}
              onChange={(e) => {
                setReasonFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter by reason"
              className="max-w-[12rem]"
            >
              <option value="">All reasons</option>
              {(
                Object.keys(SUPPRESSION_REASON_LABELS) as SuppressionReason[]
              ).map((r) => (
                <option key={r} value={r}>
                  {SUPPRESSION_REASON_LABELS[r]}
                </option>
              ))}
            </Select>
            <SuppressionDateRangeFilter
              value={dateRange}
              onChange={setDateRange}
            />
          </div>
          {search.mode !== "none" ? (
            <p role="status" className="text-xs text-muted-foreground">
              {search.mode === "exact"
                ? "Exact-match search across the whole suppression store."
                : search.mode === "prefix"
                  ? "Prefix search across the whole suppression store; mid-address matches are excluded."
                  : `Too short for a server search — matching “${search.value}” inside the ${rawItems.length.toLocaleString()} loaded rows instead.`}
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          {loading ? (
            <TableSkeleton
              rows={6}
              columns={["w-6", "w-56", "w-24", "w-20", "w-28", "w-16"]}
            />
          ) : error ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-dashed p-4">
              <p className="text-sm text-muted-foreground">
                The suppression list is unavailable, so it is not being shown as
                empty.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void suppressionsQuery.refetch()}
                disabled={suppressionsQuery.isFetching}
              >
                {suppressionsQuery.isFetching ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : items.length === 0 ? (
            isFiltered ? (
              <EmptyState
                icon={Search}
                title={
                  appliedQ
                    ? `No matches for “${appliedQ}”`
                    : "No matches for this filter"
                }
                description="No suppressed addresses match your current search, reason, or date filter."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    onClick={
                      reasonFilter || dateFilterActive
                        ? clearFilters
                        : clearSearch
                    }
                  >
                    {reasonFilter || dateFilterActive
                      ? "Clear filters"
                      : "Clear search"}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ShieldBan}
                title="No suppressed addresses"
                description="Bounces and complaints land here automatically. You can also add holds manually."
                action={
                  canWrite ? (
                    <Button type="button" onClick={() => setShowAdd(true)}>
                      Add address
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <div className="space-y-3">
              {canWrite && selected.size > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-accent/40 px-3 py-2 text-sm">
                  <span className="font-medium">{selected.size} selected</span>
                  <div className="flex gap-2">
                    <SuppressionBulkReasonAction
                      selected={selectedEntries}
                      authority={authority}
                      onChanged={invalidateSuppressions}
                      onClear={() => setSelected(new Set())}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(new Set())}
                    >
                      Clear
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button type="button" size="sm" variant="destructive">
                          Remove {selected.size}
                        </Button>
                      }
                      title={`Remove ${selected.size} suppression${selected.size === 1 ? "" : "s"}?`}
                      description="Moosewave may email these addresses again after removal, re-enabling sending to contacts that previously bounced or complained. Bounce/complaint holds that are not reversible will be skipped. Auto-suppression can re-add an address on its next bounce or complaint."
                      confirmLabel={`Remove ${selected.size}`}
                      onConfirm={runBulkRemove}
                    />
                  </div>
                </div>
              ) : null}
              <div
                role="region"
                aria-label="Suppressed addresses"
                tabIndex={0}
                className="border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      {canWrite ? (
                        <th scope="col" className="w-8 px-3 py-2">
                          <Checkbox
                            checked={allVisibleSelected}
                            indeterminate={
                              someVisibleSelected && !allVisibleSelected
                            }
                            onChange={toggleSelectAll}
                            aria-label="Select all on this page"
                            className="h-6 w-6 sm:h-4 sm:w-4"
                          />
                        </th>
                      ) : null}
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        Email
                      </th>
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        <SortHeader
                          label="Reason"
                          active={sort === "reason"}
                          onClick={() => toggleSort("reason")}
                        />
                      </th>
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        Source
                      </th>
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        Channel · Scope
                      </th>
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        <SortHeader
                          label="Added"
                          active={sort === "added_desc" || sort === "added_asc"}
                          direction={sort === "added_asc" ? "asc" : "desc"}
                          onClick={() => toggleSort("added_desc")}
                        />
                      </th>
                      <th
                        scope="col"
                        className="text-left px-3 py-2 font-medium"
                      >
                        Expires
                      </th>
                      <th
                        scope="col"
                        className="text-right px-3 py-2 font-medium"
                      >
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s) => (
                      <tr key={s.id} className="border-t hover:bg-muted/30">
                        {canWrite ? (
                          <td className="px-3 py-2">
                            <Checkbox
                              checked={selected.has(s.email)}
                              onChange={() => toggleSelect(s.email)}
                              aria-label={`Select ${s.email}`}
                              className="h-6 w-6 sm:h-4 sm:w-4"
                            />
                          </td>
                        ) : null}
                        <td className="px-3 py-2">
                          <span
                            className="block max-w-[16rem] truncate font-mono text-xs"
                            title={s.email}
                          >
                            {s.email}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={reasonBadgeVariant(s.reason)}>
                            {reasonLabel(s.reason)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {s.source || "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="secondary">
                              {s.channel ?? "email"}
                            </Badge>
                            <Badge variant="outline">
                              {s.scope ?? "marketing"}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          <RelativeTime iso={s.created_at} />
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {s.expires_at ? (
                            <RelativeTime iso={s.expires_at} />
                          ) : (
                            <span title="Permanent hold">Permanent</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                detailTriggerRef.current = event.currentTarget;
                                setDetailFor(s);
                              }}
                              aria-label={`Open details for ${s.email}`}
                            >
                              Details
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                historyTriggerRef.current = event.currentTarget;
                                setHistoryFor(s);
                              }}
                            >
                              History
                            </Button>
                            {canWrite ? (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={(event) => {
                                    expiryTriggerRef.current =
                                      event.currentTarget;
                                    setExpiryFor(s);
                                  }}
                                >
                                  Expiry
                                </Button>
                                <RemoveButton
                                  entry={s}
                                  onRemoved={invalidateSuppressions}
                                />
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {totalPages > 1 ? (
                  <div className="flex items-center justify-between border-t px-3 py-2">
                    <span className="text-xs text-muted-foreground">
                      Page {page} of {totalPages}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={page <= 1}
                        onClick={() =>
                          setPage((current) => Math.max(1, current - 1))
                        }
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={page >= totalPages}
                        onClick={() =>
                          setPage((current) =>
                            Math.min(totalPages, current + 1),
                          )
                        }
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
              {(reasonFilter || sort !== "added_desc") && totalPages > 1 ? (
                <p className="text-xs text-muted-foreground">
                  Filter and sort apply to this page. Search narrows the whole
                  list.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {showAdd && canWrite && (
        <AddDialog
          onClose={() => setShowAdd(false)}
          onDone={() => {
            setShowAdd(false);
            invalidateSuppressions();
          }}
        />
      )}
      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onDone={() => {
            setShowImport(false);
            invalidateSuppressions();
          }}
        />
      )}
      {showImportCsv && (
        <SuppressionImportCsvDialog
          onClose={() => setShowImportCsv(false)}
          onImported={(result) => {
            toast.success(
              `Imported ${result.inserted.toLocaleString()} address${
                result.inserted === 1 ? "" : "es"
              } from the CSV.`,
              {
                description: `${result.existing.toLocaleString()} already present · ${result.skipped.toLocaleString()} skipped · ${result.errors.toLocaleString()} errored.`,
              },
            );
            invalidateSuppressions();
          }}
        />
      )}
      {detailFor && (
        <SuppressionDetailDialog
          entry={detailFor}
          queryKeyBase={suppressionsBaseKey}
          returnFocusRef={detailTriggerRef}
          canRemove={canWrite}
          onClose={() => setDetailFor(null)}
          onRemoved={() => {
            setDetailFor(null);
            invalidateSuppressions();
          }}
        />
      )}
      {historyFor && (
        <HistoryDialog
          entry={historyFor}
          queryKeyBase={suppressionsBaseKey}
          returnFocusRef={historyTriggerRef}
          onClose={() => setHistoryFor(null)}
        />
      )}
      {expiryFor && (
        <ExpiryDialog
          entry={expiryFor}
          returnFocusRef={expiryTriggerRef}
          onClose={() => setExpiryFor(null)}
          onDone={() => {
            setExpiryFor(null);
            invalidateSuppressions();
          }}
        />
      )}
    </PageShell>
  );
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction?: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1 rounded font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
      aria-label={`Sort by ${label}`}
    >
      {label}
      <span aria-hidden className="text-xs">
        {active ? (direction === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </button>
  );
}

function RemoveButton({
  entry,
  onRemoved,
}: {
  entry: SuppressionEntry;
  onRemoved: () => void;
}) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" size="sm" variant="outline">
          Remove
        </Button>
      }
      title={`Remove ${entry.email}?`}
      description="Moosewave may email this address again after removal. Auto-suppression can re-add it on the next bounce or complaint."
      confirmLabel="Remove"
      onConfirm={async () => {
        try {
          await removeSuppression(entry.email);
          toast.success("Removed from suppression list.", {
            action: {
              label: "Undo",
              onClick: () => {
                // Restore the whole hold, not just the address. Omitting
                // channel/scope lets normalizeAddInput fall back to the
                // email/marketing defaults, so undoing an "any/all" block
                // would quietly reopen SMS, push and transactional mail —
                // and a dropped expires_at turns a timed hold permanent.
                void addSuppression({
                  email: entry.email,
                  reason: entry.reason,
                  source: entry.source,
                  channel: entry.channel,
                  scope: entry.scope,
                  expires_at: entry.expires_at,
                })
                  .then(() => {
                    toast.success("Suppression restored.");
                    onRemoved();
                  })
                  .catch((err) =>
                    toast.error(
                      err instanceof Error
                        ? err.message
                        : "Could not restore suppression.",
                    ),
                  );
              },
            },
          });
          onRemoved();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not remove.");
        }
      }}
    />
  );
}

function TrendCard({
  points,
  loading,
}: {
  points: { date: string; count: number }[];
  loading: boolean;
}) {
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const max = points.reduce((m, p) => Math.max(m, p.count), 0);
  const recent = points.slice(-7).reduce((sum, p) => sum + p.count, 0);
  if (loading) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (points.length === 0 || total === 0) return null;

  const width = 240;
  const height = 40;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const line = points
    .map((p, i) => {
      const x = i * step;
      const y = max > 0 ? height - (p.count / max) * height : height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <div className="text-sm font-medium">Suppression trend</div>
          <div className="text-xs text-muted-foreground">
            {total.toLocaleString()} added in the last {points.length} days ·{" "}
            {recent.toLocaleString()} in the last 7
          </div>
        </div>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="max-w-full text-primary"
          role="img"
          aria-label={`Suppressions added per day over the last ${points.length} days`}
        >
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </CardContent>
    </Card>
  );
}

function ReasonSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: SuppressionReason;
  onChange: (value: SuppressionReason) => void;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as SuppressionReason)}
    >
      {MANUAL_SUPPRESSION_REASONS.map((r) => (
        <option key={r} value={r}>
          {SUPPRESSION_REASON_LABELS[r]}
        </option>
      ))}
    </Select>
  );
}

function AddDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("list_manual");
  const [channel, setChannel] = useState<SuppressionChannel>("email");
  const [scope, setScope] = useState<SuppressionScope>("marketing");
  const [touched, setTouched] = useState(false);
  const [working, setWorking] = useState(false);
  const trimmed = email.trim();
  const invalid = trimmed !== "" && !EMAIL_RE.test(trimmed);

  async function submit() {
    if (!EMAIL_RE.test(trimmed)) {
      setTouched(true);
      return;
    }
    setWorking(true);
    try {
      await addSuppression({ email, reason, channel, scope });
      toast.success("Address suppressed.");
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not add address.",
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
        <DialogHeader>
          <DialogTitle>Add suppression</DialogTitle>
          <DialogDescription>
            This address will be skipped on all future sends.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="s-email">Email</Label>
            <Input
              id="s-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && invalid}
              placeholder="person@example.com"
            />
            {touched && invalid ? (
              <p className="text-xs text-destructive">
                Enter a valid email address.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-reason">Reason</Label>
            <ReasonSelect id="s-reason" value={reason} onChange={setReason} />
          </div>
          {/* GOV-031: channel + scope dimension. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="s-channel">Channel</Label>
              <Select
                id="s-channel"
                value={channel}
                onChange={(e) =>
                  setChannel(e.target.value as SuppressionChannel)
                }
              >
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="push">Push</option>
                <option value="any">Any channel</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-scope">Scope</Label>
              <Select
                id="s-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as SuppressionScope)}
              >
                <option value="marketing">Marketing</option>
                <option value="transactional">Transactional</option>
                <option value="all">All mail</option>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={working || !trimmed || invalid}
          >
            {working ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("list_manual");
  const [working, setWorking] = useState(false);
  const { valid, invalid } = parseEmailList(raw);

  async function submit() {
    setWorking(true);
    try {
      const res = await bulkImportSuppressions(valid, reason);
      const parts = [`${res.imported} imported`];
      if (res.skipped > 0) parts.push(`${res.skipped} already present`);
      if (res.errors > 0) parts.push(`${res.errors} failed`);
      if (invalid.length > 0) parts.push(`${invalid.length} invalid skipped`);
      if (res.errors > 0 || invalid.length > 0) {
        toast.warning(parts.join(", "), {
          description:
            invalid.length > 0
              ? "Invalid addresses were not sent. Download the list to fix and retry."
              : undefined,
          ...(invalid.length > 0
            ? {
                action: {
                  label: "Download invalid",
                  onClick: () =>
                    downloadTextFile(
                      "invalid-suppression-rows.txt",
                      invalid.join("\n"),
                    ),
                },
              }
            : {}),
        });
      } else {
        toast.success(parts.join(", "));
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
        <DialogHeader>
          <DialogTitle>Bulk import suppressions</DialogTitle>
          <DialogDescription>
            Paste addresses separated by lines, commas, or spaces.{" "}
            {valid.length} valid, {invalid.length} invalid. Imported in one
            request.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="i-addresses">Addresses</Label>
            <Textarea
              id="i-addresses"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={6}
              placeholder={"a@example.com\nb@example.com"}
            />
          </div>
          {invalid.length > 0 && (
            <p className="text-xs text-warning-emphasis">
              Skipping {invalid.length} invalid:{" "}
              {invalid.slice(0, 5).join(", ")}
              {invalid.length > 5 ? "…" : ""}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="i-reason">Reason</Label>
            <ReasonSelect id="i-reason" value={reason} onChange={setReason} />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={working || valid.length === 0}
          >
            {working ? "Importing…" : `Import ${valid.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExpiryDialog({
  entry,
  returnFocusRef,
  onClose,
  onDone,
}: {
  entry: SuppressionEntry;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const initial = entry.expires_at ? entry.expires_at.slice(0, 10) : "";
  const [value, setValue] = useState(initial);
  const [workingAction, setWorkingAction] = useState<
    "permanent" | "expiry" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const submitGuard = useRef(false);
  const valueError = suppressionExpiryError(value);
  const working = workingAction !== null;

  async function save(clear: boolean) {
    if (submitGuard.current || working) return;
    if (!clear && (!value || valueError)) {
      setError(valueError ?? "Choose a future expiry date.");
      return;
    }
    if ((clear && !initial) || (!clear && value === initial)) return;
    submitGuard.current = true;
    setWorkingAction(clear ? "permanent" : "expiry");
    setError(null);
    try {
      const iso =
        clear || !value ? null : new Date(`${value}T00:00:00Z`).toISOString();
      await patchSuppressionExpiry(entry.id, iso);
      toast.success(
        clear || !value ? "Hold made permanent." : "Expiry updated.",
      );
      onDone();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not update expiry.";
      setError(message);
      toast.error(message);
    } finally {
      submitGuard.current = false;
      setWorkingAction(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent
        aria-busy={working}
        className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Suppression expiry</DialogTitle>
          <DialogDescription className="break-all">
            Set when the hold on {entry.email} lifts automatically, or clear it
            to make the hold permanent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="expiry-date">Expires on</Label>
          <Input
            id="expiry-date"
            type="date"
            min={suppressionExpiryMinDate()}
            value={value}
            disabled={working}
            aria-invalid={valueError ? true : undefined}
            aria-describedby={valueError ? "expiry-date-error" : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          {valueError ? (
            <p
              id="expiry-date-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {valueError}
            </p>
          ) : null}
        </div>
        {error && error !== valueError ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className="flex-wrap">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void save(true)}
            loading={workingAction === "permanent"}
            disabled={working || !initial}
          >
            Make permanent
          </Button>
          <Button
            type="button"
            onClick={() => void save(false)}
            loading={workingAction === "expiry"}
            disabled={
              working || !value || Boolean(valueError) || value === initial
            }
          >
            Save expiry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HistoryDialog({
  entry,
  queryKeyBase,
  returnFocusRef,
  onClose,
}: {
  entry: SuppressionEntry;
  queryKeyBase: readonly unknown[];
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: [...queryKeyBase, "audit", entry.email],
    queryFn: () => listSuppressionAudit(entry.email),
    staleTime: STALE.list,
  });
  const events = Array.isArray(query.data) ? query.data : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Suppression history</DialogTitle>
          <DialogDescription className="break-all">
            Audit trail for {entry.email}. Events are kept even after the
            address is removed.
          </DialogDescription>
        </DialogHeader>
        <div
          className="max-h-80 space-y-2 overflow-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={events.length > 0 ? 0 : undefined}
          role={events.length > 0 ? "region" : undefined}
          aria-label={
            events.length > 0
              ? `Suppression history for ${entry.email}`
              : undefined
          }
        >
          {query.isPending ? (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading suppression history"
              className="space-y-2"
            >
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : query.isError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3"
            >
              <p className="text-sm font-medium text-destructive">
                Could not load suppression history.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The request failed, so this is not an empty audit trail.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No audit events recorded for this address yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {events.map((ev, i) => (
                <li
                  key={ev.id ?? `${ev.created_at}-${i}`}
                  className="min-w-0 rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium capitalize">
                      {ev.action.replaceAll("_", " ")}
                    </span>
                    <RelativeTime
                      iso={ev.created_at}
                      className="text-xs text-muted-foreground"
                    />
                  </div>
                  <div className="mt-1 break-words text-xs text-muted-foreground">
                    {[
                      ev.reason ? `Reason: ${reasonLabel(ev.reason)}` : null,
                      ev.source ? `Source: ${ev.source}` : null,
                      ev.actor ? `By: ${ev.actor}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No additional detail."}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
