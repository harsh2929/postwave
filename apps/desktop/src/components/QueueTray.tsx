/**
 * QueueTray — slideover listing the offline mutation outbox.
 *
 * Sections: pending, replaying, failed (retrying), conflicted,
 * dead-letter. Each row exposes Retry / Discard actions where
 * appropriate; failed / conflict / dead-letter rows additionally expose
 * Edit, which opens the QueuedMutationEditor so the operator can fix
 * the queued body before retry (an edited conflict re-queues via
 * reissueAsOverwrite, same as the ConflictModal's keep-mine path).
 * Conflicts open the ConflictModal (edit / overwrite / discard).
 * Pending items can only be discarded — replay drives itself when we
 * reconnect.
 *
 * Esc handling registers on the global dialogStack (like Modal) so a
 * nested ConflictModal gets the keypress first and Esc never falls
 * through to surfaces below the tray.
 *
 * Side wiring that lives here because this is where the queue count is
 * already subscribed:
 *   - OS tray/dock badge (tauriApi.setTrayBadge) mirrors the queued
 *     count, guarded on isTauri().
 *   - Durable-persistence failures stay visible until a later encrypted
 *     write proves the journal is healthy again.
 */

import { type ReactElement, useEffect, useId, useMemo, useState } from "react";

import { flushQueuedMutations } from "../lib/api-client";
import { pushDialog, popDialog } from "../lib/dialogStack";
import { useDialogStack } from "../hooks/useDialogStack";
import { useOnline } from "../lib/online-manager";
import { type OfflineMutation } from "../lib/offline-store";
import {
  discardOutboxItem,
  reissueAsOverwrite,
  restoreOutboxItem,
  retryOutboxItem,
  useOutbox,
} from "../lib/outbox";
import { isTauri, tauriApi } from "../lib/tauri";
import { ConflictModal } from "./ConflictModal";
import { ConfirmModal } from "./ConfirmModal";
import { QueuedMutationEditor } from "./QueuedMutationEditor";
import { toast } from "./Toast";

interface QueueTrayProps {
  open: boolean;
  onClose: () => void;
}

/** Module-level so the 3 mounted QueueTray instances (StatusBar,
 *  OfflineBanner, OfflineScreen) don't issue duplicate badge IPC. */
let lastTrayBadge: number | null = null;

