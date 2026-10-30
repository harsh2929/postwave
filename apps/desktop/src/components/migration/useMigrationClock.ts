import { useEffect, useState } from "react";

/**
 * Shared route-local wall clock for relative evidence and expiring actions.
 * Thirty seconds is precise enough for operator copy without rerendering on
 * every animation frame; visibility resumes with an immediate correction.
 */
export function useMigrationClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = (): void => setNow(Date.now());
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") update();
    };
    const timer = window.setInterval(update, intervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return now;
}
