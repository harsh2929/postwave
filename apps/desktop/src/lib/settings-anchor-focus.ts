import { useEffect } from "react";

import {
  settingsAnchorFromHeading,
  type DesktopRoute,
  type SettingsAnchor,
} from "./desktop-router";

const SETTINGS_HEADING_SELECTOR =
  ".settings-section-title, .settings-section-head .section-title";

export interface SettingsAnchorElements {
  focusOwner: HTMLElement;
  scrollOwner: HTMLElement;
}

/**
 * Reconcile rendered Settings headings with the typed route allowlist and find
 * the exact scroll/focus owners for one anchor. Explicit anchors support the
 * few cards whose user-facing heading intentionally differs from the route
 * label; their real heading remains the focus target.
 */
export function resolveSettingsAnchorElements(
  content: HTMLElement,
  requestedAnchor: SettingsAnchor,
): SettingsAnchorElements | null {
  const headings = Array.from(
    content.querySelectorAll<HTMLElement>(SETTINGS_HEADING_SELECTOR),
  );
  for (const heading of headings) {
    const anchor = settingsAnchorFromHeading(heading.textContent ?? "");
    if (!anchor) continue;
    const section =
      heading.closest<HTMLElement>(".settings-section, section") ?? heading;
    section.dataset.settingsAnchor = anchor;
    section.id ||= `settings-${anchor}`;
    if (anchor === requestedAnchor) {
      return { focusOwner: heading, scrollOwner: section };
    }
  }

  const explicit = content.querySelector<HTMLElement>(
    `[data-settings-anchor="${requestedAnchor}"]`,
  );
  if (!explicit) return null;
  explicit.id ||= `settings-${requestedAnchor}`;
  return {
    focusOwner:
      explicit.querySelector<HTMLElement>(SETTINGS_HEADING_SELECTOR) ??
      explicit,
    scrollOwner: explicit,
  };
}

/** Reveal one already-mounted Settings anchor (including same-route re-entry). */
export function revealSettingsAnchor(
  requestedAnchor: SettingsAnchor,
): number | null {
  const content = document.getElementById("main-content");
  if (!content) return null;
  const elements = resolveSettingsAnchorElements(content, requestedAnchor);
  if (!elements) return null;
  elements.scrollOwner.scrollIntoView({ block: "start" });
  elements.focusOwner.tabIndex = -1;
  return window.requestAnimationFrame(() => {
    if (elements.focusOwner.isConnected) {
      elements.focusOwner.focus({ preventScroll: true });
    }
  });
}

export function useSettingsAnchorFocus(route: DesktopRoute): void {
  useEffect(() => {
    if (route.section !== "settings" || !route.settingsAnchor) return;
    const requestedAnchor = route.settingsAnchor;
    let observer: MutationObserver | null = null;
    let focusFrame: number | null = null;

    const activate = (): boolean => {
      focusFrame = revealSettingsAnchor(requestedAnchor);
      return focusFrame !== null;
    };

    if (!activate()) {
      const content = document.getElementById("main-content");
      if (content) {
        observer = new MutationObserver(() => {
          if (activate()) observer?.disconnect();
        });
        observer.observe(content, { childList: true, subtree: true });
      }
    }
    return () => {
      observer?.disconnect();
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [route.section, route.settingsAnchor]);
}
