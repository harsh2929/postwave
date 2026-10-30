// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared focus-trap primitives. Extracted from queue-tray.tsx so every modal
// surface in the shell (offline queue, mobile nav drawer, header menus) traps
// Tab identically instead of hand-rolling three subtly-different copies.
// Pure + dependency-free so the wrap math is unit-testable.

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** All tabbable descendants of `root`, filtered to genuinely focusable nodes. */
export function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      !element.hidden &&
      element.closest("[hidden]") === null &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getAttribute("tabindex") !== "-1",
  );
}

/** The first tabbable descendant of `root`, or `root` itself as a fallback. */
export function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return focusableElements(root)[0] ?? root;
}

/**
 * Cycle Tab / Shift-Tab focus within `root`. Call from a keydown handler when
 * `event.key === "Tab"`; it preventDefaults and wraps at the edges so focus
 * never escapes the trapped surface.
 */
export function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const focusable = focusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;

  if (!(active instanceof HTMLElement) || !root.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
    return;
  }

  const index = focusable.indexOf(active);
  if (index === -1) {
    // Inside the trap but not itself tabbable — the container that dialogs
    // focus on open (tabindex="-1", which focusableElements filters out, and
    // which firstFocusable returns as its fallback) is the common case.
    // Without this branch none of the edge checks below match, nothing calls
    // preventDefault, and the browser's default Tab walks out of the trap.
    // Resolve by document position so natural tab order is preserved.
    const follows = (el: HTMLElement): boolean =>
      (active.compareDocumentPosition(el) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0;
    event.preventDefault();
    const target = event.shiftKey
      ? ([...focusable].reverse().find((el) => !follows(el)) ?? last)
      : (focusable.find(follows) ?? first);
    target.focus({ preventScroll: true });
    return;
  }

  if (!event.shiftKey && index === focusable.length - 1) {
    event.preventDefault();
    first.focus({ preventScroll: true });
    return;
  }
  if (event.shiftKey && index === 0) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  }
}
