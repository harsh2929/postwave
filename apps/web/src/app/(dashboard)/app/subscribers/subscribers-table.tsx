// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronsUpDown,
  Download,
  Plus,
  RotateCcw,
  Tag as TagIcon,
  Trash2,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { Select } from "@/components/ui/select";
import {
  ColumnPicker,
  useDirectoryColumns,
} from "@/components/subscribers/ColumnPicker";
import { InlineEmailRename } from "@/components/subscribers/InlineEmailRename";
import { InlineStatusChange } from "@/components/subscribers/InlineStatusChange";
import { InlineTagChips } from "@/components/subscribers/InlineTagChips";
import { useQuery } from "@tanstack/react-query";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { listLists } from "@/lib/forms-api";
import { qk, STALE } from "@/lib/query-keys";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";
import {
  DIRECTORY_COLUMNS,
  type DirectoryColumnKey,
} from "@/lib/subscriber-directory-api";
import type { Subscriber, SubscriberStatus } from "@/lib/subscribers-api";
import {
  formatAbsoluteDate,
  formatListDate,
  labelize,
  subscriberStatusVariant,
  type SortOrder,
  type SubscriberSortKey,
} from "./subscribers-list-helpers";

export const subId = (subscriber: Subscriber): string =>
  subscriber.id ?? subscriber.email;

export function Stat({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number;
  active?: boolean;
  onClick?: () => void;
}) {
  const className = `rounded-md border px-4 py-3 text-left transition-colors ${
    active
      ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
      : "bg-card hover:border-ring/40"
  }`;
  const content = (
    <>
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
    </>
  );
  if (!onClick)
    return <div className="rounded-md border bg-card px-4 py-3">{content}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={className}
    >
      {content}
    </button>
  );
}

export function BulkActionBar({
  count,
  totalMatching,
  allMatchingSelected,
  onSelectAllMatching,
  onClear,
  onSuppress,
  onResubscribe,
  onDelete,
  onTag,
  onAddToList,
  onExport,
  exporting,
  audienceAdminActions,
}: {
  count: number;
  totalMatching: number;
  allMatchingSelected: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onSuppress: () => void | Promise<void>;
  onResubscribe: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onTag: (tag: string) => void | Promise<void>;
  onAddToList: (listId: string, listName?: string) => void | Promise<void>;
  onExport: () => void | Promise<void>;
  exporting: boolean;
  audienceAdminActions?: ReactNode;
}) {
  if (count === 0) return null;
  const effective = allMatchingSelected ? totalMatching : count;
  const noun = `${effective.toLocaleString()} subscriber${effective === 1 ? "" : "s"}`;
  return (
    // Sticky so the bar stays reachable while scrolling a long list.
    <div className="sticky top-2 z-20 space-y-2 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium tabular-nums">
          {allMatchingSelected
            ? `All ${totalMatching.toLocaleString()} selected`
            : `${count} selected`}
        </span>
        {!allMatchingSelected && totalMatching > count ? (
          <button
            type="button"
            onClick={onSelectAllMatching}
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            Select all {totalMatching.toLocaleString()} matching
          </button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => void onExport()}
            disabled={exporting || allMatchingSelected}
            title={
              allMatchingSelected
                ? "Use the header Export to export all matching contacts"
                : undefined
            }
          >
            <Download className="h-4 w-4" />
            {exporting ? "Exporting…" : "Export"}
          </Button>
          <BulkTagButton onTag={onTag} noun={noun} />
          <BulkAddToListButton onAddToList={onAddToList} />
          {audienceAdminActions}
          <ConfirmDialog
            title={`Suppress ${noun}?`}
            description="They'll be blocklisted and excluded from future sends. You can re-enable them later."
            confirmLabel="Suppress"
            confirmVariant="default"
            onConfirm={onSuppress}
            trigger={
              <Button variant="outline" size="sm" type="button">
                <Ban className="h-4 w-4" />
                Suppress
              </Button>
            }
          />
          <ConfirmDialog
            title={`Re-subscribe ${noun}?`}
            description="They'll be re-enabled and eligible for sends again."
            confirmLabel="Re-subscribe"
            confirmVariant="default"
            onConfirm={onResubscribe}
            trigger={
              <Button variant="outline" size="sm" type="button">
                <RotateCcw className="h-4 w-4" />
                Re-subscribe
              </Button>
            }
          />
          <BulkDeleteButton onDelete={onDelete} count={effective} />
          <Button variant="ghost" size="sm" type="button" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

function BulkTagButton({
  onTag,
  noun,
}: {
  onTag: (tag: string) => void | Promise<void>;
  noun: string;
}) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState("");
  return open ? (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const value = tag.trim();
        if (!value) return;
        void Promise.resolve(onTag(value)).then(() => {
          setTag("");
          setOpen(false);
        });
      }}
    >
      <Input
        autoFocus
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        placeholder={`Tag ${noun}`}
        aria-label="Tag to apply"
        className="h-8 w-40"
      />
      <Button type="submit" size="sm" disabled={!tag.trim()}>
        Apply
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </form>
  ) : (
    <Button
      variant="outline"
      size="sm"
      type="button"
      onClick={() => setOpen(true)}
    >
      <TagIcon className="h-4 w-4" />
      Tag
    </Button>
  );
}

