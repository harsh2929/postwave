// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Client shell for the Forms list: search / status filter / sortable headers /
// pagination (FORM-006), a per-row overflow menu with edit·preview·copy-link·
// duplicate·publish·archive·delete (FORM-013), multi-select + bulk bar
// (FORM-035), pin-to-top (FORM-045), and relative dates + grouped counts
// (FORM-024/FORM-039). Server-fetched `initialForms` seed the TanStack cache;
// mutations invalidate it.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  ClipboardList,
  Copy,
  ExternalLink,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { FormsRefreshButton } from "@/components/forms/forms-refresh-button";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RelativeTime } from "@/components/relative-time";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import { copyToClipboard } from "@/lib/clipboard";
import {
  createForm,
  deleteForm,
  publicFormUrl,
  updateForm,
} from "@/lib/forms-api";
import { useFormsOrigin } from "@/lib/use-forms-origin";
import { listForms } from "@/lib/forms-api";
import {
  FORM_STATUS_FILTERS,
  FORM_SORT_KEYS,
  filterForms,
  formatCount,
  nextSort,
  paginate,
  sortForms,
  totalPages,
  type FormSortKey,
  type FormStatusFilter,
  type SortOrder,
} from "@/lib/forms-list-helpers";
import type { FormListItem, FormStatus } from "@/lib/forms-types";
import { base, qk, STALE } from "@/lib/query-keys";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { cn } from "@/lib/utils";
import {
  assertFreshFormAuthority,
  canAdminForms,
  canWriteForms,
  FORM_ADMIN_ONLY_MESSAGE,
  FORM_READ_ONLY_MESSAGE,
} from "@/lib/forms-authority";

const perPage = 20;

const listSchema = {
  page: intParam(1),
  q: stringParam(""),
  status: enumParam(FORM_STATUS_FILTERS, "all"),
  sort: enumParam(FORM_SORT_KEYS, "updatedAt"),
  order: enumParam(["asc", "desc"] as const, "desc"),
} as const;

function pinStorageKey(tenantId: string): string {
  return `postwave:forms:pins:${tenantId}`;
}

