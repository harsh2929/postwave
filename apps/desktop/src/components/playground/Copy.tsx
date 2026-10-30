/**
 * CopyButton — small icon button that copies its `value` to the
 * clipboard + flashes "Copied!" for 1.4s. Used across the playground
 * (response body, request URL, code snippets, header values).
 *
 * Keeps routine success cheap with a label swap. Failures and secret-history
 * warnings use the shared toast live region because icon-only controls cannot
 * communicate those states reliably on their own.
 *
 * Clipboard failures are reflected in both the visible label and a polite
 * live region. The shared service chooses the native Tauri or web backend.
 */

import { type ReactElement } from "react";

import { useClipboardCopy } from "../../hooks/useClipboardCopy";
import {
  clipboardSuccessDetail,
  type ClipboardContentClass,
} from "../../lib/clipboard";
import { toast } from "../Toast";

interface CopyProps {
  value: string;
  label?: string;
  /** Optional aria-label override; defaults to `Copy ${label}`. */
  ariaLabel?: string;
  /** Render the button compactly (icon-only). */
  compact?: boolean;
  /** Explicit classification for history warning/cleanup behavior. */
  contentClass?: ClipboardContentClass;
  /** Clear this value later only if it is still the current clipboard value. */
  clearIfUnchangedAfterMs?: number;
}

export function CopyButton({
  value,
  label = "Copy",
  ariaLabel,
  compact = false,
  contentClass = "public",
  clearIfUnchangedAfterMs,
}: CopyProps): ReactElement {
  const { copied, status, announcement, liveRegionProps, copy } =
    useClipboardCopy(1400);

  const onCopy = async (): Promise<void> => {
    const result = await copy(
      value,
      { contentClass, label, clearIfUnchangedAfterMs },
      label,
    );
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    if (result.historyWarning) {
      toast.success({
        message: `${label} copied`,
        detail: clipboardSuccessDetail(result),
      });
    }
  };

  return (
    <>
      <button
        type="button"
        className={`play-copy-btn${copied ? " is-copied" : ""}`}
        onClick={() => {
          onCopy().catch(() =>
            toast.error("The value couldn't be copied. Try again."),
          );
        }}
        aria-label={
          status === "failed"
            ? `${ariaLabel ?? `Copy ${label}`} — copy failed`
            : (ariaLabel ?? `Copy ${label}`)
        }
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
        {compact ? null : (
          <span className="play-copy-label">
            {copied ? "Copied" : status === "failed" ? "Copy failed" : label}
          </span>
        )}
      </button>
      <span
        {...liveRegionProps}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {announcement}
      </span>
    </>
  );
}

function ClipboardIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="3" rx="1" />
      <path d="M9 4.5H6a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-3" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
