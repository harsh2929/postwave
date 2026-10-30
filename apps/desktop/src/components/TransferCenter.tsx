import {
  type ReactElement,
  type SVGProps,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useDialogStack } from "../hooks/useDialogStack";
import { popDialog, pushDialog } from "../lib/dialogStack";
import {
  clearFinishedTransferHistory,
  getTransferHistory,
  runTransferAction,
  subscribeTransferHistory,
  transferActionsFor,
} from "../lib/file-transfer-history";
import type { TransferRecord } from "../lib/file-transfer-types";
import "../styles-transfer-center.css";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

const iconProps: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

const transferTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function TransferIcon(): ReactElement {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function TransferCenter({
  open,
  onToggle,
  onClose,
}: Props): ReactElement {
  const history = useSyncExternalStore(
    subscribeTransferHistory,
    getTransferHistory,
    getTransferHistory,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const closeRequestedRef = useRef(false);
  const panelId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);
  const requestClose = useCallback(
    (restoreFocus: boolean): void => {
      if (closeRequestedRef.current) return;
      closeRequestedRef.current = true;
      onClose();
      if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
    },
    [onClose],
  );
  const activeCount = history.filter(isActive).length;
  const statusText =
    activeCount > 0
      ? `${activeCount} active file transfer${activeCount === 1 ? "" : "s"}`
      : history.length > 0
        ? "File transfers"
        : "No file transfers yet";

  useEffect(() => {
    if (!open) return;
    closeRequestedRef.current = false;
    pushDialog(dialogId);
    return () => popDialog(dialogId);
  }, [dialogId, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (!isTop) return;
        event.preventDefault();
        requestClose(true);
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        requestClose(false);
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      requestClose(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [isTop, open, requestClose]);

  return (
    <div className="topbar-notif-wrap transfer-center-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="topbar-iconbtn"
        aria-label={statusText}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          if (open) closeRequestedRef.current = true;
          onToggle();
        }}
      >
        <TransferIcon />
        {activeCount > 0 ? (
          <span className="transfer-center-count" aria-hidden="true">
            {Math.min(activeCount, 9)}
          </span>
        ) : null}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {activeCount > 0 ? statusText : ""}
      </span>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="transfer-center-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        >
          <div className="transfer-center-header">
            <div>
              <strong id={titleId}>File transfers</strong>
              <div id={descriptionId} className="muted small">
                Paths and private file names are never retained.
              </div>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => requestClose(true)}
              aria-label="Close file transfers"
            >
              Close
            </button>
          </div>

          {history.length === 0 ? (
            <div className="transfer-center-empty">
              Imports, uploads and saved exports will appear here.
            </div>
          ) : (
            <div className="transfer-center-list" role="list">
              {history.map((record) => (
                <TransferRow key={record.id} record={record} />
              ))}
            </div>
          )}

          {history.some((record) => !isActive(record)) ? (
            <div className="transfer-center-footer">
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={clearFinishedTransferHistory}
              >
                Clear finished
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TransferRow({ record }: { record: TransferRecord }): ReactElement {
  const actionNames = transferActionsFor(record.id);
  const [pendingAction, setPendingAction] = useState<TransferActionName | null>(
    null,
  );
  const [actionFeedback, setActionFeedback] = useState("");
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const feedbackId = useId();
  const progress = useMemo(() => {
    if (!record.totalBytes || record.totalBytes <= 0) return null;
    return Math.min(
      100,
      Math.round((record.bytesTransferred / record.totalBytes) * 100),
    );
  }, [record.bytesTransferred, record.totalBytes]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      pendingRef.current = false;
    };
  }, []);

  const runAction = (action: TransferActionName): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const generation = ++generationRef.current;
    setPendingAction(action);
    setActionFeedback(`${pendingActionLabel(action)}…`);
    void Promise.resolve()
      .then(() => runTransferAction(record.id, action))
      .then((handled) => {
        if (!handled) throw new Error("transfer_action_unavailable");
        if (!mountedRef.current || generation !== generationRef.current) return;
        setActionFeedback(actionSuccessLabel(action));
      })
      .catch(() => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setActionFeedback(
          `${actionButtonLabel(action)} could not be completed. Review the transfer status and try again.`,
        );
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        pendingRef.current = false;
        if (mountedRef.current) setPendingAction(null);
      });
  };

  return (
    <div className="transfer-center-row" role="listitem">
      <div className="transfer-center-row-head">
        <span
          className={`transfer-center-status is-${record.status}`}
          aria-hidden="true"
        />
        <div className="transfer-center-row-copy">
          <strong>{record.label}</strong>
          <span>{record.fileName}</span>
        </div>
        <time
          className="muted small"
          dateTime={new Date(record.updatedAt).toISOString()}
        >
          {relativeTime(record.updatedAt)} ·{" "}
          {transferTimeFormatter.format(new Date(record.updatedAt))}
        </time>
      </div>
      <div className="transfer-center-meta">
        <span>{statusLabel(record)}</span>
        {record.totalBytes !== null ? (
          <span>{formatBytes(record.totalBytes)}</span>
        ) : null}
        {record.collision ? <span>Replaced existing file</span> : null}
      </div>
      {isActive(record) ? (
        <progress
          value={progress ?? undefined}
          max={100}
          aria-label={`${record.label} progress`}
          aria-valuetext={progress === null ? "In progress" : `${progress}%`}
        />
      ) : null}
      {actionNames.length > 0 ? (
        <div
          className="transfer-center-actions"
          aria-busy={pendingAction !== null}
        >
          {actionNames.map((action) => (
            <button
              key={action}
              type="button"
              className="btn btn-xs btn-ghost"
              disabled={pendingAction !== null}
              aria-describedby={feedbackId}
              onClick={() => runAction(action)}
            >
              {pendingAction === action
                ? `${pendingActionLabel(action)}…`
                : actionButtonLabel(action)}
            </button>
          ))}
        </div>
      ) : null}
      <span
        id={feedbackId}
        className="transfer-center-action-feedback"
        role="status"
        aria-live="polite"
      >
        {actionFeedback}
      </span>
    </div>
  );
}

type TransferActionName = "cancel" | "retry" | "reveal";

function actionButtonLabel(action: TransferActionName): string {
  if (action === "cancel") return "Cancel";
  if (action === "retry") return "Retry";
  return "Show in folder";
}

function pendingActionLabel(action: TransferActionName): string {
  if (action === "cancel") return "Cancelling";
  if (action === "retry") return "Retrying";
  return "Opening folder";
}

function actionSuccessLabel(action: TransferActionName): string {
  if (action === "cancel") return "Cancellation requested.";
  if (action === "retry") return "Retry started.";
  return "Folder opened.";
}

function isActive(record: TransferRecord): boolean {
  return ["picking", "reading", "downloading", "saving", "uploading"].includes(
    record.status,
  );
}

function statusLabel(record: TransferRecord): string {
  if (record.status === "failed")
    return `Failed${record.errorCode ? ` · ${record.errorCode.replaceAll("_", " ")}` : ""}`;
  const labels: Record<TransferRecord["status"], string> = {
    picking: "Choosing file",
    reading: "Reading",
    downloading: "Downloading",
    saving: "Saving",
    uploading: "Uploading",
    completed: "Completed",
    delegated: "Opened in browser",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[record.status];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
