/**
 * useNowTicker — a clock that actually ticks, for freshness labels.
 *
 * `formatAge(...)` read `Date.now()` inside a `useMemo` whose deps were the
 * data, so a "last received 5m ago" label FROZE the moment the screen mounted.
 * On a phone, screens stay mounted across backgrounding and app-switching for
 * a long time, so a screen left open for an hour still claimed "5m ago" — the
 * exact opposite of the pipeline-liveness signal the label exists to give.
 *
 * Pass the returned value to `relativeTime(value, { now })` (src/lib/format.ts
 * already accepts a `now` option for precisely this) and include it in any
 * memo that renders a freshness string.
 */
import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** One minute is the finest granularity `relativeTime` renders. */
const DEFAULT_INTERVAL_MS = 60_000;

export function useNowTicker(intervalMs: number = DEFAULT_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const period = Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_INTERVAL_MS;
    const timer = setInterval(() => setNow(Date.now()), period);
    // Timers are throttled or suspended in the background, so a screen
    // returning to the foreground would otherwise show whatever the clock read
    // when the app was backgrounded. Resync on the transition.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [intervalMs]);

  return now;
}