async function uniqueSlug(
  baseSlug: string,
  existing: Set<string>,
): Promise<string> {
  // Duplicate is the only path here that needs the forms-types module; loading
  // it on demand keeps it off the route's eager graph (bundle budget).
  const { slugify } = await import("@/lib/forms-types");
  const root = slugify(`${baseSlug}-copy`) || "form-copy";
  if (!existing.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}

export function FormsListClient({
  initialForms,
}: {
  initialForms: FormListItem[];
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const origin = useFormsOrigin();

  const { state, setState, reset } = useTableUrlState(listSchema);
  const { page, q, status, sort, order } = state;
  const [queryInput, setQueryInput] = useState(q);
  useEffect(() => setQueryInput(q), [q]);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const identity = meQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canWrite = canWriteForms(identity);
  const canAdmin = canAdminForms(identity);
  const formsScopeKey = useMemo(
    () => base("forms", tenantId, role),
    [role, tenantId],
  );
  const formsBaseKey = useMemo(
    () => [...formsScopeKey, identity?.user_id ?? "anon", viewerMode] as const,
    [formsScopeKey, identity?.user_id, viewerMode],
  );

  const formsQuery = useQuery({
    queryKey: [...formsBaseKey, "list"],
    queryFn: listForms,
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
    initialData: initialForms,
  });
  const forms = formsQuery.data ?? initialForms;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pins, setPins] = useState<Set<string>>(new Set());
  // A bulk run fans out one whoamiFresh + one write PER selected row and only
  // clears the selection once every request settles, so a second click before
  // then re-issues the entire batch against rows already being written. The ref
  // is what actually blocks re-entry; the state is what greys the buttons out.
  const bulkBusyRef = useRef(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: "delete"; form: FormListItem }
    | { kind: "archive"; form: FormListItem }
    | { kind: "bulk-delete" }
    | null
  >(null);

  // Load / persist pins per tenant.
  useEffect(() => {
    if (tenantId === "anon") return;
    try {
      const raw = localStorage.getItem(pinStorageKey(tenantId));
      setPins(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setPins(new Set());
    }
  }, [tenantId]);

  function persistPins(next: Set<string>) {
    setPins(next);
    if (tenantId === "anon") return;
    try {
      localStorage.setItem(pinStorageKey(tenantId), JSON.stringify([...next]));
    } catch {
      /* storage may be unavailable (private mode) — pins stay in-memory */
    }
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: formsScopeKey,
      exact: false,
    });
    // A list's Forms tab shows the forms that target it, with their status.
    void queryClient.invalidateQueries({
      queryKey: base("list-forms", tenantId, role),
    });
  };

  const filtered = useMemo(
    () => filterForms(forms, { q, status }),
    [forms, q, status],
  );
  const sorted = useMemo(() => {
    const s = sortForms(filtered, sort, order);
    // Pinned forms float to the top, preserving the sort among themselves.
    const pinned = s.filter((f) => pins.has(f.id));
    const rest = s.filter((f) => !pins.has(f.id));
    return [...pinned, ...rest];
  }, [filtered, sort, order, pins]);

  const pageCount = totalPages(sorted.length, perPage);
  const clampedPage = Math.min(page, pageCount);
  const rows = useMemo(
    () => paginate(sorted, clampedPage, perPage),
    [sorted, clampedPage],
  );

  const existingSlugs = useMemo(
    () => new Set(forms.map((f) => f.slug.toLowerCase())),
    [forms],
  );

  const isFiltered = q.trim() !== "" || status !== "all";

  useEffect(() => {
    if (!canWrite) setSelected(new Set());
    if (!canWrite) setConfirm(null);
  }, [canWrite]);

  async function verify(level: "write" | "admin") {
    if (!identity) throw new Error("Workspace identity is unavailable.");
    const fresh = await whoamiFresh();
    assertFreshFormAuthority(identity, fresh, level);
  }

  // --- actions -------------------------------------------------------------
  async function setStatus(form: FormListItem, next: FormStatus, verb: string) {
    try {
      if (!canWrite) throw new Error(FORM_READ_ONLY_MESSAGE);
      await verify("write");
      await updateForm(form.id, { status: next }, { requireOnline: true });
      invalidate();
      toast.success(`${form.name} ${verb}.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not ${verb} form.`,
      );
    }
  }

  async function handleDelete(form: FormListItem) {
    try {
      if (!canAdmin) throw new Error(FORM_ADMIN_ONLY_MESSAGE);
      await verify("admin");
      await deleteForm(form.id, { requireOnline: true });
      setSelected((s) => {
        const n = new Set(s);
        n.delete(form.id);
        return n;
      });
      invalidate();
      toast.success(`Deleted "${form.name}".`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  async function handleDuplicate(form: FormListItem) {
    try {
      if (!canWrite) throw new Error(FORM_READ_ONLY_MESSAGE);
      await verify("write");
      const newSlug = await uniqueSlug(form.slug, existingSlugs);
      const created = await createForm(
        {
          name: `${form.name} (copy)`,
          slug: newSlug,
          optInMode: form.optInMode,
          successMessage: form.settings.successMessage,
          successRedirectUrl: form.settings.successRedirectUrl,
        },
        { requireOnline: true },
      );
      // Copy over the full structure + settings (full replace on PATCH).
      await verify("write");
      await updateForm(
        created.id,
        {
          optInMode: form.optInMode,
          structure: form.structure,
          settings: form.settings,
        },
        { requireOnline: true },
      );
      invalidate();
      toast.success(`Duplicated as "${created.name}".`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not duplicate form.",
      );
    }
  }

  async function copyLink(form: FormListItem) {
    const result = await copyToClipboard(publicFormUrl(form.slug, origin));
    if (result === "copied") toast.success("Public URL copied.");
    else toast.error("Could not copy the URL.");
  }

  function togglePin(form: FormListItem) {
    const next = new Set(pins);
    if (next.has(form.id)) next.delete(form.id);
    else next.add(form.id);
    persistPins(next);
  }

  async function runBulk(next: FormStatus, verb: string) {
    if (!canWrite) {
      toast.error(FORM_READ_ONLY_MESSAGE);
      return;
    }
    if (bulkBusyRef.current) return;
    const targets = forms.filter((f) => selected.has(f.id));
    bulkBusyRef.current = true;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        targets.map(async (f) => {
          await verify("write");
          return updateForm(f.id, { status: next }, { requireOnline: true });
        }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      setSelected(new Set());
      invalidate();
      if (ok > 0) toast.success(`${verb} ${ok} form${ok === 1 ? "" : "s"}.`);
      if (ok < targets.length)
        toast.error(`${targets.length - ok} could not be updated.`);
    } finally {
      bulkBusyRef.current = false;
      setBulkBusy(false);
    }
  }

  async function bulkDelete() {
    if (!canAdmin) {
      toast.error(FORM_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (bulkBusyRef.current) return;
    const targets = forms.filter((f) => selected.has(f.id));
    bulkBusyRef.current = true;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        targets.map(async (f) => {
          await verify("admin");
          return deleteForm(f.id, { requireOnline: true });
        }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      setSelected(new Set());
      invalidate();
      if (ok > 0) toast.success(`Deleted ${ok} form${ok === 1 ? "" : "s"}.`);
      if (ok < targets.length)
        toast.error(`${targets.length - ok} could not be deleted.`);
    } finally {
      bulkBusyRef.current = false;
      setBulkBusy(false);
    }
  }

  // --- selection -----------------------------------------------------------
  const allOnPageSelected =
    rows.length > 0 && rows.every((f) => selected.has(f.id));
  function toggleRow(id: string) {
    if (!canWrite) return;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAllOnPage() {
    if (!canWrite) return;
    setSelected(allOnPageSelected ? new Set() : new Set(rows.map((f) => f.id)));
  }

  function handleSort(key: FormSortKey) {
    const n = nextSort({ sort, order }, key);
    setState({ sort: n.sort, order: n.order as SortOrder, page: 1 });
  }

  function actionItemsFor(form: FormListItem): ActionMenuItem[] {
    const pinned = pins.has(form.id);
    return [
      {
        label: "Edit",
        icon: <Pencil className="h-4 w-4" />,
        onSelect: () => router.push(`/app/forms/${form.id}`),
      },
      // Published forms open the live public page; drafts (whose public page
      // 404s) route to the editor's in-app preview.
      form.status === "published"
        ? {
            label: "Open public page",
            icon: <ExternalLink className="h-4 w-4" />,
            onSelect: () =>
              window.open(
                publicFormUrl(form.slug, origin),
                "_blank",
                "noopener",
              ),
          }
        : {
            label: "Preview",
            icon: <ExternalLink className="h-4 w-4" />,
            onSelect: () => router.push(`/app/forms/${form.id}`),
          },
      {
        label: "Copy public URL",
        icon: <Copy className="h-4 w-4" />,
        onSelect: () => void copyLink(form),
      },
      {
        label: "Duplicate",
        icon: <Copy className="h-4 w-4" />,
        onSelect: () => void handleDuplicate(form),
        disabled: !canWrite,
      },
      {
        label: pinned ? "Unpin" : "Pin to top",
        icon: pinned ? (
          <PinOff className="h-4 w-4" />
        ) : (
          <Pin className="h-4 w-4" />
        ),
        onSelect: () => togglePin(form),
      },
      ...(form.status === "published"
        ? [
            {
              label: "Unpublish",
              onSelect: () => void setStatus(form, "draft", "unpublished"),
              disabled: !canWrite,
            },
          ]
        : form.status === "draft"
          ? [
              {
                label: "Publish",
                onSelect: () => void setStatus(form, "published", "published"),
                disabled: !canWrite,
              },
            ]
          : []),
      ...(form.status !== "archived"
        ? [
            {
              label: "Archive",
              onSelect: () => {
                if (canWrite) setConfirm({ kind: "archive", form });
              },
              disabled: !canWrite,
            },
          ]
        : []),
      {
        label: "Delete",
        icon: <Trash2 className="h-4 w-4" />,
        destructive: true,
        onSelect: () => {
          if (canAdmin) setConfirm({ kind: "delete", form });
        },
        disabled: !canAdmin,
      },
    ];
  }

  return (
    <div className="space-y-4">
      {/* An editor holds write but not admin, so the row menu greys Delete out
          for them. Without the second branch that restriction is stated
          nowhere on the page — ActionMenuItem carries no tooltip — and the
          dead entry reads as a bug. */}
      {meQuery.isPending ? null : !canWrite ? (
        <p
          role="note"
          className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          {FORM_READ_ONLY_MESSAGE} {FORM_ADMIN_ONLY_MESSAGE}
        </p>
      ) : !canAdmin ? (
        <p
          role="note"
          className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          {FORM_ADMIN_ONLY_MESSAGE}
        </p>
      ) : null}

      {/* A failed refetch keeps the last good rows on screen, so a form deleted
          a second ago can still be listed under its own "Deleted" toast. Say so
          rather than letting stale rows pass for the current list. */}
      {formsQuery.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
        >
          <p className="min-w-0 flex-1">
            Could not refresh forms. The list below is the last one that loaded
            and may be out of date.
          </p>
          <Button
            size="sm"
            variant="outline"
            loading={formsQuery.isFetching}
            onClick={() => void formsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : formsQuery.isFetching ? (
        <p role="status" className="text-xs text-muted-foreground">
          Refreshing forms…
        </p>
      ) : null}

      {/* Filter bar */}
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <form
          className="relative w-full min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setState({ q: queryInput.trim(), page: 1 });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9 pr-9"
            aria-label="Search forms"
            placeholder="Search by name or slug"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
          {queryInput ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQueryInput("");
                setState({ q: "", page: 1 });
              }}
              className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </form>
        <div className="w-full sm:w-44">
          <label htmlFor="forms-status" className="sr-only">
            Filter by status
          </label>
          <Select
            id="forms-status"
            value={status}
            onChange={(e) =>
              setState({ status: e.target.value as FormStatusFilter, page: 1 })
            }
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </Select>
        </div>
        <FormsRefreshButton />
      </div>

      {canWrite && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/40 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              loading={bulkBusy}
              onClick={() => void runBulk("published", "Published")}
            >
              Publish
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={bulkBusy}
              onClick={() => void runBulk("draft", "Unpublished")}
            >
              Unpublish
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={bulkBusy}
              onClick={() => void runBulk("archived", "Archived")}
            >
              Archive
            </Button>
            <Button
              size="sm"
              variant="destructive"
              loading={bulkBusy}
              onClick={() => {
                if (canAdmin) setConfirm({ kind: "bulk-delete" });
              }}
              disabled={!canAdmin}
              title={!canAdmin ? FORM_ADMIN_ONLY_MESSAGE : undefined}
            >
              Delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={bulkBusy}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {sorted.length === 0 ? (
        isFiltered ? (
          <div className="rounded-md border bg-card p-10 text-center text-sm text-muted-foreground">
            <p>No forms match your filters.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                setQueryInput("");
                reset();
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          // The list can empty out after the server render — delete the last
          // form and this branch takes over. Blaming filters the user never set
          // reads as a fault in the page, so mirror the server page's empty
          // state exactly: deleting the last form and reloading the page must
          // not disagree about what "no forms" looks like. The header's role-
          // gated New form button stays on screen either way.
          <EmptyState
            icon={ClipboardList}
            title="No forms yet"
            description="Build a signup form, choose single or double opt-in, and embed it anywhere. Forms wire straight into your subscriber list."
          />
        )
      ) : (
        <>
          <ul className="space-y-3 md:hidden" aria-label="Forms">
            {rows.map((form) => {
              const pinned = pins.has(form.id);
              return (
                <li
                  key={form.id}
                  className={cn(
                    "rounded-lg border bg-card p-4 shadow-sm",
                    selected.has(form.id) && "border-primary/40 bg-primary/5",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${form.name}`}
                      className="mt-1 h-6 w-6 shrink-0 cursor-pointer rounded border-input accent-primary"
                      checked={selected.has(form.id)}
                      onChange={() => toggleRow(form.id)}
                      disabled={!canWrite}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {pinned ? (
                          <Pin
                            className="h-3.5 w-3.5 shrink-0 text-primary"
                            aria-label="Pinned"
                          />
                        ) : null}
                        <Link
                          href={`/app/forms/${form.id}`}
                          className="inline-flex min-h-8 min-w-0 items-center font-medium leading-snug underline-offset-4 hover:underline"
                        >
                          <span className="[overflow-wrap:anywhere]">
                            {form.name}
                          </span>
                        </Link>
                      </div>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {form.slug}
                      </p>
                    </div>
                    <ActionMenu
                      items={actionItemsFor(form)}
                      label={`Actions for ${form.name}`}
                      triggerClassName="-mr-2 -mt-2 h-11 w-11"
                    />
                  </div>

                  <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Submissions</dt>
                      <dd className="mt-1 font-medium tabular-nums">
                        {formatCount(form.submissions30d)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Visits</dt>
                      <dd className="mt-1 font-medium tabular-nums">
                        {formatCount(form.visits30d)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Conversion</dt>
                      <dd className="mt-1 font-medium tabular-nums">
                        {form.conversionRate}%
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
                    <Badge
                      variant={
                        form.status === "published"
                          ? "success"
                          : form.status === "draft"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {form.status}
                    </Badge>
                    <span>
                      {form.optInMode === "double"
                        ? "Double opt-in"
                        : "Single opt-in"}
                    </span>
                    <span className="ml-auto">
                      Updated <RelativeTime iso={form.updatedAt} />
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          <div
            role="region"
            aria-label="Forms table"
            tabIndex={0}
            className="hidden w-full min-w-0 max-w-full overflow-x-auto rounded-md border bg-card [contain:paint] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:block"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th scope="col" className="w-10 px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all forms on this page"
                      className="h-6 w-6 cursor-pointer rounded border-input accent-primary align-middle"
                      checked={allOnPageSelected}
                      onChange={toggleAllOnPage}
                      disabled={!canWrite}
                    />
                  </th>
                  <SortHeader
                    label="Name"
                    col="name"
                    sort={sort}
                    order={order}
                    onSort={handleSort}
                  />
                  <th scope="col" className="text-left px-4 py-2 font-medium">
                    Slug
                  </th>
                  <SortHeader
                    label="Submissions (30d)"
                    col="submissions30d"
                    sort={sort}
                    order={order}
                    onSort={handleSort}
                    align="right"
                  />
                  <SortHeader
                    label="Visits (30d)"
                    col="visits30d"
                    sort={sort}
                    order={order}
                    onSort={handleSort}
                    align="right"
                  />
                  <SortHeader
                    label="Visit conversion"
                    col="conversionRate"
                    sort={sort}
                    order={order}
                    onSort={handleSort}
                    align="right"
                  />
                  <SortHeader
                    label="Status"
                    col="status"
                    sort={sort}
                    order={order}
                    onSort={handleSort}
                  />
                  <SortHeader
                    label="Updated"
                    col="updatedAt"
                    sort={sort}
                    order={order}
                    onSort={handleSort}
                  />
                  <th scope="col" className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((f) => {
                  const pinned = pins.has(f.id);
                  return (
                    <tr
                      key={f.id}
                      className={cn(
                        "hover:bg-muted/30",
                        selected.has(f.id) && "bg-primary/5",
                      )}
                    >
                      <td className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${f.name}`}
                          className="h-6 w-6 cursor-pointer rounded border-input accent-primary align-middle"
                          checked={selected.has(f.id)}
                          onChange={() => toggleRow(f.id)}
                          disabled={!canWrite}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          {pinned ? (
                            <Pin
                              className="h-3 w-3 shrink-0 text-primary"
                              aria-label="Pinned"
                            />
                          ) : null}
                          <Link
                            href={`/app/forms/${f.id}`}
                            className="inline-flex min-h-8 items-center font-medium underline-offset-4 hover:underline"
                          >
                            {f.name}
                          </Link>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {f.optInMode === "double"
                            ? "Double opt-in"
                            : "Single opt-in"}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {f.slug}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCount(f.submissions30d)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCount(f.visits30d)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {f.conversionRate}%
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            f.status === "published"
                              ? "success"
                              : f.status === "draft"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {f.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <RelativeTime iso={f.updatedAt} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ActionMenu
                          items={actionItemsFor(f)}
                          label={`Actions for ${f.name}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {clampedPage} of {pageCount} · {formatCount(sorted.length)}{" "}
            form
            {sorted.length === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={clampedPage <= 1}
              onClick={() => setState({ page: clampedPage - 1 })}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={clampedPage >= pageCount}
              onClick={() => setState({ page: clampedPage + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {/* Destructive confirmations (FORM-010 / FORM-031 / FORM-035) */}
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete form?"
        description={
          confirm?.kind === "delete"
            ? `"${confirm.form.name}" and its submissions will be permanently deleted. This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (confirm?.kind === "delete") await handleDelete(confirm.form);
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "archive"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Archive form?"
        description={
          confirm?.kind === "archive"
            ? `"${confirm.form.name}" will be archived. Archived forms are read-only — to revive one, duplicate it.`
            : ""
        }
        confirmLabel="Archive"
        confirmVariant="default"
        onConfirm={async () => {
          if (confirm?.kind === "archive")
            await setStatus(confirm.form, "archived", "archived");
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "bulk-delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${selected.size} form${selected.size === 1 ? "" : "s"}?`}
        description="The selected forms and their submissions will be permanently deleted. This can't be undone."
        confirmLabel="Delete"
        onConfirm={async () => {
          await bulkDelete();
          setConfirm(null);
        }}
      />
    </div>
  );
}

function SortHeader({
  label,
  col,
  sort,
  order,
  onSort,
  align = "left",
}: {
  label: string;
  col: FormSortKey;
  sort: FormSortKey;
  order: SortOrder;
  onSort: (key: FormSortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort === col;
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex min-h-8 items-center gap-1 py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "flex-row-reverse",
          active && "text-foreground",
        )}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <ArrowUpDown
          className={cn("h-3 w-3", active ? "opacity-100" : "opacity-40")}
        />
        {active ? (
          <span className="sr-only">
            {order === "asc" ? "ascending" : "descending"}
          </span>
        ) : null}
      </button>
    </th>
  );
}
