// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Route } from "next";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { useDirectoryKeyboardShortcuts } from "@/components/subscribers/useDirectoryKeyboardShortcuts";
import {
  useFailedMutations,
  usePendingMutations,
} from "@/lib/pending-mutations";
import {
  archiveSubscriber,
  bulkDeleteSubscribers,
  bulkPasteSubscribers,
  bulkRecover,
  bulkAddToList,
  bulkTagSubscribers,
  bulkUnsubscribeSubscribers,
  createSubscriber,
  deleteSubscriber,
  exportSelectedCsv,
  getSubscriberCounts,
  listSubscribers,
  searchSubscribers,
  subscribersExportPath,
  suppressSubscriber,
  unarchiveSubscriber,
  unsuppressSubscriber,
  type BulkPasteResponse,
  type CreateSubscriberInput,
  type Subscriber,
  type SubscriberPage,
} from "@/lib/subscribers-api";
import { apiErrorMessage, fetchTextAuthed } from "@/lib/api";
import { summarizeSubscriberRowFailures } from "@/lib/subscriber-row-errors";
import { downloadTextFile } from "@/lib/download";
import { pluralizeCount } from "@/lib/pluralize";
import { setSubscriberNavOrder } from "@/lib/subscriber-nav-context";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  reauthorizeSubscriberMutation,
  SubscriberAuthorityError,
  subscriberAuthorityFromMe,
} from "@/lib/subscriber-authority";
import { dispatchPwaInstallTrigger } from "@/lib/pwa-install";
import { base, qk, STALE } from "@/lib/query-keys";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";
import {
  nextSort,
  statusFilterToParam,
  SUBSCRIBER_SORT_KEYS,
  SUBSCRIBER_STATUS_FILTERS,
  collectIdsPaged,
  type SortOrder,
  type SubscriberSortKey,
  type SubscriberStatusFilter,
} from "./subscribers-list-helpers";
import { SubscribersHeader } from "./subscribers-header";
import {
  refreshAudienceQueries,
  type AudienceChange,
} from "./subscribers-refresh";
import { SubscribersSearchForm } from "./subscribers-search-form";
import {
  BulkActionBar,
  Pagination,
  Stat,
  subId,
} from "./subscriber-list-controls";

const perPage = 50;
const BULK_ID_CAP = 10_000;
const EMPTY_SUBSCRIBERS: Subscriber[] = [];

const SubscribersTable = dynamic(
  () => import("./subscribers-table").then((module) => module.SubscribersTable),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading subscribers table"
        className="space-y-2 rounded-md border p-4"
      >
        <span className="sr-only">Loading subscribers table…</span>
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            aria-hidden="true"
            className="h-10 animate-pulse rounded bg-muted"
          />
        ))}
      </div>
    ),
  },
);

function SubscriberSecondaryLoading({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-sm text-muted-foreground"
    >
      Loading {label}…
    </p>
  );
}

// Growth and intelligence are useful context, but neither is required to
// search, select, or mutate the audience. Keep their data/API graphs out of the
// list's critical bundle while retaining an announced loading state.
const LazySubscribersGrowthTrend = dynamic(
  () =>
    import("./subscribers-growth-trend").then(
      (module) => module.SubscribersGrowthTrend,
    ),
  {
    ssr: false,
    loading: () => <SubscriberSecondaryLoading label="audience growth" />,
  },
);
const LazyAudienceIntelligencePanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/audience-intelligence-panel").then(
      (module) => module.AudienceIntelligencePanel,
    ),
  {
    ssr: false,
    loading: () => <SubscriberSecondaryLoading label="audience intelligence" />,
  },
);
const LazySubscriberBulkAudienceActions = dynamic(
  () =>
    import("./subscriber-bulk-audience-actions").then(
      (module) => module.SubscriberBulkAudienceActions,
    ),
  {
    ssr: false,
    loading: () => <SubscriberSecondaryLoading label="bulk audience tools" />,
  },
);

const listSchema = {
  page: intParam(1),
  q: stringParam(""),
  status: enumParam(SUBSCRIBER_STATUS_FILTERS, "all"),
  sort: enumParam(SUBSCRIBER_SORT_KEYS, "updated_at"),
  order: enumParam(["asc", "desc"] as const, "desc"),
  archived: enumParam(["0", "1"] as const, "0"),
} as const;

