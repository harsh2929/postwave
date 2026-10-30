// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Back-to-top control for very long marketing pages (MKTC-017). Appears after
 * the visitor scrolls past a threshold and returns them to the top. Respects
 * reduced-motion (no smooth scroll animation when the user opts out).
 */
export function BackToTop({ threshold = 1200 }: { threshold?: number }): JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setVisible(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  if (!visible) return null;

  const toTop = (): void => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      aria-label="Back to top"
      // Stacked above the persistent bottom-right tour launcher so the two
      // controls don't overlap.
      className="fixed bottom-16 right-4 z-40 inline-flex h-11 w-11 items-center justify-center rounded-full border border-pw-surface bg-pw-paper text-pw-ink2 shadow-lg transition-colors hover:bg-pw-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
    >
      <ArrowUp aria-hidden className="h-4 w-4" />
    </button>
  );
}
