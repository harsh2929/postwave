// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

import { Toaster } from "@/components/ui/sonner";

// Keep the renderer in the root client bundle. Sonner publishes to current
// subscribers, so a dynamically imported Toaster can lose the first toast when
// a hydrated control responds before that extra chunk has mounted (especially
// on a cold connection). The small bundle saving is not worth making critical
// success and failure feedback timing-dependent.

/**
 * Drives the Sonner Toaster's `theme` prop from the resolved app theme so the
 * toast chrome (close button, fallback surface/border vars) matches light/dark
 * instead of being permanently light (SHELL-016).
 *
 * The Toaster is mounted in the root layout, OUTSIDE the dashboard's
 * next-themes provider, so `useTheme()` context isn't reachable here. Both the
 * pre-paint THEME_SCRIPT and next-themes converge on the same signal — the
 * `dark` class on <html> — so we observe that directly. Starts "light" to
 * match SSR (the dashboard is the only surface that flips to dark), then
 * updates after mount: hydration-safe.
 */
export function ThemedToaster() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const root = document.documentElement;
    const sync = (): void =>
      setTheme(root.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return <Toaster theme={theme} />;
}
