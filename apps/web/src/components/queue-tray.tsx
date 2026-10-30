// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * QueueTray — slideover listing the offline mutation outbox.
 *
 * Sections: pending, replaying, failed (soft-terminal), conflicted,
 * dead-letter. Each row exposes Retry / Resolve / Discard actions where
 * appropriate; attention sections add per-section bulk actions and replaying
 * items show an in-flight indicator (SHELL-035). Conflicts open the
 * ConflictModal.
 *
 * Mirrors apps/desktop/src/components/QueueTray.tsx but uses the web
 * stack: Radix Dialog + sonner toasts + semantic design tokens (so it follows
 * the active light/dark theme instead of a fixed dark slab — SHELL-013).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { flushQueuedMutations } from "@/lib/api";
import { useOnline } from "@/lib/use-online";
import {
  readOfflineQueue,
  writeOfflineQueue,
  type OfflineMutation,
} from "@/lib/offline-store";
import {
  discardOutboxItem,
  reissueAsOverwrite,
  retryOutboxItem,
  useOutbox,
} from "@/lib/outbox";
import { cn } from "@/lib/utils";
import { firstFocusable, trapFocus } from "@/lib/focus-trap";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConflictModal } from "./conflict-modal";

interface QueueTrayProps {
  open: boolean;
  onClose: () => void;
  panelId?: string;
}

interface QueueSection {
  key: string;
  title: string;
  items: OfflineMutation[];
  tone: "muted" | "warn" | "danger";
  bulkRetry: boolean;
  bulkDiscard: boolean;
}

interface DiscardRequest {
  label: string;
  items: OfflineMutation[];
}

