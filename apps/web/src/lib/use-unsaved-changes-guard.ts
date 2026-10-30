// SPDX-License-Identifier: AGPL-3.0-only
//
// `useUnsavedChangesGuard(dirty)` protects browser unloads and App Router
// navigation. Next's client-side links and router.push do not emit
// `beforeunload`, so the hook also owns a cancellable navigation event,
// capture-phase anchor interception, and browser history restoration.
//
// Audit (Week N+) finding: the email editor had unbounded data loss —
// closing a tab silently discarded an in-progress newsletter. This hook
// is the cheapest mitigation; full autosave + version history are
// follow-ups but this single line of defense is what most editors
// (Notion, Substack, Mailchimp) ship as their first guard.

import { useEffect } from "react";

const BEFORE_NAVIGATION_EVENT = "postwave:before-navigation";
const CONFIRM_MESSAGE = "You have unsaved changes. Leave this page?";

/**
 * Ask every mounted unsaved-changes guard whether an in-app navigation may
 * proceed. Programmatic callers (command palette, tours) must call this
 * before router.push/replace; ordinary links are handled by the hook itself.
 */
export function canNavigateWithUnsavedChanges(): boolean {
  if (typeof window === "undefined") return true;
  return window.dispatchEvent(
    new Event(BEFORE_NAVIGATION_EVENT, { cancelable: true }),
  );
}

function internalAnchorFromClick(event: MouseEvent): HTMLAnchorElement | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;

  const destination = new URL(anchor.href, window.location.href);
  if (destination.origin !== window.location.origin) return null;
  if (destination.href === window.location.href) return null;
  return anchor;
}

export function useUnsavedChangesGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Modern browsers ignore the returned string and show a generic
      // prompt. preventDefault() + setting returnValue is the spec'd
      // way to opt in; we keep both for max-compat with older Safari.
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    const handleNavigationRequest = (event: Event) => {
      if (!window.confirm(CONFIRM_MESSAGE)) event.preventDefault();
    };
    const handleClick = (event: MouseEvent) => {
      if (!internalAnchorFromClick(event)) return;
      if (canNavigateWithUnsavedChanges()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    let restoringHistory = false;
    const handlePopState = (event: PopStateEvent) => {
      if (restoringHistory) {
        restoringHistory = false;
        return;
      }
      if (canNavigateWithUnsavedChanges()) return;
      // popstate fires after the history cursor moves. Move it forward again
      // synchronously; Next's scheduled route update is then superseded by
      // the restored entry and the editor remains mounted.
      event.stopImmediatePropagation();
      restoringHistory = true;
      window.history.forward();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener(BEFORE_NAVIGATION_EVENT, handleNavigationRequest);
    document.addEventListener("click", handleClick, true);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener(
        BEFORE_NAVIGATION_EVENT,
        handleNavigationRequest,
      );
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [dirty]);
}
