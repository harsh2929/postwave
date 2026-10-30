// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Saved views for the Analytics page (desktop SavedViewsMenu +
// SavedViewsPopover + SavedViewNamingModal). "Views" opens a small panel:
//
//   * Apply   — writes the saved range / tab / metric / focus / compare /
//               group-by back to the URL (one history entry, so Back returns
//               to where you were) and tells every URL reader to resync.
//   * Delete  — through a confirm that names what goes: the saved view in
//               this browser, never any analytics data.
//   * Save current view… — names a snapshot of the URL state as it is now.
//
// Views live in this browser's localStorage, scoped by workspace + user
// (lib/analytics-saved-views). There is no server call; every account can
// save its own views, and the menu waits for the signed-in identity before it
// reads or writes anything so one account's views never show under another.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Bookmark, Check, Plus, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  analyticsAuthorityFrom,
  analyticsAuthorityReady,
} from "@/lib/analytics-authority";
import {
  MAX_SAVED_VIEWS,
  MAX_VIEW_NAME,
  describeViewState,
  newSavedViewId,
  readAnalyticsViewState,
  readSavedViews,
  sameViewState,
  savedViewHref,
  savedViewNameProblem,
  writeSavedViews,
  type AnalyticsViewState,
  type SavedView,
} from "@/lib/analytics-saved-views";
import { whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";

/**
 * Put a saved view into the URL and make the page pick it up. The page and
 * useAnalyticsView both resync on popstate; a synthetic one carries no
 * `state`, which the app router deliberately ignores, so this is a URL
 * change the router never sees as a navigation.
 */
export function applySavedViewToUrl(view: AnalyticsViewState): void {
  const href = savedViewHref(view, window.location.search);
  window.history.pushState(window.history.state, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function storageErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.name === "QuotaExceededError") {
    return "This browser's storage for Moosewave is full, so the view couldn't be saved.";
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return "The view couldn't be saved in this browser.";
}

export function SavedViewsMenu() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const authority = analyticsAuthorityFrom(meQuery.data);
  const ready = analyticsAuthorityReady(authority);
  const { tenantId, userId } = authority;
  const scope = ready ? `${tenantId}:${userId}` : null;

  const [views, setViews] = useState<SavedView[]>([]);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<AnalyticsViewState | null>(null);
  const [naming, setNaming] = useState<AnalyticsViewState | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SavedView | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const scopeAtOpenRef = useRef<string | null>(null);
  const panelId = useId();
  const headingId = useId();
  const nameInputId = useId();
  const nameErrorId = useId();

  // One identity, one list: re-read on every scope change and drop anything
  // that was open for the previous account.
  useEffect(() => {
    setOpen(false);
    setNaming(null);
    setPendingDelete(null);
    setViews(scope ? readSavedViews(tenantId, userId) : []);
    // `scope` is derived from exactly tenantId + userId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function togglePanel() {
    if (open) {
      setOpen(false);
      return;
    }
    // The URL is the source of truth; read it at open time (the range picker
    // writes it without an event), and pick up other tabs' changes too.
    setCurrent(readAnalyticsViewState(window.location.search));
    if (scope) setViews(readSavedViews(tenantId, userId));
    setOpen(true);
  }

  function startSaving() {
    setOpen(false);
    scopeAtOpenRef.current = scope;
    setName("");
    setNameError(null);
    setNaming(readAnalyticsViewState(window.location.search));
  }

  function saveNamedView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!naming || !scope) return;
    if (scopeAtOpenRef.current !== scope) {
      setNameError("Your workspace changed before the view could be saved.");
      return;
    }
    const latest = readSavedViews(tenantId, userId);
    if (latest.length >= MAX_SAVED_VIEWS) {
      setNameError(
        `You have ${MAX_SAVED_VIEWS} saved views, the most this browser keeps. Delete one before saving another.`,
      );
      return;
    }
    const problem = savedViewNameProblem(name, latest);
    if (problem) {
      setNameError(problem);
      return;
    }
    const view: SavedView = {
      ...naming,
      id: newSavedViewId(),
      name: name.trim(),
    };
    try {
      writeSavedViews(tenantId, userId, [...latest, view]);
    } catch (cause) {
      setNameError(storageErrorMessage(cause));
      return;
    }
    setViews([...latest, view]);
    setNaming(null);
    setAnnouncement(`Saved view ${view.name}.`);
    toast.success(`Saved view “${view.name}”.`);
    triggerRef.current?.focus();
  }

  function applyView(view: SavedView) {
    applySavedViewToUrl(view);
    setOpen(false);
    setAnnouncement(`Applied saved view ${view.name}.`);
    triggerRef.current?.focus();
  }

  async function deleteView(view: SavedView) {
    if (!scope) throw new Error("Your identity is still being verified.");
    const latest = readSavedViews(tenantId, userId);
    const next = latest.filter((v) => v.id !== view.id);
    try {
      writeSavedViews(tenantId, userId, next);
    } catch (cause) {
      throw new Error(
        cause instanceof Error && cause.name === "QuotaExceededError"
          ? "This browser's storage for Moosewave is unavailable, so the view couldn't be deleted."
          : "The view couldn't be deleted in this browser.",
      );
    }
    setViews(next);
    setAnnouncement(`Deleted saved view ${view.name}.`);
  }

  const limitReached = views.length >= MAX_SAVED_VIEWS;

  return (
    <div ref={rootRef} className="relative inline-block text-left">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-8"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        disabled={!ready}
        title={ready ? undefined : "Loading your saved views…"}
        onClick={togglePanel}
      >
        <Bookmark className="h-4 w-4" aria-hidden />
        Views
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          className="absolute right-0 z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-2 shadow-pw-lg"
        >
          <p id={headingId} className="px-2 pb-1 pt-1 text-sm font-semibold">
            Saved views
          </p>
          {views.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-muted-foreground">
              No saved views yet. Save the current range, tab and chart
              settings to come back to them in one click.
            </p>
          ) : (
            <ul className="max-h-72 space-y-0.5 overflow-y-auto">
              {views.map((view) => {
                const isCurrent = current ? sameViewState(view, current) : false;
                return (
                  <li
                    key={view.id}
                    className="flex items-center gap-1 rounded-sm hover:bg-accent/60"
                  >
                    <button
                      type="button"
                      data-saved-view-apply
                      className="flex min-h-11 min-w-0 flex-1 flex-col items-start rounded-sm px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
                      aria-label={`Apply saved view ${view.name}${isCurrent ? " (current)" : ""}`}
                      onClick={() => applyView(view)}
                    >
                      <span className="flex w-full items-center gap-1.5 truncate text-sm font-medium">
                        {isCurrent ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                        ) : null}
                        <span className="truncate">{view.name}</span>
                      </span>
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {describeViewState(view)}
                      </span>
                    </button>
                    <IconButton
                      size="sm"
                      aria-label={`Delete saved view ${view.name}`}
                      onClick={() => {
                        setOpen(false);
                        setPendingDelete(view);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-1 border-t pt-1">
            <button
              type="button"
              data-saved-view-create
              disabled={limitReached}
              className="flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
              onClick={startSaving}
            >
              <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
              Save current view…
            </button>
            {limitReached ? (
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                {MAX_SAVED_VIEWS} saved views is the most this browser keeps.
                Delete one before saving another.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <Dialog
        open={naming !== null}
        onOpenChange={(next) => {
          if (!next) setNaming(null);
        }}
      >
        <DialogContent>
          <form onSubmit={saveNamedView} className="space-y-4" noValidate>
            <DialogHeader>
              <DialogTitle>Save current view</DialogTitle>
              <DialogDescription>
                {naming
                  ? `Saves ${describeViewState(naming).toLowerCase()}. Views are kept in this browser for your account in this workspace.`
                  : null}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor={nameInputId}>View name</Label>
              <Input
                id={nameInputId}
                value={name}
                maxLength={MAX_VIEW_NAME}
                autoComplete="off"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? nameErrorId : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
              {nameError ? (
                <p id={nameErrorId} role="alert" className="text-xs text-destructive">
                  {nameError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNaming(null)}
              >
                Cancel
              </Button>
              <Button type="submit">Save view</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        returnFocusRef={triggerRef}
        title="Delete saved view?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” will be removed from your saved views in this browser. Your analytics data isn't affected, and this can't be undone.`
            : ""
        }
        confirmLabel="Delete view"
        onConfirm={async () => {
          if (pendingDelete) await deleteView(pendingDelete);
        }}
      />
    </div>
  );
}