export function QueueTray({ open, onClose, panelId }: QueueTrayProps) {
  const outbox = useOutbox();
  const conn = useOnline();
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const retryInFlightRef = useRef(false);
  const discardDialogOpenRef = useRef(false);
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [discardRequest, setDiscardRequest] = useState<DiscardRequest | null>(
    null,
  );
  const [conflictItem, setConflictItem] = useState<OfflineMutation | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (conflictItem || discardRequest) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        trapFocus(e, panelRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, conflictItem, discardRequest]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const initialFocus =
      closeButtonRef.current ?? firstFocusable(panelRef.current);
    initialFocus?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected) {
        previous.focus({ preventScroll: true });
      } else {
        // The launcher legitimately disappears when the last queued item is
        // discarded. Route focus to the shell's stable page landmark instead of
        // leaving it on <body> after the focused trigger is removed.
        document
          .querySelector<HTMLElement>("main#main-content")
          ?.focus({ preventScroll: true });
      }
    };
  }, [open]);

  // A successful row/bulk retry can remove the focused control while the tray
  // itself stays open. Repair only the browser's orphan-to-body outcome. When a
  // nested resolver/confirmation is active the tray is inert and the top modal
  // owns focus, so this observer deliberately yields.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new MutationObserver(() => {
      requestAnimationFrame(() => {
        if (
          !panel.isConnected ||
          panel.hasAttribute("inert") ||
          panel.contains(document.activeElement) ||
          document.activeElement !== document.body
        ) {
          return;
        }
        closeButtonRef.current?.focus({ preventScroll: true });
      });
    });
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open]);

  const sections = useMemo<QueueSection[]>(
    () => [
      {
        key: "replaying",
        title: "Syncing now",
        items: outbox.replaying,
        tone: "warn",
        bulkRetry: false,
        bulkDiscard: false,
      },
      {
        key: "pending",
        title: "Pending",
        items: outbox.pending,
        tone: "muted",
        bulkRetry: false,
        bulkDiscard: false,
      },
      {
        key: "conflicts",
        title: "Conflicts",
        items: outbox.conflicts,
        tone: "danger",
        bulkRetry: false,
        bulkDiscard: true,
      },
      {
        key: "failed",
        title: "Failed",
        items: outbox.failed,
        tone: "danger",
        bulkRetry: true,
        bulkDiscard: true,
      },
      {
        key: "deadLetter",
        title: "Needs attention",
        items: outbox.deadLetter,
        tone: "danger",
        bulkRetry: false,
        bulkDiscard: true,
      },
    ],
    [outbox],
  );

  if (!open) return null;
  const total = outbox.pendingCount + outbox.attentionCount;

  const onRetryAll = async (): Promise<void> => {
    if (retryInFlightRef.current) return;
    if (conn !== "online") {
      toast.info("Retry will run once you're back online.");
      return;
    }
    retryInFlightRef.current = true;
    setRetrying(true);
    try {
      const summary = await flushQueuedMutations();
      const parts: string[] = [];
      if (summary.replayed > 0) {
        parts.push(
          `${summary.replayed} ${summary.replayed === 1 ? "change" : "changes"} synced`,
        );
      }
      if (summary.failed > 0) {
        parts.push(`${summary.failed} failed`);
      }
      if (summary.conflicts > 0) {
        parts.push(
          `${summary.conflicts} ${summary.conflicts === 1 ? "conflict" : "conflicts"}`,
        );
      }
      // Report failures/conflicts explicitly instead of silently swallowing a
      // partial retry (SHELL-027).
      if (parts.length === 0) {
        toast.info("Nothing to retry.");
        return;
      }
      const message = parts.join(", ");
      if (summary.failed > 0 || summary.conflicts > 0) {
        toast.warning(message, {
          description: "Open the affected sections below to resolve them.",
        });
      } else {
        toast.success(message);
      }
    } catch {
      toast.error(
        "Queued changes could not be retried. They remain in the queue.",
      );
    } finally {
      retryInFlightRef.current = false;
      setRetrying(false);
    }
  };

  const bulkRetrySection = (items: OfflineMutation[]): void => {
    if (retryInFlightRef.current) return;
    for (const it of items) retryOutboxItem(it.id);
    if (conn === "online") void onRetryAll();
  };
  const bulkDiscardSection = (items: OfflineMutation[]): void => {
    for (const it of items) discardOutboxItem(it.id);
  };

  const requestDiscard = (
    request: DiscardRequest,
    trigger: HTMLButtonElement,
  ): void => {
    if (discardDialogOpenRef.current) return;
    discardDialogOpenRef.current = true;
    discardReturnFocusRef.current = trigger;
    setDiscardRequest(request);
  };

  const confirmDiscard = (): void => {
    const request = discardRequest;
    if (!request) return;
    // Confirmation removes the originating row/section. Point the dialog's
    // post-success fallback at a stable tray control before that DOM disappears;
    // cancellation still returns to the exact button that opened the dialog.
    discardReturnFocusRef.current = closeButtonRef.current;
    bulkDiscardSection(request.items);
    const count = request.items.length;
    toast.info(`Discarded ${count} ${count === 1 ? "item" : "items"}.`, {
      action: {
        label: "Undo",
        onClick: () => {
          const current = readOfflineQueue();
          const currentIds = new Set(current.map((item) => item.id));
          const restored = request.items.filter(
            (item) => !currentIds.has(item.id),
          );
          writeOfflineQueue(
            [...current, ...restored].sort(
              (left, right) =>
                Date.parse(left.queuedAt) - Date.parse(right.queuedAt),
            ),
          );
          toast.success(
            `Restored ${restored.length} ${restored.length === 1 ? "item" : "items"}.`,
          );
        },
      },
    });
  };

  const nestedDialogOpen = Boolean(conflictItem || discardRequest);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 bg-black/45",
          nestedDialogOpen ? "z-40" : "z-[70]",
        )}
        onClick={onClose}
        role="presentation"
        aria-hidden={nestedDialogOpen || undefined}
        inert={nestedDialogOpen ? true : undefined}
      />
      <aside
        id={panelId}
        ref={panelRef}
        className={cn(
          "fixed bottom-0 right-0 top-0 flex w-full max-w-[420px] flex-col border-l border-border bg-popover text-popover-foreground shadow-pw-lg",
          // The shell tray normally sits above page dialogs. Its own nested
          // resolver/confirmation uses the shared Radix z-50 layer, so lower
          // the inert tray for that interval or it would visually cover the
          // only dialog still exposed to assistive technology.
          nestedDialogOpen ? "z-[41]" : "z-[71]",
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Offline queue"
        aria-hidden={nestedDialogOpen || undefined}
        inert={nestedDialogOpen ? true : undefined}
        tabIndex={-1}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="m-0 flex-1 text-sm font-semibold text-foreground">
            Queue ({total})
          </h2>
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-8"
            onClick={() => void onRetryAll()}
            disabled={total === 0 || retrying}
            aria-busy={retrying || undefined}
          >
            {retrying ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            {retrying ? "Retrying…" : "Retry all"}
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <p className="m-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Web queues are kept only in this tab and are cleared on reload,
          sign-out, or workspace switch.
        </p>
        <div className="flex-1 overflow-y-auto p-3">
          {total === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No queued changes. New offline edits will appear here.
            </div>
          ) : (
            sections
              .filter((s) => s.items.length > 0)
              .map((s) => (
                <section key={s.key} className="mb-4">
                  <div className="mb-1.5 flex items-center gap-2">
                    <h3 className="flex flex-1 items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {s.title}
                      <span className={badgeClass(s.tone)}>
                        {s.items.length}
                      </span>
                    </h3>
                    {s.items.length > 1 && s.bulkRetry ? (
                      <button
                        type="button"
                        className="min-h-11 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-7"
                        onClick={() => bulkRetrySection(s.items)}
                        disabled={retrying}
                      >
                        Retry all
                      </button>
                    ) : null}
                    {s.items.length > 1 && s.bulkDiscard ? (
                      <button
                        type="button"
                        className="min-h-11 rounded border border-destructive/40 px-2 py-1 text-[11px] text-destructive-emphasis hover:bg-destructive/10 sm:min-h-7"
                        onClick={(event) =>
                          requestDiscard(
                            {
                              label: `${s.title} (${s.items.length})`,
                              items: [...s.items],
                            },
                            event.currentTarget,
                          )
                        }
                      >
                        Discard all
                      </button>
                    ) : null}
                  </div>
                  {s.items.map((it) => (
                    <QueueRow
                      key={it.id}
                      item={it}
                      retrying={retrying}
                      onRetry={() => {
                        retryOutboxItem(it.id);
                        if (conn === "online") void onRetryAll();
                        else
                          toast.info("Retry will run once you're back online.");
                      }}
                      onDiscard={(trigger) =>
                        requestDiscard(
                          { label: `${it.method} ${it.path}`, items: [it] },
                          trigger,
                        )
                      }
                      onResolveConflict={() => setConflictItem(it)}
                    />
                  ))}
                </section>
              ))
          )}
        </div>
      </aside>
      <ConfirmDialog
        open={Boolean(discardRequest)}
        onOpenChange={(next) => {
          if (next) return;
          discardDialogOpenRef.current = false;
          setDiscardRequest(null);
        }}
        title={
          discardRequest?.items?.length === 1
            ? "Discard queued change?"
            : `Discard ${discardRequest?.items?.length ?? 0} queued changes?`
        }
        description={
          <>
            <span className="font-medium text-foreground">
              {discardRequest?.label}
            </span>{" "}
            has not synced. Discarding removes this local work from the queue.
            An Undo action will be available briefly.
          </>
        }
        confirmLabel="Discard"
        fallbackFocusRef={discardReturnFocusRef}
        onConfirm={confirmDiscard}
      />
      <ConflictModal
        open={!!conflictItem}
        item={conflictItem}
        onClose={() => setConflictItem(null)}
        onKeepMine={(id) => {
          const next = reissueAsOverwrite(id);
          setConflictItem(null);
          if (next) {
            toast.success("Queued as overwrite. Will replay shortly.");
          }
        }}
        onKeepServer={(id) => {
          discardOutboxItem(id);
          setConflictItem(null);
          toast.info("Discarded your version. Server copy retained.");
        }}
      />
    </>
  );
}

