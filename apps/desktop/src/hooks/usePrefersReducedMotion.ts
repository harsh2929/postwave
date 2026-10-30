import { useEffect, useState } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const QUERY = REDUCED_MOTION_QUERY;

/**
 * One-shot read for code that runs outside render -- scroll handlers deciding
 * `behavior: "auto" | "smooth"`, effects that fire once. Same source as the
 * hook, so a component never re-declares the media query; three of them had,
 * each with its own inline `window.matchMedia(...)`, which is exactly how the
 * hook stops being the source. SSR/JSDOM-safe: no matchMedia means no
 * preference, not a crash.
 */
export function prefersReducedMotionNow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(QUERY).matches
  );
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(QUERY);
    const update = (): void => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reduced;
}