// Bulk "Add to list" (SUB-013): the backend bulk/add-to-list endpoint and the
// listLists() wrapper already exist — this surfaces them. Picks a target list,
// then applies it to the current selection via onAddToList.
function BulkAddToListButton({
  onAddToList,
}: {
  onAddToList: (listId: string, listName?: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [listId, setListId] = useState("");
  const [pending, setPending] = useState(false);
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const listsQuery = useQuery({
    // In the shared `lists` family, so creating or deleting a list anywhere
    // refreshes this menu.
    queryKey: qk.lists(
      me.data?.tenant_id ?? "anon",
      me.data ? effectiveAuthRole(me.data) : null,
      { view: "bulk-picker" },
    ),
    queryFn: () => listLists(),
    enabled: open && me.isSuccess,
    staleTime: STALE.list,
  });
  const lists = Array.isArray(listsQuery.data) ? listsQuery.data : [];
  const submit = async () => {
    if (!listId) return;
    setPending(true);
    try {
      await onAddToList(
        listId,
        lists.find((candidate) => String(candidate.id) === listId)?.name,
      );
      setOpen(false);
      setListId("");
    } finally {
      setPending(false);
    }
  };
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => setOpen(true)}
      >
        Add to list
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1 rounded-md border bg-background p-2">
      <Select
        aria-label="Choose a list"
        value={listId}
        onChange={(e) => setListId(e.target.value)}
        className="h-8 w-44"
      >
        <option value="">
          {listsQuery.isPending ? "Loading lists…" : "Choose a list…"}
        </option>
        {lists.map((l) => (
          <option key={String(l.id)} value={String(l.id)}>
            {l.name}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        size="sm"
        disabled={!listId || pending}
        onClick={() => void submit()}
      >
        {pending ? "Adding…" : "Add"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(false);
          setListId("");
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

// Typed-confirm gate for the irreversible bulk erase (SUB-019).
function BulkDeleteButton({
  onDelete,
  count,
}: {
  onDelete: () => void | Promise<void>;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pending, setPending] = useState(false);
  const armed = confirmText.trim().toUpperCase() === "DELETE";

  const run = async () => {
    if (!armed) return;
    setPending(true);
    try {
      await onDelete();
      setOpen(false);
      setConfirmText("");
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        type="button"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1 rounded-md border border-destructive/40 bg-background p-2">
      <span className="text-xs text-muted-foreground">
        Permanently erase {count.toLocaleString()} contact
        {count === 1 ? "" : "s"}. Type <strong>DELETE</strong> to confirm.
      </span>
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="DELETE"
          aria-label="Type DELETE to confirm"
          className="h-8 w-28"
        />
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={!armed || pending}
          onClick={() => void run()}
        >
          {pending ? "Erasing…" : "Erase"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setConfirmText("");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  perPage,
  rowsOnPage,
  loading,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
  rowsOnPage: number;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (total <= perPage && page === 1) return null;
  const start = total === 0 ? 0 : (page - 1) * perPage + 1;
  const end = (page - 1) * perPage + rowsOnPage;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <span className="tabular-nums">
        Showing{" "}
        <span className="font-medium text-foreground">
          {start.toLocaleString()}
        </span>
        -
        <span className="font-medium text-foreground">
          {end.toLocaleString()}
        </span>{" "}
        of{" "}
        <span className="font-medium text-foreground">
          {total.toLocaleString()}
        </span>
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={onPrev}
          disabled={page <= 1 || loading}
        >
          Previous
        </Button>
        <span className="tabular-nums">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={onNext}
          disabled={page >= totalPages || loading}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  order,
  onSort,
  disabled,
}: {
  label: string;
  sortKey: SubscriberSortKey;
  sort: SubscriberSortKey;
  order: SortOrder;
  onSort?: (key: SubscriberSortKey) => void;
  disabled?: boolean;
}) {
  const active = sort === sortKey;
  if (!onSort || disabled) {
    return (
      <th scope="col" className="px-4 py-2 text-left font-medium">
        {label}
      </th>
    );
  }
  return (
    <th scope="col" className="px-4 py-2 text-left font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex min-h-8 items-center gap-1 rounded-sm py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active ? (
          order === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </th>
  );
}

export function SubscribersTable({
  rows,
  loading,
  pending,
  failed,
  isFiltered,
  filterKind,
  onClearFilters,
  selected,
  allOnPageSelected,
  onToggleRow,
  onToggleAllOnPage,
  sort,
  order,
  onSort,
  sortEnabled,
  onRetryFailed,
  onSuppress,
  onUnsuppress,
  onArchive,
  onUnarchive,
  onDelete,
  onOpen,
  canWrite,
  canAdmin,
  authority,
  onRowChanged,
  onRowKeyDown,
}: {
  rows: Subscriber[];
  loading: boolean;
  pending: { email: string }[];
  failed: { email: string }[];
  isFiltered: boolean;
  filterKind: "search" | "status" | "none";
  onClearFilters: () => void;
  selected: Set<string>;
  allOnPageSelected: boolean;
  onToggleRow: (id: string) => void;
  onToggleAllOnPage: () => void;
  sort: SubscriberSortKey;
  order: SortOrder;
  onSort: (key: SubscriberSortKey) => void;
  sortEnabled: boolean;
  onRetryFailed: (input: { email: string }) => void;
  onSuppress: (sub: Subscriber) => void;
  onUnsuppress: (sub: Subscriber) => void;
  onArchive: (sub: Subscriber) => void;
  onUnarchive: (sub: Subscriber) => void;
  onDelete: (sub: Subscriber) => void | Promise<void>;
  onOpen: (sub: Subscriber) => void;
  canWrite: boolean;
  canAdmin: boolean;
  /** Re-checked before an inline status change is written. */
  authority?: SubscriberAuthority | null;
  /** A row the table edited in place (rename, status, tags). */
  onRowChanged: (updated: Subscriber) => void;
  /** Arrow/Home/End roving focus between desktop rows. */
  onRowKeyDown?: (event: KeyboardEvent<HTMLElement>, index: number) => void;
}) {
  const headerCbRef = useRef<HTMLInputElement>(null);
  const someSelected = selected.size > 0 && !allOnPageSelected;
  useEffect(() => {
    if (headerCbRef.current) headerCbRef.current.indeterminate = someSelected;
  }, [someSelected]);

  // The signed-in user's column set (GET/PUT /api/v1/me/prefs/subscribers_view,
  // shared with desktop). Email is always shown; Consent, Updated and the row
  // actions are web columns outside the shared catalog and stay fixed.
  const columns = useDirectoryColumns();
  const visibleColumns = DIRECTORY_COLUMNS.filter((column) =>
    columns.isVisible(column.key),
  );
  // checkbox + chosen columns + Consent + Updated + actions
  const columnCount = visibleColumns.length + 4;

  const empty =
    rows.length === 0 && pending.length === 0 && failed.length === 0;

  const filteredEmptyState = (
    <div className="py-6 text-center">
      <p className="text-sm text-muted-foreground">
        {filterKind === "search"
          ? "No subscribers match your search."
          : "No subscribers match this filter."}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={onClearFilters}
      >
        {filterKind === "search" ? "Clear search" : "Clear filter"}
      </Button>
    </div>
  );

  const firstRunEmptyState = (
    <EmptyState
      icon={Users}
      title="No subscribers yet"
      description="Import a list or add your first subscriber - your audience will show up here."
      action={
        <Button asChild>
          <Link href="/app/subscribers/import">
            <Plus className="h-4 w-4" />
            Import subscribers
          </Link>
        </Button>
      }
    />
  );

  return (
    <div>
      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {loading ? (
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={`msk-${i}`}
                className="space-y-2 rounded-md border bg-card p-4"
              >
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
        ) : empty ? (
          isFiltered ? (
            <div className="rounded-md border bg-card px-4 py-6">
              {filteredEmptyState}
            </div>
          ) : (
            <div className="rounded-md border bg-card">
              {firstRunEmptyState}
            </div>
          )
        ) : (
          <>
            {pending.map((p, i) => (
              <article
                key={`pending-${p.email}-${i}`}
                className="pw-pending-row rounded-md border bg-card p-4 text-sm shadow-sm"
                aria-label={`Adding ${p.email}`}
              >
                <div className="font-medium leading-snug [overflow-wrap:anywhere]">
                  {p.email}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Adding...
                </div>
              </article>
            ))}
            {failed.map((f, i) => (
              <article
                key={`failed-${f.email}-${i}`}
                className="pw-failed-row rounded-md border bg-card p-4 text-sm shadow-sm"
                aria-label={`Failed to add ${f.email}`}
              >
                <div className="font-medium leading-snug [overflow-wrap:anywhere]">
                  {f.email}
                </div>
                <div className="mt-1 text-xs">
                  <button
                    type="button"
                    className="pw-retry-link"
                    onClick={() => onRetryFailed(f)}
                    disabled={!canWrite}
                  >
                    Sync failed - Retry
                  </button>
                </div>
              </article>
            ))}
            {rows.map((sub) => (
              <SubscriberCard
                key={sub.id ?? sub.email}
                subscriber={sub}
                selected={selected.has(subId(sub))}
                onToggle={() => onToggleRow(subId(sub))}
                onSuppress={onSuppress}
                onUnsuppress={onUnsuppress}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onDelete={onDelete}
                onOpen={onOpen}
                onRowChanged={onRowChanged}
                canWrite={canWrite}
                canAdmin={canAdmin}
              />
            ))}
          </>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block">
        <div className="mb-2 flex justify-end">
          <ColumnPicker controller={columns} />
        </div>
        <div className="overflow-hidden rounded-md border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 px-4 py-2">
                <input
                  ref={headerCbRef}
                  type="checkbox"
                  aria-label="Select all subscribers on this page"
                  className="h-6 w-6 cursor-pointer rounded border-input accent-primary align-middle"
                  checked={allOnPageSelected}
                  onChange={onToggleAllOnPage}
                />
              </th>
              {visibleColumns.map((column) => {
                const sortKey = COLUMN_SORT_KEYS[column.key];
                if (column.key === "avatar") {
                  return (
                    <th key={column.key} scope="col" className="w-10 px-2 py-2">
                      <span className="sr-only">{column.label}</span>
                    </th>
                  );
                }
                if (sortKey) {
                  return (
                    <SortHeader
                      key={column.key}
                      label={column.label}
                      sortKey={sortKey}
                      sort={sort}
                      order={order}
                      onSort={onSort}
                      disabled={!sortEnabled}
                    />
                  );
                }
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className="px-4 py-2 text-left font-medium"
                  >
                    {column.label}
                  </th>
                );
              })}
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Consent
              </th>
              <SortHeader
                label="Updated"
                sortKey="updated_at"
                sort={sort}
                order={order}
                onSort={onSort}
                disabled={!sortEnabled}
              />
              <th scope="col" className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {pending.map((p, i) => (
              <tr
                key={`pending-${p.email}-${i}`}
                className="pw-pending-row"
                aria-label={`Adding ${p.email}`}
              >
                <td className="px-4 py-3" />
                <td className="px-4 py-3 font-medium">{p.email}</td>
                <td
                  className="px-4 py-3 text-muted-foreground"
                  colSpan={columnCount - 3}
                >
                  Adding...
                </td>
                <td className="px-4 py-3" />
              </tr>
            ))}
            {failed.map((f, i) => (
              <tr
                key={`failed-${f.email}-${i}`}
                className="pw-failed-row"
                aria-label={`Failed to add ${f.email}`}
              >
                <td className="px-4 py-3" />
                <td className="px-4 py-3 font-medium">{f.email}</td>
                <td className="px-4 py-3" colSpan={columnCount - 3}>
                  <button
                    type="button"
                    className="pw-retry-link"
                    onClick={() => onRetryFailed(f)}
                    disabled={!canWrite}
                  >
                    Sync failed - Retry
                  </button>
                </td>
                <td className="px-4 py-3" />
              </tr>
            ))}
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`sk-${i}`} aria-hidden>
                  <td className="w-10 px-4 py-3">
                    <Skeleton className="h-4 w-4" />
                  </td>
                  {Array.from({ length: columnCount - 1 }).map((__, cell) => (
                    <td key={`sk-${i}-${cell}`} className="px-4 py-3">
                      <Skeleton className="h-4 w-16" />
                    </td>
                  ))}
                </tr>
              ))
            ) : empty ? (
              <tr>
                <td className="px-4 py-8" colSpan={columnCount}>
                  {isFiltered ? filteredEmptyState : firstRunEmptyState}
                </td>
              </tr>
            ) : (
              rows.map((sub, index) => (
                <tr
                  key={sub.id ?? sub.email}
                  data-testid="subscriber-row"
                  data-id={sub.id ?? sub.email}
                  data-subscriber-row-index={index}
                  tabIndex={-1}
                  onKeyDown={(event) => {
                    // Only the row itself roves; arrows inside a status
                    // select or a rename field stay with that control.
                    if (event.target === event.currentTarget)
                      onRowKeyDown?.(event, index);
                  }}
                  className={`hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                    selected.has(subId(sub)) ? "bg-primary/5" : ""
                  }`}
                >
                  <td className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${sub.email}`}
                      className="h-6 w-6 cursor-pointer rounded border-input accent-primary align-middle"
                      checked={selected.has(subId(sub))}
                      onChange={() => onToggleRow(subId(sub))}
                    />
                  </td>
                  {visibleColumns.map((column) =>
                    column.key === "email" ? (
                      <td key={column.key} className="px-4 py-3">
                        <div className="grid min-w-0 gap-0.5">
                          <div className="flex min-w-0 items-center gap-2 font-medium">
                            <InlineEmailRename
                              subscriber={sub}
                              canWrite={canWrite}
                              onRenamed={onRowChanged}
                            />
                            {sub.archived_at ? (
                              <Badge variant="outline" className="shrink-0">
                                Archived
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {typeof sub.custom_fields.name === "string" ? (
                              <span>{sub.custom_fields.name}</span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => onOpen(sub)}
                              className="inline-flex min-h-8 items-center rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              aria-label={`Open subscriber ${sub.email}`}
                            >
                              Open
                            </button>
                          </div>
                        </div>
                      </td>
                    ) : column.key === "status" ? (
                      <td key={column.key} className="px-4 py-3">
                        <InlineStatusChange
                          subscriber={sub}
                          canWrite={canWrite}
                          authority={authority}
                          onChanged={onRowChanged}
                        />
                      </td>
                    ) : column.key === "tags" ? (
                      <td key={column.key} className="px-4 py-3">
                        <InlineTagChips
                          subscriber={sub}
                          canWrite={canWrite}
                          onChanged={onRowChanged}
                        />
                      </td>
                    ) : (
                      <DirectoryCell
                        key={column.key}
                        column={column.key}
                        subscriber={sub}
                      />
                    ),
                  )}
                  <td className="px-4 py-3 text-muted-foreground">
                    {labelize(sub.consent_source)}
                  </td>
                  <td
                    className="px-4 py-3 text-muted-foreground"
                    title={formatAbsoluteDate(sub.updated_at)}
                  >
                    {formatListDate(sub.updated_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {sub.status === "blocklisted" && canAdmin ? (
                        <Tooltip label="Remove suppression">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove reviewed suppression for ${sub.email}`}
                            onClick={() => onUnsuppress(sub)}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      ) : sub.status !== "blocklisted" && canWrite ? (
                        <Tooltip label="Suppress">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Suppress ${sub.email}`}
                            onClick={() => onSuppress(sub)}
                          >
                            <Ban className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      ) : null}
                      {canWrite && (sub.archived_at ? (
                        <Tooltip label="Unarchive">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Unarchive ${sub.email}`}
                            onClick={() => onUnarchive(sub)}
                          >
                            <ArchiveRestore className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      ) : (
                        <Tooltip label="Archive">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Archive ${sub.email}`}
                            onClick={() => onArchive(sub)}
                          >
                            <Archive className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      ))}
                      {canWrite ? <ConfirmDialog
                        title="Delete subscriber?"
                        description={`${sub.email} will be permanently erased. This cannot be undone. To remove reversibly, use Archive instead.`}
                        confirmLabel="Delete permanently"
                        onConfirm={() => onDelete(sub)}
                        trigger={
                          <Tooltip label="Delete">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${sub.email}`}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </Tooltip>
                        }
                      /> : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

// Columns whose header re-sorts the list server-side (every value is one the
// list endpoint's normalizeSort accepts — see SUBSCRIBER_SORT_KEYS).
const COLUMN_SORT_KEYS: Partial<Record<DirectoryColumnKey, SubscriberSortKey>> = {
  email: "email",
  status: "status",
  first_name: "first_name",
  last_name: "last_name",
  joined: "created_at",
  engagement: "engagement",
  rating: "rating",
  churn_score: "churn",
};

// Engagement, rating and churn arrive on list rows when the server has scored
// the subscriber; they are not on the shared Subscriber type, so read them
// defensively and render an em dash when absent.
const NUMERIC_FIELDS: Partial<Record<DirectoryColumnKey, string>> = {
  engagement: "engagement_score",
  rating: "rating",
  churn_score: "churn_score",
};

function numericField(subscriber: Subscriber, field: string): string {
  const value = (subscriber as unknown as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "—";
}

function nameField(value: string | undefined): string {
  return typeof value === "string" && value.trim() ? value : "—";
}

function avatarInitial(subscriber: Subscriber): string {
  const source =
    subscriber.display_name ||
    subscriber.full_name ||
    subscriber.first_name ||
    subscriber.email;
  return source.trim().charAt(0).toUpperCase() || "?";
}

/** A read-only directory column (the editable ones render inline editors). */
function DirectoryCell({
  column,
  subscriber,
}: {
  column: DirectoryColumnKey;
  subscriber: Subscriber;
}) {
  const numeric = NUMERIC_FIELDS[column];
  if (numeric) {
    return (
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {numericField(subscriber, numeric)}
      </td>
    );
  }
  switch (column) {
    case "avatar":
      return (
        <td className="w-10 px-2 py-3">
          <span
            aria-hidden
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
          >
            {avatarInitial(subscriber)}
          </span>
        </td>
      );
    case "first_name":
    case "last_name":
    case "full_name":
    case "display_name":
      return (
        <td className="px-4 py-3 [overflow-wrap:anywhere]">
          {nameField(subscriber[column])}
        </td>
      );
    case "joined":
      return (
        <td
          className="px-4 py-3 text-muted-foreground"
          title={
            subscriber.created_at
              ? formatAbsoluteDate(subscriber.created_at)
              : undefined
          }
        >
          {subscriber.created_at ? formatListDate(subscriber.created_at) : "—"}
        </td>
      );
    case "archived_at":
      return (
        <td
          className="px-4 py-3 text-muted-foreground"
          title={
            subscriber.archived_at
              ? formatAbsoluteDate(subscriber.archived_at)
              : undefined
          }
        >
          {subscriber.archived_at ? formatListDate(subscriber.archived_at) : "—"}
        </td>
      );
    default:
      return <td className="px-4 py-3" />;
  }
}

function SubscriberCard({
  subscriber,
  selected,
  onToggle,
  onSuppress,
  onUnsuppress,
  onArchive,
  onUnarchive,
  onDelete,
  onOpen,
  onRowChanged,
  canWrite,
  canAdmin,
}: {
  subscriber: Subscriber;
  selected: boolean;
  onToggle: () => void;
  onSuppress: (sub: Subscriber) => void;
  onUnsuppress: (sub: Subscriber) => void;
  onArchive: (sub: Subscriber) => void;
  onUnarchive: (sub: Subscriber) => void;
  onDelete: (sub: Subscriber) => void | Promise<void>;
  onOpen: (sub: Subscriber) => void;
  onRowChanged: (updated: Subscriber) => void;
  canWrite: boolean;
  canAdmin: boolean;
}) {
  return (
    <article
      data-testid="subscriber-row"
      data-id={subscriber.id ?? subscriber.email}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest("button") ||
          target.closest("a") ||
          target.closest("input")
        )
          return;
        onOpen(subscriber);
      }}
      className={`cursor-pointer rounded-md border bg-card p-4 text-sm shadow-sm ${
        selected ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <input
          type="checkbox"
          aria-label={`Select ${subscriber.email}`}
          className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer rounded border-input accent-primary"
          checked={selected}
          onChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          {/* The card's own onClick is a tap-anywhere convenience and is
              mouse/touch-only: <article> is not focusable and fires no
              activation on Enter or Space. The desktop table already opens a
              subscriber through a named native button (see the <tr> above);
              this is the same affordance for the mobile card, so "open
              subscriber" is reachable from the keyboard here too. */}
          <button
            type="button"
            onClick={() => onOpen(subscriber)}
            aria-label={`Open subscriber ${subscriber.email}`}
            className="inline-flex min-h-8 items-center rounded-sm text-left font-medium leading-snug [overflow-wrap:anywhere] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {subscriber.email}
          </button>
          {typeof subscriber.custom_fields.name === "string" ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {subscriber.custom_fields.name}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={subscriber.status} />
          {subscriber.archived_at ? (
            <Badge variant="outline">Archived</Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="font-medium uppercase text-muted-foreground">
            Consent
          </div>
          <div className="mt-1">{labelize(subscriber.consent_source)}</div>
        </div>
        <div>
          <div className="font-medium uppercase text-muted-foreground">
            Updated
          </div>
          <div
            className="mt-1"
            title={formatAbsoluteDate(subscriber.updated_at)}
          >
            {formatListDate(subscriber.updated_at)}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
          Tags
        </div>
        <InlineTagChips
          subscriber={subscriber}
          canWrite={canWrite}
          onChanged={onRowChanged}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {subscriber.status === "blocklisted" && canAdmin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onUnsuppress(subscriber)}
          >
            <RotateCcw className="h-4 w-4" />
            Remove suppression
          </Button>
        ) : subscriber.status !== "blocklisted" && canWrite ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSuppress(subscriber)}
          >
            <Ban className="h-4 w-4" />
            Suppress
          </Button>
        ) : null}
        {canWrite && (subscriber.archived_at ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onUnarchive(subscriber)}
          >
            <ArchiveRestore className="h-4 w-4" />
            Unarchive
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onArchive(subscriber)}
          >
            <Archive className="h-4 w-4" />
            Archive
          </Button>
        ))}
        {canWrite ? <ConfirmDialog
          title="Delete subscriber?"
          description={`${subscriber.email} will be permanently erased. This cannot be undone. To remove reversibly, use Archive instead.`}
          confirmLabel="Delete permanently"
          onConfirm={() => onDelete(subscriber)}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="col-span-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          }
        /> : null}
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: SubscriberStatus }) {
  return (
    <Badge variant={subscriberStatusVariant(status)}>{labelize(status)}</Badge>
  );
}
