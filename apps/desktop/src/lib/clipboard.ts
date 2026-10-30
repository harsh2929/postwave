/**
 * One privacy-aware clipboard boundary for the renderer.
 *
 * Native desktop builds use Tauri's official clipboard-manager plugin. Web
 * builds use the standards-based Clipboard API. Callers always receive an
 * exhaustive result and must only claim success after `ok === true`.
 *
 * This module deliberately never logs, reports, or embeds clipboard values in
 * errors. Secret auto-clear retains the value only in the timer closure long
 * enough to compare the current clipboard byte-for-byte before clearing it.
 */
import {
  clear as clearNativeClipboard,
  readText as readNativeClipboardText,
  writeText as writeNativeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";

import { isTauri } from "./tauri";

export type ClipboardContentClass = "public" | "personal" | "secret";
export type ClipboardBackend = "native" | "web";
export type ClipboardFailureCategory =
  | "unavailable"
  | "permission_denied"
  | "window_not_focused"
  | "blocked_by_policy"
  | "write_failed";

export const SECRET_CLIPBOARD_HISTORY_WARNING =
  "Clipboard history or another clipboard manager may retain this secret even after Moosewave clears the current clipboard.";

export interface ClipboardWriteOptions {
  /** Explicit data classification; never inferred by inspecting the value. */
  contentClass?: ClipboardContentClass;
  /** Non-sensitive OS clipboard label (for example, “API key”). */
  label?: string;
  /**
   * For sensitive values, re-read after this delay and clear only when the
   * clipboard still contains exactly the copied value. Disabled by default.
   */
  clearIfUnchangedAfterMs?: number;
}

interface ClipboardWriteSuccess {
  ok: true;
  backend: ClipboardBackend;
  contentClass: ClipboardContentClass;
  clearScheduled: boolean;
  clearAfterMs: number | null;
  historyWarning: string | null;
}

interface ClipboardWriteFailure {
  ok: false;
  category: ClipboardFailureCategory;
  message: string;
  retryable: boolean;
}

export type ClipboardWriteResult =
  | ClipboardWriteSuccess
  | ClipboardWriteFailure;

const pendingClearTimers = new Set<number>();

function failure(category: ClipboardFailureCategory): ClipboardWriteFailure {
  switch (category) {
    case "unavailable":
      return {
        ok: false,
        category,
        message:
          "Clipboard access isn't available here. Select the value and copy it manually.",
        retryable: false,
      };
    case "permission_denied":
      return {
        ok: false,
        category,
        message:
          "Clipboard permission was denied. Allow clipboard access or copy the value manually.",
        retryable: true,
      };
    case "window_not_focused":
      return {
        ok: false,
        category,
        message:
          "Moosewave must be the active window to copy. Focus the app and try again.",
        retryable: true,
      };
    case "blocked_by_policy":
      return {
        ok: false,
        category,
        message:
          "Your browser or device policy blocked clipboard access. Copy the value manually.",
        retryable: false,
      };
    case "write_failed":
      return {
        ok: false,
        category,
        message:
          "The value couldn't be copied. Focus Moosewave and try again, or copy it manually.",
        retryable: true,
      };
  }
}

function classifyFailure(error: unknown): ClipboardFailureCategory {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const description =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";

  if (
    name.includes("notallowed") ||
    name.includes("permission") ||
    description.includes("permission denied") ||
    description.includes("not allowed")
  ) {
    return "permission_denied";
  }
  if (
    name.includes("security") ||
    description.includes("insecure") ||
    description.includes("policy") ||
    description.includes("forbidden")
  ) {
    return "blocked_by_policy";
  }
  if (
    description.includes("focus") ||
    description.includes("active document") ||
    description.includes("document is not focused")
  ) {
    return "window_not_focused";
  }
  return "write_failed";
}

async function readCurrentText(backend: ClipboardBackend): Promise<string> {
  if (backend === "native") return readNativeClipboardText();
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.readText !== "function"
  ) {
    throw new Error("clipboard read unavailable");
  }
  return navigator.clipboard.readText();
}

async function clearCurrentClipboard(backend: ClipboardBackend): Promise<void> {
  if (backend === "native") {
    await clearNativeClipboard();
    return;
  }
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.writeText !== "function"
  ) {
    throw new Error("clipboard write unavailable");
  }
  await navigator.clipboard.writeText("");
}

function scheduleClearIfUnchanged(
  copiedValue: string,
  backend: ClipboardBackend,
  afterMs: number,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const timer = window.setTimeout(() => {
      pendingClearTimers.delete(timer);
      readCurrentText(backend)
        .then((current) => {
          if (current !== copiedValue) return undefined;
          return clearCurrentClipboard(backend);
        })
        .catch(() => {
          // Best-effort privacy housekeeping. Failure is intentionally silent:
          // values and platform errors must not enter logs or telemetry.
        });
    }, afterMs);
    pendingClearTimers.add(timer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text through the native or web backend. This function never rejects.
 */
export async function writeClipboardText(
  value: string,
  options: ClipboardWriteOptions = {},
): Promise<ClipboardWriteResult> {
  const contentClass = options.contentClass ?? "public";
  const backend: ClipboardBackend = isTauri() ? "native" : "web";

  try {
    if (backend === "native") {
      await writeNativeClipboardText(
        value,
        options.label ? { label: options.label } : undefined,
      );
    } else {
      if (
        typeof navigator === "undefined" ||
        typeof navigator.clipboard?.writeText !== "function"
      ) {
        return failure("unavailable");
      }
      await navigator.clipboard.writeText(value);
    }
  } catch (error) {
    return failure(classifyFailure(error));
  }

  const requestedDelay = options.clearIfUnchangedAfterMs;
  const clearAfterMs =
    typeof requestedDelay === "number" &&
    Number.isFinite(requestedDelay) &&
    requestedDelay > 0
      ? Math.round(requestedDelay)
      : null;
  const clearScheduled =
    clearAfterMs !== null
      ? scheduleClearIfUnchanged(value, backend, clearAfterMs)
      : false;

  return {
    ok: true,
    backend,
    contentClass,
    clearScheduled,
    clearAfterMs: clearScheduled ? clearAfterMs : null,
    historyWarning:
      contentClass === "secret" ? SECRET_CLIPBOARD_HISTORY_WARNING : null,
  };
}

/** Human-readable live-region text without echoing the copied value. */
export function clipboardAnnouncement(
  result: ClipboardWriteResult,
  label = "Value",
): string {
  if (!result.ok) return `${label} wasn't copied. ${result.message}`;
  const clearing =
    result.clearScheduled && result.clearAfterMs !== null
      ? ` It will be cleared in ${formatDuration(result.clearAfterMs)} if unchanged.`
      : "";
  const warning = result.historyWarning ? ` ${result.historyWarning}` : "";
  return `${label} copied.${clearing}${warning}`;
}

/** Optional second line for toast/inline feedback after a successful copy. */
export function clipboardSuccessDetail(
  result: ClipboardWriteSuccess,
): string | undefined {
  const clearing =
    result.clearScheduled && result.clearAfterMs !== null
      ? `Moosewave will clear the current clipboard in ${formatDuration(result.clearAfterMs)} if it still contains this value.`
      : "";
  return (
    [clearing, result.historyWarning ?? ""].filter(Boolean).join(" ") ||
    undefined
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Test-only lifecycle reset; contains no clipboard values. */
export function resetClipboardTimersForTests(): void {
  for (const timer of pendingClearTimers) window.clearTimeout(timer);
  pendingClearTimers.clear();
}