function badgeClass(tone: "muted" | "warn" | "danger"): string {
  const base =
    "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold";
  if (tone === "danger")
    return cn(base, "bg-destructive/15 text-destructive-emphasis");
  if (tone === "warn")
    return cn(base, "bg-warning-subtle text-warning-emphasis");
  return cn(base, "bg-muted text-muted-foreground");
}

interface QueueRowProps {
  item: OfflineMutation;
  onRetry: () => void;
  onDiscard: (trigger: HTMLButtonElement) => void;
  onResolveConflict: () => void;
  retrying: boolean;
}

function QueueRow({
  item,
  onRetry,
  onDiscard,
  onResolveConflict,
  retrying,
}: QueueRowProps) {
  const queuedAgo = useMemo(() => relTime(item.queuedAt), [item.queuedAt]);
  const isConflict = item.status === "conflict";
  const isReplaying = item.status === "replaying";
  return (
    <div className="mb-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {item.method}
        </span>
        <span
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-foreground"
          title={item.path}
        >
          {item.path}
        </span>
        {isReplaying ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-warning-emphasis"
            aria-label="Syncing"
          >
            <Loader2
              className="h-3 w-3 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            Syncing…
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Queued {queuedAgo} · attempts {item.attempts}
        {item.resource ? ` · ${item.resource}` : ""}
      </div>
      {item.lastError ? (
        <div className="mt-1 break-words text-[11px] text-destructive-emphasis [overflow-wrap:anywhere]">
          {item.lastError}
        </div>
      ) : null}
      {!isReplaying ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {isConflict ? (
            <button
              type="button"
              className="min-h-11 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-8"
              onClick={onResolveConflict}
            >
              Resolve
            </button>
          ) : (
            <button
              type="button"
              className="min-h-11 rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-8"
              onClick={onRetry}
              disabled={retrying}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="min-h-11 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive-emphasis hover:bg-destructive/20 sm:min-h-8"
            onClick={(event) => onDiscard(event.currentTarget)}
          >
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "moments ago";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "moments ago";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
