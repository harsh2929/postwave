// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helper backing clipboard-copy controls (e.g.
// components/copy-entity-link.tsx). Kept free of JSX so it can be unit-tested
// under the node-only vitest environment (the test stubs `navigator` inline).
//
// Two failure modes that callers must be able to *show* the user:
//   - "unavailable": the Clipboard API isn't present at all (non-secure
//      context, older browser, SSR). Callers should reflect this as a
//      disabled / fallback affordance rather than a button that silently
//      does nothing when clicked.
//   - "error": the API exists but the write was rejected (permission denied,
//      document not focused, transient failure). Callers must surface this so
//      a rejected write is visible — not swallowed.

/** Whether the async Clipboard write API is usable in this environment. */
export function isClipboardAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  );
}

export type ClipboardResult = "copied" | "unavailable" | "error";

/**
 * Copy `text` to the clipboard, guarding the `navigator.clipboard` existence
 * the way the rest of the app does (see settings/api + settings/webhooks).
 *
 * Never throws: returns a discriminated result so callers can render a
 * success *and* a failure state instead of swallowing a rejected write.
 */
export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  if (!isClipboardAvailable()) return "unavailable";
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "error";
  }
}
