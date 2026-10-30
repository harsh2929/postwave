/**
 * LibraryUploadTray — pinned bottom-right tray of in-flight + failed uploads.
 *
 * Rows are owned by the page; this component is pure presentation.
 * Status semantics:
 *   uploading → progress bar animates 0→100%
 *   done      → row auto-fades after onAutoDismiss is invoked (page does the timer)
 *   failed    → row persists with a Retry button until user dismisses
 *
 * Tray hides itself when entries.length === 0.
 */

import { type ReactElement, useId } from "react";

import { fmtBytes } from "../../lib/library-filters";

export interface UploadEntry {
  id: string;
  filename: string;
  bytes: number;
  status: "queued" | "uploading" | "done" | "failed";
  /** Internal phase marker only; this is not byte-accurate progress. */
  progress: number;
  thumbDataUrl?: string;
  errorMessage?: string;
  /**
   * Source File kept on failed/uploading entries so the parent's
   * Retry handler can replay the upload without asking the operator
   * to re-pick the file. Not rendered by the tray.
   */
  file?: File;
}

interface Props {
  entries: UploadEntry[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  onClearAll: () => void;
}

export function LibraryUploadTray({
  entries,
  onRetry,
  onDismiss,
  onClearAll,
}: Props): ReactElement | null {
  const titleId = useId();
  if (entries.length === 0) return null;
  const active = entries.filter((e) => e.status === "uploading").length;
  const queued = entries.filter((e) => e.status === "queued").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const complete = entries.filter((e) => e.status === "done").length;
  const clearable = entries.length - active - queued;
  const liveSummary = [
    active ? `${active} active` : "",
    queued ? `${queued} queued` : "",
    complete ? `${complete} complete` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <section className="lib-upload-tray" aria-labelledby={titleId}>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        Uploads: {liveSummary}.
      </span>
      <div className="lib-upload-tray-header">
        <span id={titleId}>
          {active > 0
            ? `${active} uploading${queued > 0 ? ` · ${queued} queued` : ""}…`
            : queued > 0
              ? `${queued} upload${queued === 1 ? "" : "s"} queued`
              : "Uploads"}
        </span>
        <button
          type="button"
          className="btn"
          style={{ padding: "2px 8px", fontSize: 11 }}
          onClick={onClearAll}
          aria-label="Dismiss finished and failed uploads"
          disabled={clearable === 0}
        >
          Clear finished
        </button>
      </div>
      {entries.map((e) => {
        const cls = ["lib-upload-row"];
        if (e.status === "failed") cls.push("is-failed");
        const phase =
          e.status === "queued"
            ? "Queued"
            : e.status === "uploading"
              ? e.progress < 0.5
                ? "Preparing"
                : "Uploading"
              : e.status === "done"
                ? "Complete"
                : "Failed";
        const gifPreview =
          e.file?.type.toLowerCase() === "image/gif" ||
          /\.gif$/i.test(e.filename);
        return (
          <div key={e.id} className={cls.join(" ")}>
            {gifPreview ? (
              <div
                className="lib-upload-thumb lib-upload-gif-paused"
                aria-hidden="true"
              >
                <span aria-hidden="true">GIF</span>
              </div>
            ) : e.thumbDataUrl ? (
              <img
                src={e.thumbDataUrl}
                alt=""
                className="lib-upload-thumb"
                onError={(ev) => {
                  (ev.currentTarget as HTMLImageElement).style.visibility =
                    "hidden";
                }}
              />
            ) : (
              <div className="lib-upload-thumb" />
            )}
            <div className="lib-upload-info">
              <span className="lib-upload-name">{e.filename}</span>
              <span className="lib-upload-status">
                {e.status === "queued"
                  ? `Queued · ${fmtBytes(e.bytes)}`
                  : e.status === "uploading"
                    ? `${phase} · ${fmtBytes(e.bytes)}`
                    : e.status === "done"
                      ? `Uploaded · ${fmtBytes(e.bytes)}`
                      : e.errorMessage || "Failed"}
              </span>
              {e.status === "uploading" ? (
                <div
                  className="lib-upload-progress is-indeterminate"
                  role="progressbar"
                  aria-label={`Upload progress for ${e.filename}`}
                  aria-valuetext={phase}
                >
                  <span />
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {e.status === "failed" ? (
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={() => onRetry(e.id)}
                  aria-label={`Retry upload of ${e.filename}`}
                >
                  Retry
                </button>
              ) : null}
              {e.status !== "uploading" && e.status !== "queued" ? (
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={() => onDismiss(e.id)}
                  aria-label={`Dismiss upload of ${e.filename}`}
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