export default function SubscribersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { state, setState, reset } = useTableUrlState(listSchema);
  const { page, q: appliedQuery, status, sort, order, archived } = state;
  const useSearch = appliedQuery.length > 0;
  const includeArchived = archived === "1";
  // When a text search is active, fold the status chip into the search's
  // operator syntax so the filter stays consistent in both modes.
  const statusParam = statusFilterToParam(status);
  const effectiveSearchQuery =
    statusParam && useSearch
      ? `${appliedQuery} status:${statusParam}`
      : appliedQuery;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [exporting, setExporting] = useState(false);
  const bulkBusyRef = useRef(false);
  const writeLocksRef = useRef(new Set<string>());
  const writeControllersRef = useRef(new Set<AbortController>());
  const [open, setOpen] = useState(false);
  // The authority the add dialog was opened under: a create that lands after a
  // tenant/role switch must not be written into the new authority's list.
  const createAuthorityRef = useRef<string | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const authority = meQuery.data
    ? subscriberAuthorityFromMe(meQuery.data)
    : null;
  const canWrite = Boolean(authority);
  const canAdmin = authority?.role === "owner" || authority?.role === "admin";
  const authorityKey = authority
    ? `${authority.tenantId}:${authority.userId}:${authority.role}`
    : "unverified";
  const authorityKeyRef = useRef(authorityKey);
  const previousAuthorityKeyRef = useRef(authorityKey);
  useEffect(() => {
    const previousAuthority = previousAuthorityKeyRef.current;
    previousAuthorityKeyRef.current = authorityKey;
    authorityKeyRef.current = authorityKey;
    bulkBusyRef.current = false;
    for (const controller of writeControllersRef.current) controller.abort();
    writeControllersRef.current.clear();
    writeLocksRef.current.clear();
    setSelected(new Set());
    setAllMatchingSelected(false);
    setOpen(false);
    createAuthorityRef.current = null;
    if (previousAuthority !== authorityKey) {
      void queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(previousAuthority),
      });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey.includes(previousAuthority),
      });
    }
  }, [authorityKey, queryClient]);

  const runAuthorizedWrite = async <T,>(
    lockKey: string,
    adminOnly: boolean,
    transport: (signal: AbortSignal, idempotencyKey: string) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> => {
    if (
      !authority ||
      (adminOnly && !canAdmin) ||
      writeLocksRef.current.has(lockKey)
    )
      return { ok: false };
    const openedAuthority = authorityKey;
    const controller = new AbortController();
    const idempotencyKey = `subscriber-list:${lockKey}:${crypto.randomUUID()}`;
    writeLocksRef.current.add(lockKey);
    writeControllersRef.current.add(controller);
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      const value = await transport(controller.signal, idempotencyKey);
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      )
        return { ok: false };
      return { ok: true, value };
    } catch (error) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority ||
        error instanceof SubscriberAuthorityError
      )
        return { ok: false };
      throw error;
    } finally {
      writeControllersRef.current.delete(controller);
      writeLocksRef.current.delete(lockKey);
    }
  };

  const listParams = useMemo(
    () => ({
      page,
      perPage,
      status: statusFilterToParam(status),
      sort,
      order,
      includeArchived,
    }),
    [includeArchived, order, page, sort, status],
  );

  const subscriberParams = useMemo(
    () => ({ page, q: appliedQuery, status, sort, order, archived }),
    [appliedQuery, archived, order, page, sort, status],
  );
  const subscribersKey = useMemo(
    () => [...qk.subscribers(tenantId, role, subscriberParams), authorityKey],
    [authorityKey, role, subscriberParams, tenantId],
  );
  const subscribersBaseKey = useMemo(
    () => [...base("subscribers", tenantId, role), authorityKey],
    [authorityKey, role, tenantId],
  );
  const subscribersQuery = useQuery({
    queryKey: subscribersKey,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
    queryFn: ({ signal }) =>
      useSearch
        ? searchSubscribers(effectiveSearchQuery, page, perPage, signal, {
            includeArchived,
          })
        : listSubscribers(listParams, signal),
  });
  const countsQuery = useQuery({
    queryKey: [...subscribersBaseKey, "counts"],
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
    queryFn: ({ signal }) => getSubscriberCounts(signal),
  });

  const rows = subscribersQuery.data?.items ?? EMPTY_SUBSCRIBERS;
  const explicitlySelectedRows = useMemo(
    () =>
      allMatchingSelected
        ? []
        : rows.filter((subscriber) => selected.has(subId(subscriber))),
    [allMatchingSelected, rows, selected],
  );
  const total = subscribersQuery.data?.total ?? 0;
  const loading =
    meQuery.isLoading || (subscribersQuery.isPending && !subscribersQuery.data);
  const stats = countsQuery.data ?? { enabled: 0, suppressed: 0, pending: 0 };

  // Publish the current page order so the detail page can offer prev/next.
  useEffect(() => {
    if (rows.length > 0) setSubscriberNavOrder(rows.map(subId));
  }, [rows]);

  useEffect(() => {
    if (!subscribersQuery.isError) return;
    toast.error("Could not load subscribers — this is a failed request.");
  }, [subscribersQuery.isError]);

  const updateCurrentSubscriberPage = (
    updater: (page: SubscriberPage) => SubscriberPage,
  ): void => {
    queryClient.setQueryData<SubscriberPage>(subscribersKey, (current) =>
      current ? updater(current) : current,
    );
  };

  // The list key is [...base, params, authorityKey] and the counts key is
  // [...base, authorityKey, "counts"]; `subscribersBaseKey` is a prefix of the
  // counts key only, so invalidating by it never refreshed the list. The
  // tenant prefix reaches both (and the directory toolbar's queries under it),
  // together with everything else derived from the audience: the growth
  // trend, audience intelligence, dashboard tiles and onboarding checklist.
  const invalidateSubscribers = (change?: AudienceChange): void => {
    refreshAudienceQueries(queryClient, tenantId, change);
  };

  // Clear selection whenever the result set changes underneath it.
  useEffect(() => {
    setSelected(new Set());
    setAllMatchingSelected(false);
  }, [subscriberParams]);

  useEffect(() => {
    const totalPagesForData = Math.max(1, Math.ceil(total / perPage));
    if (!subscribersQuery.data || page <= totalPagesForData) return;
    setState({ page: totalPagesForData });
  }, [page, setState, subscribersQuery.data, total]);

  const handleSearch = (nextQuery: string) => {
    if (nextQuery === appliedQuery) {
      void subscribersQuery.refetch();
      return;
    }
    setState({ q: nextQuery, page: 1 });
  };

  const clearSearch = () => {
    setState({ q: "", page: 1 });
  };

  const setStatusFilter = (filter: SubscriberStatusFilter) => {
    setState({ status: status === filter ? "all" : filter, page: 1 });
  };

  const handleSort = (key: SubscriberSortKey) => {
    const next = nextSort({ sort, order }, key);
    setState({ sort: next.sort, order: next.order as SortOrder, page: 1 });
  };

  // --- Pagination ---------------------------------------------------------
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const goToPage = (p: number) => {
    const clamped = Math.min(Math.max(1, p), totalPages);
    if (clamped === page || subscribersQuery.isFetching) return;
    setState({ page: clamped });
  };

  // --- Bulk selection -----------------------------------------------------
  const toggleRow = (id: string) => {
    // setAllMatchingSelected used to live inside the setSelected updater.
    // React may run an updater more than once, and a nested setState is not
    // part of the value it returns — updaters have to stay pure.
    setAllMatchingSelected(false);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allOnPageSelected =
    rows.length > 0 && rows.every((r) => selected.has(subId(r)));
  const toggleAllOnPage = () => {
    setAllMatchingSelected(false);
    setSelected(allOnPageSelected ? new Set() : new Set(rows.map(subId)));
  };
  const clearSelection = () => {
    setSelected(new Set());
    setAllMatchingSelected(false);
  };

  // Resolve the concrete subscriber UUIDs a bulk action should target. For a
  // "select all matching" action we paginate the current filter to collect ids
  // up to the server's 10k bulk cap; otherwise we use the on-page selection.
  const collectAllMatchingIds = async (): Promise<string[]> => {
    const per = 200;
    // Pages are fetched a wave at a time rather than one-by-one: at the 10k cap
    // this is 50 requests, and serialized they cost the user seconds of spinner
    // before the bulk action even starts.
    return collectIdsPaged(
      async (p) => {
        const res = useSearch
          ? await searchSubscribers(effectiveSearchQuery, p, per, undefined, {
              includeArchived,
            })
          : await listSubscribers({ ...listParams, page: p, perPage: per });
        return {
          ids: res.items
            .map((s) => s.id)
            .filter((id): id is string => Boolean(id)),
          count: res.items.length,
        };
      },
      { total, per, cap: BULK_ID_CAP },
    );
  };

  const resolveTargetIds = async (): Promise<string[]> => {
    if (allMatchingSelected) return collectAllMatchingIds();
    return rows
      .filter((r) => selected.has(subId(r)))
      .map((r) => r.id)
      .filter((x): x is string => Boolean(x));
  };

  const runBulk = async (
    action: (
      ids: string[],
      options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<{ affected: number; recovery_token?: string }>,
    verb: string,
    opts: {
      undoable?: boolean;
      change?: (ids: string[]) => AudienceChange;
      /**
       * The success line. Defaults to "<verb> N contacts." — pass one when the
       * verb needs an object of its own, e.g. the list an audience joined.
       */
      describe?: (count: number) => string;
    } = {},
  ) => {
    const describe =
      opts.describe ??
      ((count: number) => `${verb} ${pluralizeCount(count, "contact")}.`);
    if (!canAdmin || !authority) {
      toast.error("Administrator access is required for this bulk action.");
      return;
    }
    if (bulkBusyRef.current) return;
    bulkBusyRef.current = true;
    const openedAuthority = authorityKey;
    const controller = new AbortController();
    writeControllersRef.current.add(controller);
    // Everything from here runs under one try/finally: collecting a "select
    // all matching" selection pages through the API and can fail, and a
    // failure before the try used to leave the busy flag set, silently
    // swallowing every later bulk action until a reload.
    try {
      let ids: string[];
      try {
        ids = await resolveTargetIds();
      } catch (err) {
        if (openedAuthority !== authorityKeyRef.current) return;
        toast.error(
          apiErrorMessage(
            err,
            "Couldn't gather the matching contacts, so nothing was changed. Try again.",
          ),
        );
        return;
      }
      if (ids.length === 0) {
        toast.error("No eligible contacts in the selection.");
        return;
      }
      await reauthorizeSubscriberMutation(authority, controller.signal);
      if (openedAuthority !== authorityKeyRef.current) return;
      const result = await action(ids, {
        signal: controller.signal,
        idempotencyKey: `subscriber-list:bulk:${verb}:${crypto.randomUUID()}`,
      });
      if (openedAuthority !== authorityKeyRef.current) return;
      clearSelection();
      invalidateSubscribers(opts.change?.(ids));
      if (opts.undoable && result.recovery_token) {
        const token = result.recovery_token;
        toast.success(describe(result.affected), {
          action: {
            label: "Undo",
            onClick: () => {
              void runAuthorizedWrite(
                `recover:${token}`,
                true,
                (signal, idempotencyKey) =>
                  bulkRecover(token, { signal, idempotencyKey }),
              )
                .then((undo) => {
                  if (!undo.ok) return;
                  invalidateSubscribers();
                  toast.success("Change reverted.");
                })
                .catch(() => toast.error("Could not undo."));
            },
          },
        });
      } else {
        toast.success(describe(result.affected));
      }
    } catch (err) {
      if (openedAuthority !== authorityKeyRef.current) return;
      toast.error(
        err instanceof Error ? err.message : `Could not ${verb.toLowerCase()}.`,
      );
    } finally {
      writeControllersRef.current.delete(controller);
      bulkBusyRef.current = false;
    }
  };

  const bulkSuppress = () =>
    runBulk(
      (ids, options) => bulkUnsubscribeSubscribers(ids, options),
      "Suppressed",
    );
  const bulkDelete = () =>
    runBulk((ids, options) => bulkDeleteSubscribers(ids, options), "Deleted", {
      change: (ids) => ({ deletedIds: ids }),
    });
  const bulkTag = (tag: string) =>
    runBulk((ids, options) => bulkTagSubscribers(ids, tag, options), "Tagged", {
      undoable: true,
    });
  // "Added to list 3 contacts." named no list and read backwards. The picker
  // knows the list's name, so the receipt can say which one.
  const bulkAddList = (listId: string, listName?: string) =>
    runBulk((ids, options) => bulkAddToList(ids, listId, options), "Added", {
      change: () => ({ membership: true }),
      describe: (count) =>
        listName
          ? `Added ${pluralizeCount(count, "contact")} to ${listName}.`
          : `Added ${pluralizeCount(count, "contact")} to the list.`,
    });

  const exportSelected = async () => {
    setExporting(true);
    try {
      const ids = await resolveTargetIds();
      if (ids.length === 0) return;
      const csv = await exportSelectedCsv(ids);
      downloadTextFile(
        "subscribers-selected.csv",
        csv,
        "text/csv;charset=utf-8",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  // Whole-list / current-filter export (SUB-010).
  const exportFiltered = async () => {
    setExporting(true);
    try {
      const path = subscribersExportPath({
        status: statusFilterToParam(status),
        q: useSearch ? appliedQuery : undefined,
        sort: useSearch ? undefined : sort,
        order: useSearch ? undefined : order,
        includeArchived,
      });
      const csv = await fetchTextAuthed(path);
      downloadTextFile("subscribers.csv", csv, "text/csv;charset=utf-8");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  /* --- Create ----------------------------------------------------------- */
  const pendingSubCreates = usePendingMutations<CreateSubscriberInput>(
    "subscribers",
    "create",
  );
  const failedSubCreates = useFailedMutations<CreateSubscriberInput>(
    "subscribers",
    "create",
  );

  const setCreateOpen = (next: boolean) => {
    if (next) createAuthorityRef.current = authorityKeyRef.current;
    setOpen(next);
  };

  // AddSubscriberDialog re-checks authority, POSTs, and toasts; the page only
  // folds the saved row into the list it is showing.
  const handleCreated = (sub: Subscriber) => {
    if (createAuthorityRef.current !== authorityKeyRef.current) return;
    updateCurrentSubscriberPage((current) => ({
      ...current,
      items: [sub, ...current.items.filter((s) => s.email !== sub.email)],
      total: current.total + 1,
    }));
    invalidateSubscribers();
    dispatchPwaInstallTrigger("postwave:subscriber-added");
  };

  // A row edited in place by the table (rename, status, tags) carries its new
  // revision; swap it in so the next inline write sends that If-Match.
  const handleRowChanged = (updated: Subscriber) => {
    updateCurrentSubscriberPage((current) => ({
      ...current,
      items: current.items.map((row) =>
        updated.id && row.id === updated.id ? updated : row,
      ),
    }));
    invalidateSubscribers();
  };

  const openSubscriber = (sub: Subscriber) => {
    const id = sub.id ?? sub.email;
    if (id) router.push(`/app/subscribers/${encodeURIComponent(id)}`);
  };

  // Directory keyboard commands (desktop parity): j/k move the focused row,
  // x toggles it, Enter opens it, n adds a subscriber, Cmd/Ctrl+A selects the
  // page, Cmd/Ctrl+E exports the selection. `/` is owned by the search form.
  const { rowKeyDown } = useDirectoryKeyboardShortcuts({
    rowCount: rows.length,
    onToggleRow: (index) => {
      const row = rows[index];
      if (row) toggleRow(subId(row));
    },
    onOpenRow: (index) => {
      const row = rows[index];
      if (row) openSubscriber(row);
    },
    onNew: canWrite ? () => setCreateOpen(true) : undefined,
    onSelectPage: toggleAllOnPage,
    onExport:
      selected.size > 0 && !allMatchingSelected
        ? () => void exportSelected()
        : undefined,
  });

  // Resolves with the per-address outcome so the dialog can keep the
  // addresses that failed, with their reasons; null when nothing was written.
  const handlePaste = async (
    emails: string,
    tags: string[],
  ): Promise<BulkPasteResponse | null> => {
    try {
      const input = { emails, tags: [...tags] };
      const result = await runAuthorizedWrite(
        "bulk-paste",
        false,
        (signal, idempotencyKey) =>
          bulkPasteSubscribers(input, { signal, idempotencyKey }),
      );
      if (!result.ok) return null;
      const res = result.value;
      invalidateSubscribers();
      const added = res.created + res.updated;
      if (res.errored > 0) {
        const failed = (Array.isArray(res.rows) ? res.rows : []).filter(
          (row) => row.status === "error",
        );
        toast.warning(
          `Added ${added.toLocaleString()} of ${res.parsed.toLocaleString()}. ${summarizeSubscriberRowFailures(failed)}`,
        );
      } else {
        toast.success(`Added ${pluralizeCount(added, "contact")}.`);
      }
      return res;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add emails.");
      return null;
    }
  };

  /* --- Single-row actions ---------------------------------------------- */
  const handleSuppress = async (sub: Subscriber) => {
    try {
      const id = sub.id ?? sub.email;
      const result = await runAuthorizedWrite(
        `suppress:${id}`,
        false,
        (signal, idempotencyKey) =>
          suppressSubscriber(id, {
            expectedVersion: sub.version,
            idempotencyKey,
            signal,
          }),
      );
      if (!result.ok) return;
      updateCurrentSubscriberPage((current) => ({
        ...current,
        items: current.items.map((row) =>
          row.id === sub.id || row.email === sub.email
            ? { ...row, status: "blocklisted" }
            : row,
        ),
      }));
      invalidateSubscribers();
      toast.success("Subscriber suppressed.");
    } catch {
      toast.error("Suppress failed.");
    }
  };

  const handleUnsuppress = async (sub: Subscriber) => {
    try {
      const write = await runAuthorizedWrite(
        `unsuppress:${sub.id ?? sub.email}`,
        true,
        (signal, idempotencyKey) =>
          unsuppressSubscriber(sub.id ?? sub.email, sub.email, {
            idempotencyKey,
            signal,
          }),
      );
      if (!write.ok) return;
      const result = write.value;
      invalidateSubscribers();
      toast.success(
        result.deleted
          ? "Reviewed suppression removed. Status and consent were not changed."
          : "No reversible suppression was removed. Status and consent were not changed.",
      );
    } catch {
      toast.error("Could not remove the reviewed suppression.");
    }
  };

  const handleArchive = async (sub: Subscriber) => {
    const id = sub.id ?? sub.email;
    try {
      const result = await runAuthorizedWrite(
        `archive:${id}`,
        false,
        (signal, idempotencyKey) =>
          archiveSubscriber(id, { signal, idempotencyKey }),
      );
      if (!result.ok) return;
      // Hidden from the list unless "show archived" is on.
      if (!includeArchived) {
        updateCurrentSubscriberPage((current) => ({
          ...current,
          items: current.items.filter(
            (row) => row.id !== sub.id && row.email !== sub.email,
          ),
          total: Math.max(0, current.total - 1),
        }));
      }
      invalidateSubscribers();
      toast.success("Subscriber archived.", {
        action: {
          label: "Undo",
          onClick: () => {
            void runAuthorizedWrite(
              `unarchive:${id}`,
              false,
              (signal, idempotencyKey) =>
                unarchiveSubscriber(id, { signal, idempotencyKey }),
            )
              .then((undo) => {
                if (!undo.ok) return;
                invalidateSubscribers();
                toast.success("Subscriber restored.");
              })
              .catch(() => toast.error("Could not restore."));
          },
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed.");
    }
  };

  const handleUnarchive = async (sub: Subscriber) => {
    try {
      const id = sub.id ?? sub.email;
      const result = await runAuthorizedWrite(
        `unarchive:${id}`,
        false,
        (signal, idempotencyKey) =>
          unarchiveSubscriber(id, { signal, idempotencyKey }),
      );
      if (!result.ok) return;
      invalidateSubscribers();
      toast.success("Subscriber restored.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed.");
    }
  };

  const handleDelete = async (sub: Subscriber) => {
    try {
      const id = sub.id ?? sub.email;
      const result = await runAuthorizedWrite(
        `delete:${id}`,
        false,
        (signal, idempotencyKey) =>
          deleteSubscriber(id, {
            expectedVersion: sub.version,
            signal,
            idempotencyKey,
          }),
      );
      if (!result.ok) return;
      updateCurrentSubscriberPage((current) => ({
        ...current,
        items: current.items.filter(
          (row) => row.id !== sub.id && row.email !== sub.email,
        ),
        total: Math.max(0, current.total - 1),
      }));
      invalidateSubscribers({ deletedIds: sub.id ? [sub.id] : [] });
      toast.success("Subscriber deleted.");
    } catch {
      toast.error("Delete failed.");
    }
  };

  const filterKind: "search" | "status" | "none" = useSearch
    ? "search"
    : status !== "all"
      ? "status"
      : "none";

  return (
    <PageShell>
      <SubscribersHeader
        total={total}
        open={open}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        onExport={exportFiltered}
        exporting={exporting}
        onPaste={handlePaste}
        canWrite={canWrite}
        authority={authority}
      />

      {/* A failed counts fetch must not read as "this workspace has none" —
          the tiles below fall back to 0 and are indistinguishable from a
          genuinely empty workspace. */}
      {countsQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load subscriber counts.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Enabled"
          value={stats.enabled}
          active={status === "enabled"}
          onClick={() => setStatusFilter("enabled")}
        />
        <Stat
          label="Suppressed"
          value={stats.suppressed}
          active={status === "suppressed"}
          onClick={() => setStatusFilter("suppressed")}
        />
        <Stat
          label="Pending"
          value={stats.pending}
          active={status === "pending"}
          onClick={() => setStatusFilter("pending")}
        />
      </div>

      <LazySubscribersGrowthTrend />

      <LazyAudienceIntelligencePanel className="min-w-0 [&_[role=tooltip]]:w-40 [&_[role=tooltip]]:whitespace-normal [&_[role=tooltip][aria-hidden=true]]:hidden md:[&_[role=tooltip]]:w-auto md:[&_[role=tooltip]]:whitespace-nowrap" />

      <SubscribersSearchForm
        appliedQuery={appliedQuery}
        onSearch={handleSearch}
        onClear={clearSearch}
      />

      {/* Active-filter chips + archived toggle. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {status !== "all" ? (
          <button
            type="button"
            onClick={() => setStatusFilter(status)}
            className="inline-flex min-h-7 items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-0.5 text-xs"
          >
            Status: {status}
            <X className="h-3 w-3" />
          </button>
        ) : null}
        <label className="ml-auto flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) =>
              setState({ archived: e.target.checked ? "1" : "0", page: 1 })
            }
            className="h-5 w-5 rounded border-input accent-primary"
          />
          Show archived
        </label>
      </div>

      <BulkActionBar
        count={selected.size}
        totalMatching={total}
        allMatchingSelected={allMatchingSelected}
        onSelectAllMatching={() => setAllMatchingSelected(true)}
        onClear={clearSelection}
        onSuppress={bulkSuppress}
        onDelete={bulkDelete}
        onTag={bulkTag}
        onAddToList={bulkAddList}
        onExport={exportSelected}
        exporting={exporting}
        canAdmin={canAdmin}
        selectedRows={explicitlySelectedRows}
        resolveIds={resolveTargetIds}
        authority={authority}
        onChanged={() => invalidateSubscribers()}
        audienceAdminActions={
          <LazySubscriberBulkAudienceActions
            selected={explicitlySelectedRows}
            allMatchingSelected={allMatchingSelected}
            authority={authority}
            role={role}
            onReviewDuplicates={(ids) => {
              // The dedupe API is only needed to build this one link.
              void import("@/lib/subscriber-dedupe-api").then(
                ({ selectedDuplicateReviewPath }) =>
                  router.push(selectedDuplicateReviewPath(ids) as Route),
              );
            }}
            onChanged={() => invalidateSubscribers()}
          />
        }
      />

      {subscribersQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load subscribers — this is a failed request, not an empty
          audience. The table below is showing nothing because the fetch failed.
        </p>
      ) : null}

      <div data-tour="dashboard-subscriber-directory" className="scroll-mt-40">
        <SubscribersTable
          rows={rows}
          loading={loading}
          pending={pendingSubCreates}
          failed={failedSubCreates}
          isFiltered={filterKind !== "none"}
          filterKind={filterKind}
          onClearFilters={() => {
            reset();
          }}
          selected={selected}
          allOnPageSelected={allOnPageSelected}
          onToggleRow={toggleRow}
          onToggleAllOnPage={toggleAllOnPage}
          sort={sort}
          order={order}
          onSort={handleSort}
          sortEnabled={!useSearch}
          onRetryFailed={(input) => {
            const frozen = { ...(input as CreateSubscriberInput) };
            void runAuthorizedWrite(
              `retry-create:${frozen.email.toLowerCase()}`,
              false,
              (signal, idempotencyKey) =>
                createSubscriber(frozen, { signal, idempotencyKey }),
            )
              .then((result) => {
                if (result.ok) invalidateSubscribers();
              })
              .catch(() => {
                /* failed-row surfaces it */
              });
          }}
          onSuppress={handleSuppress}
          onUnsuppress={handleUnsuppress}
          onArchive={handleArchive}
          onUnarchive={handleUnarchive}
          onDelete={handleDelete}
          canWrite={canWrite}
          canAdmin={canAdmin}
          authority={authority}
          onRowChanged={handleRowChanged}
          onRowKeyDown={rowKeyDown}
          onOpen={openSubscriber}
        />
      </div>

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        perPage={perPage}
        rowsOnPage={rows.length}
        loading={loading}
        onPrev={() => goToPage(page - 1)}
        onNext={() => goToPage(page + 1)}
      />
    </PageShell>
  );
}
