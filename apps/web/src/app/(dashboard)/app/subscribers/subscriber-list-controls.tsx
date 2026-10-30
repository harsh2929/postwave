// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";
import { Ban, Download, Tag, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";
import type { Subscriber } from "@/lib/subscribers-api";

export const subId = (subscriber: Subscriber): string =>
  subscriber.id ?? subscriber.email;

function BulkToolLoading({ label }: { label: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      Loading {label}…
    </span>
  );
}

// The evidence-gated resubscribe and the one-key field writes are admin tools
// that only render once rows are selected; keep them off the list's critical
// bundle, as the other bulk audience tools are.
const LazyBulkResubscribeDialog = dynamic(
  () =>
    import("@/components/subscribers/BulkResubscribeDialog").then(
      (module) => module.BulkResubscribeDialog,
    ),
  { ssr: false, loading: () => <BulkToolLoading label="bulk re-subscribe" /> },
);
const LazyBulkFieldValueDialog = dynamic(
  () =>
    import("@/components/subscribers/BulkFieldValueDialog").then(
      (module) => module.BulkFieldValueDialog,
    ),
  { ssr: false, loading: () => <BulkToolLoading label="bulk field editor" /> },
);

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
  if (!onClick) {
    return <div className="rounded-md border bg-card px-4 py-3">{content}</div>;
  }
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
  onDelete,
  onTag,
  onAddToList,
  onExport,
  exporting,
  canAdmin,
  audienceAdminActions,
  selectedRows,
  resolveIds,
  authority,
  onChanged,
}: {
  count: number;
  totalMatching: number;
  allMatchingSelected: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onSuppress: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onTag: (tag: string) => void | Promise<void>;
  onAddToList: (listId: string, listName?: string) => void | Promise<void>;
  onExport: () => void | Promise<void>;
  exporting: boolean;
  canAdmin: boolean;
  audienceAdminActions?: ReactNode;
  /** The explicitly selected rows (resubscribe judges eligibility from them). */
  selectedRows: readonly Subscriber[];
  /** The concrete ids a bulk field write targets, resolved at submit time. */
  resolveIds: () => Promise<string[]>;
  authority: SubscriberAuthority | null;
  /** A bulk write landed; refresh the list. */
  onChanged: () => void;
}) {
  if (count === 0) return null;
  const effective = allMatchingSelected ? totalMatching : count;
  const noun = `${effective.toLocaleString()} subscriber${effective === 1 ? "" : "s"}`;

  return (
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
          {canAdmin ? <>
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
          {/* POST /bulk/resubscribe requires the full consent-evidence
              envelope; a bare id list is refused with invalid_consent_evidence. */}
          <LazyBulkResubscribeDialog
            rows={selectedRows}
            allMatchingSelected={allMatchingSelected}
            canAdmin={canAdmin}
            authority={authority}
            onDone={onChanged}
          />
          {/* One key per request via /bulk/set-custom-field and
              /bulk/update-merge-field — never a whole custom_fields map,
              which the profile PATCH treats as a full replace. */}
          <LazyBulkFieldValueDialog
            mode="custom"
            count={effective}
            resolveIds={resolveIds}
            canAdmin={canAdmin}
            authority={authority}
            onDone={onChanged}
          />
          <LazyBulkFieldValueDialog
            mode="merge"
            count={effective}
            resolveIds={resolveIds}
            canAdmin={canAdmin}
            authority={authority}
            onDone={onChanged}
          />
          <BulkDeleteButton onDelete={onDelete} count={effective} />
          </> : null}
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
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => setOpen(true)}
      >
        <Tag className="h-4 w-4" />
        Tag
      </Button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
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
        onChange={(event) => setTag(event.target.value)}
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
  );
}

function BulkAddToListButton({
  onAddToList,
}: {
  onAddToList: (listId: string, listName?: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [listId, setListId] = useState("");
  const [pending, setPending] = useState(false);
  // The session the directory already read; no new module on the route graph.
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
    // The lists catalogue is read only once this picker opens, so its API
    // module is fetched with it rather than with the directory.
    queryFn: async () => (await import("@/lib/forms-api")).listLists(),
    enabled: open && me.isSuccess,
    staleTime: STALE.list,
  });
  const lists = Array.isArray(listsQuery.data) ? listsQuery.data : [];

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
    <div className="flex flex-col gap-1 rounded-md border bg-background p-2">
      <div className="flex items-center gap-1">
        <Select
          aria-label="Choose a list"
          value={listId}
          onChange={(event) => setListId(event.target.value)}
          className="h-8 w-44"
        >
          {/* A failed fetch also leaves `lists` empty, so "Choose a list…"
              over an empty menu would read as "this workspace has no lists"
              and send the operator off to create a duplicate one. */}
          <option value="">
            {listsQuery.isPending
              ? "Loading lists…"
              : listsQuery.isError
                ? "Lists unavailable"
                : "Choose a list…"}
          </option>
          {lists.map((list) => (
            <option key={String(list.id)} value={String(list.id)}>
              {list.name}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          size="sm"
          disabled={!listId || pending}
          title={
            listId
              ? undefined
              : listsQuery.isError
                ? "Lists could not be loaded — retry before adding"
                : "Choose a list first"
          }
          onClick={async () => {
            if (!listId) return;
            setPending(true);
            try {
              // The name travels with the id so the receipt can say which
              // list the contacts joined.
              await onAddToList(
                listId,
                lists.find((list) => String(list.id) === listId)?.name,
              );
              setOpen(false);
              setListId("");
            } finally {
              setPending(false);
            }
          }}
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
      {listsQuery.isError ? (
        <div
          role="alert"
          className="flex items-center gap-2 text-xs text-destructive"
        >
          <span>Could not load lists.</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => void listsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

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
          onChange={(event) => setConfirmText(event.target.value)}
          placeholder="DELETE"
          aria-label="Type DELETE to confirm"
          className="h-8 w-28"
        />
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={!armed || pending}
          onClick={async () => {
            if (!armed) return;
            setPending(true);
            try {
              await onDelete();
              setOpen(false);
              setConfirmText("");
            } finally {
              setPending(false);
            }
          }}
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
