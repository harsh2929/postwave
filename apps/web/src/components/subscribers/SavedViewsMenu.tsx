// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { base, STALE } from "@/lib/query-keys";
import { getSavedSegmentAggregatePreview } from "@/lib/segment-parity-api";
import {
  createSavedDirectoryView,
  DEFAULT_DIRECTORY_COLUMNS,
  deleteSavedDirectoryView,
  getDirectoryViewPrefs,
  listSavedDirectoryViews,
  touchSavedDirectoryView,
  type DirectoryView,
  type SavedDirectoryView,
  type SavedViewScope,
} from "@/lib/subscriber-directory-api";

import { DIRECTORY_STATUS_CHIPS } from "./DirectoryStatusChips";
import { DIRECTORY_SORT_OPTIONS } from "./DirectorySortControl";
import {
  sameDirectoryView,
  useDirectoryIdentity,
  useDirectoryUrlState,
} from "./directory-context";

/** Previews run automatically for the first few applicable views only. */
const AUTO_PREVIEW_LIMIT = 8;

export function describeDirectoryView(view: DirectoryView): string {
  const parts = [
    DIRECTORY_STATUS_CHIPS.find((chip) => chip.value === view.status)?.label ??
      view.status,
  ];
  if (view.q.trim()) parts.push(`“${view.q.trim()}”`);
  if (view.archived) parts.push("incl. archived");
  const sort =
    DIRECTORY_SORT_OPTIONS.find((option) => option.value === view.sort)?.label ??
    view.sort;
  parts.push(`${sort} ${view.order === "asc" ? "↑" : "↓"}`);
  return parts.join(" · ");
}

