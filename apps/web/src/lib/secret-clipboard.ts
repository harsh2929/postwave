// SPDX-License-Identifier: AGPL-3.0-only
//
// Clipboard copy for show-once secrets (desktop parity: lib/clipboard.ts
// `clearIfUnchangedAfterMs`). After the delay the clipboard is cleared ONLY
// if it still holds the copied value, so a later copy by the user is never
// wiped. The timer is module-scoped on purpose: dismissing the reveal panel
// right after copying must not cancel the clean-up. Every write goes through
// lib/clipboard.ts, and the clean-up's outcome is handed back to the caller
// so a failed clear can be shown instead of silently leaving the secret in
// place. The copied value itself is never logged or reported.

import { copyToClipboard, type ClipboardResult } from "@/lib/clipboard";

export const SECRET_CLIPBOARD_CLEAR_MS = 60_000;

/** "changed": the user copied something else, so nothing was cleared. */
export type SecretClearOutcome = "cleared" | "changed" | "failed";

export type SecretCopyResult =
  | { status: "copied"; clearScheduled: boolean; clearAfterMs: number }
  | { status: Exclude<ClipboardResult, "copied"> };

export interface SecretCopyOptions {
  afterMs?: number;
  /** Called once when the scheduled clean-up has run. */
  onClearOutcome?: (outcome: SecretClearOutcome) => void;
}

const pendingClears = new Set<ReturnType<typeof setTimeout>>();

function canVerifyClipboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.readText === "function"
  );
}

async function clearIfUnchanged(copied: string): Promise<SecretClearOutcome> {
  let current: string;
  try {
    current = await navigator.clipboard.readText();
  } catch {
    return "failed";
  }
  if (current !== copied) return "changed";
  const result = await copyToClipboard("");
  return result === "copied" ? "cleared" : "failed";
}

/**
 * Copies a secret and, where the browser can read the clipboard back,
 * schedules a clear-if-unchanged after `afterMs`. Never throws.
 */
export async function copySecretWithAutoClear(
  value: string,
  options: SecretCopyOptions = {},
): Promise<SecretCopyResult> {
  const afterMs = options.afterMs ?? SECRET_CLIPBOARD_CLEAR_MS;
  const result = await copyToClipboard(value);
  if (result !== "copied") return { status: result };
  const clearScheduled = canVerifyClipboard();
  if (clearScheduled) {
    const timer = setTimeout(() => {
      pendingClears.delete(timer);
      void clearIfUnchanged(value).then((outcome) =>
        options.onClearOutcome?.(outcome),
      );
    }, afterMs);
    pendingClears.add(timer);
  }
  return { status: "copied", clearScheduled, clearAfterMs: afterMs };
}

/** Test-only lifecycle reset; holds no clipboard values. */
export function cancelPendingSecretClipboardClears(): void {
  for (const timer of pendingClears) clearTimeout(timer);
  pendingClears.clear();
}
