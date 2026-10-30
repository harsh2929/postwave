// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * InstallPrompt — Moosewave PWA install UX.
 *
 * Behaviour:
 *   - Captures `beforeinstallprompt` and stashes it; never fires the
 *     native prompt automatically.
 *   - Defers surfacing until the user completes a meaningful action
 *     (sent campaign, added subscriber, saved template) — observed via
 *     window events the rest of the app already dispatches.
 *   - iOS Safari: detects iOS UA + non-standalone display-mode and
 *     shows an Add-to-Home-Screen instructional sheet instead.
 *   - `getInstalledRelatedApps()` suppresses the prompt when the
 *     desktop Tauri app is already installed.
 *   - Honors a 14-day localStorage cool-off after dismiss so we don't
 *     nag.
 *
 * Telemetry: emits `pwa.install.prompt_shown`, `pwa.install.accepted`,
 * `pwa.install.dismissed`, `pwa.install.ios_sheet_shown`.
 */

import { Download, Share2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { track } from "@/lib/telemetry";
import { PWA_INSTALL_TRIGGER_EVENTS } from "@/lib/pwa-install";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

interface RelatedApp {
  platform?: string;
  url?: string;
  id?: string;
}

const DISMISS_KEY = "postwave.pwa.install.dismissed.v1";
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports as Mac; check maxTouchPoints to disambiguate.
  const maybeIPadOS =
    /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return /iPhone|iPad|iPod/.test(ua) || maybeIPadOS;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  // Legacy iOS Safari.
  const navStandalone = (window.navigator as unknown as { standalone?: boolean })
    .standalone;
  return navStandalone === true;
}

function recentlyDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = Number.parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function markDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function InstallPrompt() {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [showIOSSheet, setShowIOSSheet] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const dismissActionRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const meaningfulActionRef = useRef(false);
  const openRef = useRef(false);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) return;
    if (recentlyDismissed()) return;

    let cancelled = false;

    // Suppress when the desktop Tauri app is already installed and
    // discoverable via getInstalledRelatedApps.
    const nav = navigator as Navigator & {
      getInstalledRelatedApps?: () => Promise<RelatedApp[]>;
    };
    if (typeof nav.getInstalledRelatedApps === "function") {
      void nav
        .getInstalledRelatedApps()
        .then((apps) => {
          if (cancelled) return;
          if (Array.isArray(apps) && apps.length > 0) {
            // Companion app installed — never offer the web install.
            promptRef.current = null;
            setReady(false);
          }
        })
        .catch(() => undefined);
    }

    const onBeforeInstall = (event: Event): void => {
      event.preventDefault();
      if (recentlyDismissed()) return;
      promptRef.current = event as BeforeInstallPromptEvent;
      setReady(true);
      // If a meaningful action already fired earlier, surface now.
      if (meaningfulActionRef.current) {
        setOpen(true);
        track("pwa.install.prompt_shown", { trigger: "deferred" });
      }
    };

    const onTrigger = (): void => {
      // This listener intentionally lives for the component lifetime. Recheck
      // the cool-off here so a second meaningful action cannot reopen the iOS
      // sheet immediately after the user chose "Got it".
      if (recentlyDismissed()) return;
      meaningfulActionRef.current = true;
      if (promptRef.current && !openRef.current) {
        setOpen(true);
        track("pwa.install.prompt_shown", { trigger: "meaningful_action" });
      } else if (!promptRef.current && isIOS() && !isStandalone()) {
        // iOS never fires beforeinstallprompt; show the manual sheet.
        setShowIOSSheet(true);
        track("pwa.install.ios_sheet_shown", { trigger: "meaningful_action" });
      }
    };

    const onInstalled = (): void => {
      setOpen(false);
      setReady(false);
      promptRef.current = null;
      track("pwa.install.accepted", { source: "appinstalled" });
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    for (const name of PWA_INSTALL_TRIGGER_EVENTS) {
      window.addEventListener(name, onTrigger);
    }
    return () => {
      cancelled = true;
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      for (const name of PWA_INSTALL_TRIGGER_EVENTS) {
        window.removeEventListener(name, onTrigger);
      }
    };
  }, []);

  const accept = async (): Promise<void> => {
    const prompt = promptRef.current;
    if (!prompt) {
      setOpen(false);
      return;
    }
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      track(
        choice.outcome === "accepted"
          ? "pwa.install.accepted"
          : "pwa.install.dismissed",
        { source: "prompt", platform: choice.platform },
      );
      if (choice.outcome === "dismissed") markDismissed();
    } catch {
      /* user closed the native prompt — treat as dismiss */
      markDismissed();
    } finally {
      promptRef.current = null;
      setReady(false);
      setOpen(false);
    }
  };

  const dismiss = useCallback((): void => {
    markDismissed();
    track("pwa.install.dismissed", { source: "manual" });
    setOpen(false);
    setShowIOSSheet(false);
  }, []);

  const visible = open || showIOSSheet;

  useEffect(() => {
    if (!visible) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const initialFocus =
      primaryActionRef.current ??
      dismissActionRef.current ??
      firstFocusable(dialogRef.current);
    initialFocus?.focus({ preventScroll: true });

    return () => {
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [visible, showIOSSheet]);

  useEffect(() => {
    if (!visible) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key === "Tab") {
        trapFocus(event, dialogRef.current);
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss, visible]);

  if (!visible) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="postwave-install-title"
      aria-describedby="postwave-install-description"
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-foreground/20 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 backdrop-blur-[2px] sm:items-center sm:p-6"
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-2xl shadow-foreground/15">
        <div className="h-1 bg-gradient-to-r from-primary via-warning to-primary" />
        <div className="p-5 sm:p-6">
        {showIOSSheet ? (
          <>
            <div className="flex items-start gap-3">
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
                <Share2 className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                  One-minute setup
                </p>
                <h2
                  id="postwave-install-title"
                  className="mt-1 font-display text-xl font-semibold tracking-tight"
                >
                  Add Moosewave to your Home Screen
                </h2>
                <p
                  id="postwave-install-description"
                  className="mt-1.5 text-sm leading-6 text-muted-foreground"
                >
                  Keep drafts close and launch straight into your workspace.
                </p>
              </div>
            </div>
            <ol className="mt-5 space-y-3 text-sm leading-6">
              <li className="flex gap-3">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  1
                </span>
                <span>
                  Tap <strong>Share</strong> in Safari&rsquo;s toolbar.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  2
                </span>
                <span>
                  Scroll and choose <strong>Add to Home Screen</strong>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  3
                </span>
                <span>
                  Tap <strong>Add</strong>. Moosewave opens full-screen and keeps
                  editorial drafts available offline.
                </span>
              </li>
            </ol>
            <div className="mt-6 flex justify-end">
              <Button
                ref={primaryActionRef}
                type="button"
                onClick={dismiss}
                className="h-11 px-5 sm:h-10"
              >
                Got it
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
                <Download className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                  Your workspace, one click away
                </p>
                <h2
                  id="postwave-install-title"
                  className="mt-1 font-display text-xl font-semibold tracking-tight"
                >
                  Install Moosewave
                </h2>
                <p
                  id="postwave-install-description"
                  className="mt-1.5 text-sm leading-6 text-muted-foreground"
                >
                  Launch faster and keep editorial drafts available when your
                  connection drops.
                </p>
              </div>
            </div>
            <p className="mt-4 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
              <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
              No extra account, download, or setup required.
            </p>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                ref={dismissActionRef}
                type="button"
                variant="ghost"
                onClick={dismiss}
                className="h-11 sm:h-10"
              >
                Not now
              </Button>
              <Button
                ref={primaryActionRef}
                type="button"
                onClick={() => {
                  void accept();
                }}
                disabled={!ready}
                className="h-11 px-5 sm:h-10"
              >
                <Download aria-hidden="true" />
                Install
              </Button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      !element.hidden &&
      element.closest("[hidden]") === null &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getAttribute("tabindex") !== "-1",
  );
}

function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return focusableElements(root)[0] ?? root;
}

function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const focusable = focusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (!(active instanceof HTMLElement) || !root.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  }
}
