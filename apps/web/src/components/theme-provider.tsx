// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useLayoutEffect, type ComponentProps } from "react";

/**
 * Dashboard theme boundary. next-themes toggles the `dark` class on <html>,
 * which flips the ink-warm/ember `.dark` token block in globals.css.
 *
 * The provider is intentionally scoped to the dashboard: marketing, docs and
 * auth are fixed-light surfaces. A class on <html> outlives the subtree that
 * set it, though, so a client navigation out of a dark dashboard used to leave
 * the destination painted with dashboard tokens. Layout-effect cleanup runs
 * during the unmount commit, before the fixed-light destination is painted.
 * Native-control color-scheme is owned by globals.css so it follows the same
 * class instead of a second next-themes inline style.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  useLayoutEffect(
    () => () => {
      const root = document.documentElement;
      root.classList.remove("dark");
      // Clear an inline value left by an older mounted provider; globals.css is
      // the single authority for native form-control/browser color-scheme.
      root.style.removeProperty("color-scheme");
    },
    [],
  );

  return (
    <NextThemesProvider {...props} enableColorScheme={false}>
      {children}
    </NextThemesProvider>
  );
}