export function QueueTray({
  open,
  onClose,
}: QueueTrayProps): ReactElement | null {
  const outbox = useOutbox();
  const conn = useOnline();
  const [conflictItem, setConflictItem] = useState<OfflineMutation | null>(
    null,
  );
  const [editItem, setEditItem] = useState<OfflineMutation | null>(null);
  const [discardItem, setDiscardItem] = useState<OfflineMutation | null>(null);
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);

  /* dialogStack registration — same pattern as Modal. The nested
   * ConflictModal pushes itself on top, so our Esc handler defers to it
   * automatically via isTop. */
  useEffect(() => {
    if (!open) return;
    pushDialog(dialogId);
    return () => popDialog(dialogId);
  }, [open, dialogId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTop) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, isTop]);

  const total = outbox.pendingCount + outbox.attentionCount;

  /* OS tray/dock badge mirrors the queued-mutation count (audit §8 —
   * set_tray_badge was shipped but never invoked). */
  useEffect(() => {
    if (!isTauri()) return;
    const next = total > 0 ? total : null;
    if (next === lastTrayBadge) return;
    lastTrayBadge = next;
    void tauriApi.setTrayBadge(next);
  }, [total]);

  const sections = useMemo(
    () => [
      {
        key: "replaying",
        title: "Syncing now",
        items: outbox.replaying,
        tone: "warn" as const,
      },
      {
        key: "pending",
        title: "Pending",
        items: outbox.pending,
        tone: "muted" as const,
      },
      {
        key: "conflicts",
        title: "Conflicts",
        items: outbox.conflicts,
        tone: "danger" as const,
      },
      {
        key: "failed",
        title: "Failed",
        items: outbox.failed,
        tone: "danger" as const,
      },
      {
        key: "deadLetter",
        title: "Needs attention",
        items: outbox.deadLetter,
        tone: "danger" as const,
      },
    ],
    [outbox],
  );

  if (!open) return null;

  const onRetryAll = async (): Promise<void> => {
    if (conn !== "online") {
      toast.info("Retry will run once you're back online.");
      return;
    }
    const summary = await flushQueuedMutations();
    if (summary.replayed > 0) {
      toast.success(
        `${summary.replayed} ${summary.replayed === 1 ? "change" : "changes"} synced`,
      );
    }
    if (
      summary.failed === 0 &&
      summary.conflicts === 0 &&
      summary.replayed === 0
    ) {
      toast.info("Nothing to retry.");
    }
  };

  return (
    <>
      <div
        className="queue-tray-backdrop"
        onClick={onClose}
        role="presentation"
      />
      <aside
        className="queue-tray"
        role="dialog"
        aria-modal="true"
        aria-label="Offline sync journal"
      >
        <header className="queue-tray-header">
          <h2 className="queue-tray-title">Sync journal ({total})</h2>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onRetryAll()}
            disabled={total === 0}
          >
            Retry all
          </button>
          <button
            type="button"
            className="queue-tray-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="queue-tray-body">
          {outbox.persistenceError ? (
            <div className="notice notice-danger" role="alert">
              <strong>Offline storage needs attention</strong>
              <div>{outbox.persistenceError}</div>
              <div>
                Existing durable entries are retained. A new edit is never
                reported as queued unless encrypted persistence succeeds.
              </div>
            </div>
          ) : null}
          {total === 0 ? (
            <div className="queue-tray-empty">
              No unsynced changes. New offline edits will appear here.
            </div>
          ) : (
            sections
              .filter((s) => s.items.length > 0)
              .map((s) => (
                <section key={s.key} className="queue-tray-section">
                  <h3 className="queue-tray-section-title">
                    {s.title}
                    <span className={badgeClass(s.tone)}>{s.items.length}</span>
                  </h3>
                  {s.items.map((it) => (
                    <QueueRow
                      key={it.id}
                      item={it}
                      onRetry={() => {
                        retryOutboxItem(it.id);
                        // D01-offline-sync#11: retryOutboxItem only flips
                        // the row to pending/attempts=0; without kicking a
                        // drain the item waits up to 60s for the interval
                        // tick. Kick a flush now (skipped while offline —
                        // the reconnect handler drains then).
                        if (conn === "online") void flushQueuedMutations();
                      }}
                      onEdit={() => setEditItem(it)}
                      onDiscard={() => setDiscardItem(it)}
                      onResolveConflict={() => setConflictItem(it)}
                    />
                  ))}
                </section>
              ))
          )}
          {outbox.recent.length > 0 ? (
            <section
              className="queue-tray-section"
              aria-label="Recent sync outcomes"
            >
              <h3 className="queue-tray-section-title">Recent outcomes</h3>
              {outbox.recent.map((entry) => (
                <div key={entry.id} className="queue-tray-item">
                  <div className="queue-tray-item-row">
                    <strong>{entry.actionLabel}</strong>
                    <span className="queue-tray-item-path">
                      {entry.recordLabel}
                    </span>
                  </div>
                  <div className="queue-tray-item-meta">
                    {entry.status === "synced"
                      ? "Server confirmed"
                      : "Discarded locally"}{" "}
                    · {relTime(entry.resolvedAt)}
                  </div>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </aside>
      <ConflictModal
        open={!!conflictItem}
        item={conflictItem}
        onClose={() => setConflictItem(null)}
        onKeepMine={(id) => {
          const next = reissueAsOverwrite(id);
          setConflictItem(null);
          if (next) {
            toast.info(
              "Overwrite saved on this device · pending server confirmation.",
            );
          }
        }}
        onKeepServer={(id) => {
          const discarded = conflictItem;
          discardOutboxItem(id);
          setConflictItem(null);
          toast.info({
            message: "Discarded your version. Server copy retained.",
            ...(discarded
              ? {
                  action: {
                    label: "Undo",
                    onClick: () => restoreOutboxItem(discarded),
                  },
                }
              : {}),
          });
        }}
      />
      <QueuedMutationEditor
        open={!!editItem}
        item={editItem}
        onClose={() => setEditItem(null)}
        onSaved={(id) => {
          // The editor has already persisted the edited body with
          // status "pending" / attempts 0. An edited CONFLICT must
          // additionally re-queue through the keep-mine path so it
          // replays as a forced overwrite (If-Match: *) — otherwise the
          // stale If-Match would just 412 again.
          const wasConflict = editItem?.status === "conflict";
          setEditItem(null);
          if (wasConflict) {
            reissueAsOverwrite(id);
            toast.info(
              "Edited overwrite saved on this device · pending server confirmation.",
            );
          } else {
            toast.info(
              "Edited change saved on this device · pending server confirmation.",
            );
          }
        }}
      />
      <ConfirmModal
        open={!!discardItem}
        title="Discard unsynced change?"
        description={
          discardItem
            ? `${discardItem.actionLabel ?? "Queued change"} · ${discardItem.recordLabel ?? "record"}`
            : undefined
        }
        confirmLabel="Discard local change"
        danger
        onClose={() => setDiscardItem(null)}
        onConfirm={() => {
          if (!discardItem) return;
          const discarded = discardItem;
          discardOutboxItem(discarded.id);
          setDiscardItem(null);
          toast.info({
            message:
              "Local queued change discarded. The server was not modified.",
            action: {
              label: "Undo",
              onClick: () => restoreOutboxItem(discarded),
            },
          });
        }}
      >
        This removes the only local copy from the encrypted sync journal. It
        cannot be restored from Moosewave because the server has not accepted it.
      </ConfirmModal>
    </>
  );
}

function badgeClass(tone: "muted" | "warn" | "danger"): string {
  if (tone === "danger") return "queue-tray-badge queue-tray-badge-danger";
  if (tone === "warn") return "queue-tray-badge queue-tray-badge-warn";
  return "queue-tray-badge";
}

interface QueueRowProps {
  item: OfflineMutation;
  onRetry: () => void;
  onEdit: () => void;
  onDiscard: () => void;
  onResolveConflict: () => void;
}

function QueueRow({
  item,
  onRetry,
  onEdit,
  onDiscard,
  onResolveConflict,
}: QueueRowProps): ReactElement {
  const queuedAgo = useMemo(() => relTime(item.queuedAt), [item.queuedAt]);
  const isConflict = item.status === "conflict";
  // Edit is offered where a human needs to intervene anyway — failed,
  // conflicted, and dead-letter rows. Pending/replaying bodies are
  // about to be sent as-is; editing them mid-flight would race the
  // drain.
  const canEdit =
    item.status === "failed" ||
    item.status === "conflict" ||
    item.status === "dead-letter";
  const canRetry = item.status === "failed" || item.status === "dead-letter";
  return (
    <div className="queue-tray-item">
      <div className="queue-tray-item-row">
        <strong>{item.actionLabel ?? "Queued change"}</strong>
        <span className="queue-tray-item-path">
          {item.recordLabel ?? "Record"}
        </span>
      </div>
      <div className="queue-tray-item-meta">
        {statusLabel(item.status)} · saved on this device {queuedAgo} · attempts{" "}
        {item.attempts}
      </div>
      <details className="queue-tray-item-technical">
        <summary>Technical details</summary>
        <code>
          {item.method} {item.path}
        </code>
      </details>
      {item.lastError ? (
        <div className="queue-tray-item-error">{item.lastError}</div>
      ) : null}
      <div className="queue-tray-item-actions">
        {isConflict ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onResolveConflict}
          >
            Resolve
          </button>
        ) : canRetry ? (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {canEdit ? (
          <button type="button" className="btn btn-sm" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function statusLabel(status: OfflineMutation["status"]): string {
  switch (status) {
    case "pending":
      return "Pending sync";
    case "replaying":
      return "Syncing now";
    case "conflict":
      return "Conflict needs review";
    case "failed":
      return "Retry paused";
    case "dead-letter":
      return "Needs manual action";
  }
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