export function SavedViewsMenu() {
  const identity = useDirectoryIdentity();
  const { view, applyView } = useDirectoryUrlState();
  const queryClient = useQueryClient();
  const nameId = useId();
  const scopeId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<SavedViewScope>("personal");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const savedKey = base("saved-directory-views", identity.tenantId, identity.role);
  const saved = useQuery({
    queryKey: savedKey,
    queryFn: ({ signal }) => listSavedDirectoryViews(identity.tenantId, signal),
    enabled: open && identity.ready,
    staleTime: STALE.list,
  });
  const prefs = useQuery({
    queryKey: base("subscribers-view-prefs", identity.tenantId, identity.role),
    queryFn: ({ signal }) => getDirectoryViewPrefs(signal),
    enabled: open && identity.ready,
    staleTime: STALE.list,
  });

  const invalidateSaved = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: savedKey }),
      queryClient.invalidateQueries({
        queryKey: base("saved-segment-bookmarks", identity.tenantId, identity.role),
      }),
    ]);

  const items = Array.isArray(saved.data?.items) ? saved.data.items : [];
  const atLimit = saved.data
    ? saved.data.totalItems >= saved.data.maxItems
    : false;
  const duplicate = items.some(
    (item) => item.name.toLowerCase() === name.trim().toLowerCase(),
  );
  const saveBlocked = !identity.canWrite
    ? "Viewers can apply saved views but cannot create them."
    : atLimit
      ? "This workspace has reached its saved-view limit. Delete one first."
      : duplicate
        ? "A saved view with this name already exists."
        : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || saveBlocked || !name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await createSavedDirectoryView(
        {
          name,
          scope,
          view,
          columns: prefs.data?.columns ?? DEFAULT_DIRECTORY_COLUMNS,
        },
        identity.tenantId,
      );
      await invalidateSaved();
      setName("");
      toast.success(`Saved view “${created.name}”.`);
    } catch (error) {
      setSaveError(apiErrorMessage(error, "Could not save this view."));
    } finally {
      setSaving(false);
    }
  };

  const apply = (item: SavedDirectoryView) => {
    if (!item.view) return;
    applyView(item.view);
    setOpen(false);
    toast.success(`Applied “${item.name}”.`);
    void touchSavedDirectoryView(item.id).catch(() => {
      /* recency only — the view itself is already applied */
    });
  };

  const remove = async (item: SavedDirectoryView) => {
    try {
      await deleteSavedDirectoryView(item.id);
      await invalidateSaved();
      toast.success(`Deleted “${item.name}”.`);
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not delete this saved view."));
      throw error;
    }
  };

  let applicableIndex = 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9">
          <Bookmark aria-hidden className="h-4 w-4" />
          Saved views
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Saved directory views</DialogTitle>
          <DialogDescription>
            Current view: {describeDirectoryView(view)}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-2 border-b pb-4" onSubmit={save}>
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Save the current view as</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={120}
              placeholder="e.g. Unconfirmed this month"
              disabled={!identity.canWrite || saving}
              onChange={(event) => {
                setName(event.target.value);
                setSaveError(null);
              }}
            />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor={scopeId}>Visible to</Label>
              <Select
                id={scopeId}
                value={scope}
                disabled={!identity.canWrite || saving}
                onChange={(event) =>
                  setScope(event.target.value as SavedViewScope)
                }
                className="w-44"
              >
                <option value="personal">Only me</option>
                <option value="workspace">Everyone in the workspace</option>
              </Select>
            </div>
            <Button
              type="submit"
              disabled={Boolean(saveBlocked) || !name.trim() || saving}
              title={saveBlocked ?? undefined}
            >
              {saving ? "Saving…" : "Save view"}
            </Button>
          </div>
          {saveBlocked && identity.ready && saved.isSuccess ? (
            <p className="text-xs text-muted-foreground">{saveBlocked}</p>
          ) : null}
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
        </form>

        {saved.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading saved views…
          </p>
        ) : saved.isError ? (
          <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <span>{apiErrorMessage(saved.error, "Could not load saved views.")}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void saved.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved views yet. Save the current filters to reuse them.
          </p>
        ) : (
          <ul aria-label="Saved views" className="max-h-80 space-y-2 overflow-y-auto" tabIndex={0}>
            {items.map((item) => {
              const autoPreview =
                item.view !== null && applicableIndex++ < AUTO_PREVIEW_LIMIT;
              return (
                <SavedViewRow
                  key={item.id}
                  item={item}
                  active={item.view !== null && sameDirectoryView(item.view, view)}
                  autoPreview={autoPreview && open}
                  canWrite={identity.canWrite}
                  identityKey={savedKey}
                  onApply={() => apply(item)}
                  onDelete={() => remove(item)}
                />
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SavedViewRow({
  item,
  active,
  autoPreview,
  canWrite,
  identityKey,
  onApply,
  onDelete,
}: {
  item: SavedDirectoryView;
  active: boolean;
  autoPreview: boolean;
  canWrite: boolean;
  identityKey: readonly unknown[];
  onApply: () => void;
  onDelete: () => Promise<void>;
}) {
  const [requested, setRequested] = useState(false);
  const preview = useQuery({
    queryKey: [...identityKey, "preview", item.id],
    queryFn: ({ signal }) => getSavedSegmentAggregatePreview(item.id, signal),
    enabled: item.view !== null && (autoPreview || requested),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const countText = preview.data
    ? `${preview.data.count.toLocaleString()} match now`
    : preview.isError
      ? "count unavailable"
      : preview.isFetching
        ? "counting…"
        : item.lastCount !== null
          ? `${item.lastCount.toLocaleString()} at last count`
          : null;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.name}</span>
          <Badge variant="outline">
            {item.scope === "workspace" ? "Workspace" : "Personal"}
          </Badge>
          {active ? <Badge variant="secondary">Applied</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {item.view
            ? describeDirectoryView(item.view)
            : "Not a directory view — open it from Segments."}
          {countText ? ` · ${countText}` : null}
        </p>
      </div>
      {item.view !== null && !autoPreview && !preview.data ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRequested(true)}
          disabled={preview.isFetching}
        >
          Count
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant={active ? "secondary" : "default"}
        disabled={item.view === null}
        onClick={onApply}
      >
        Apply
      </Button>
      {canWrite ? (
        <ConfirmDialog
          title={`Delete saved view “${item.name}”?`}
          description={
            item.scope === "workspace"
              ? "Everyone in the workspace loses this view. Subscribers are not changed."
              : "The view is removed for you. Subscribers are not changed."
          }
          confirmLabel="Delete view"
          confirmVariant="destructive"
          onConfirm={onDelete}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Delete saved view ${item.name}`}
            >
              <Trash2 aria-hidden className="h-4 w-4" />
            </Button>
          }
        />
      ) : null}
    </li>
  );
}
