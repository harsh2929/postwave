/**
 * useTickingNow — a once-a-second clock that only runs when it is being read.
 *
 * Any "how old is this?" badge needs a re-render to age. The dashboard computed
 * `Date.now()` during render with nothing scheduling one, so its Live badge
 * froze at whatever it said when the screen last rendered — and because polling
 * is suspended while the app is backgrounded, resuming from background painted
 * "Live" beside an hours-old figure until the refetch resolved.
 *
 * The interval is gated twice, because a clock that ticks off-screen is pure
 * battery cost:
 *
 *   - `active` is the caller's focus flag (a tab the user navigated away from
 *     is still mounted under Expo Router);
 *   - AppState pauses it whenever the app leaves the foreground, and ticks once
 *     immediately on return so the first painted frame is already correct.
 *
 * RESOLUTION — the third gate, and the one that decides how many RENDERS the
 * ticking costs. Both gates above ask "should this clock run at all"; neither
 * asks "does a new value change anything on screen". Almost every caller feeds
 * `now` into `relativeTime`, whose finest unit is the MINUTE ("just now",
 * "3m ago", "2h ago") — so 59 of every 60 ticks re-render a whole screen to
 * paint a string that is byte-for-byte identical. Measured on this hook alone:
 * 60 renders per focused minute, of which 1 can change a pixel.
 *
 * `resolutionMs` floors the clock to a bucket and, crucially, SUPPRESSES THE
 * STATE UPDATE while the bucket is unchanged, so the consumer does not render
 * at all. Pass `MINUTE_MS` wherever the screen only renders minute-or-coarser
 * labels; the cost is that a boundary lands on the wall-clock minute rather
 * than exactly 60s after the event, so DO NOT pass it where a sub-minute
 * threshold is load-bearing (the dashboard's 90-second "Live" badge, the audit
 * sink's `<1m` cooldown countdown, an approval's expiry — which gates whether
 * the Approve button is offered at all).
 *
 * The default is 1ms, i.e. every tick is its own bucket: unchanged behaviour
 * and unchanged render count for callers that do not opt in.
 */
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

const TICK_MS = 1000;

/** Resolution for callers whose finest rendered unit is a minute. */
export const MINUTE_MS = 60_000;

function floorTo(value: number, resolutionMs: number): number {
  return resolutionMs > 1
    ? Math.floor(value / resolutionMs) * resolutionMs
    : value;
}

export function useTickingNow(
  active: boolean,
  resolutionMs: number = 1,
): number {
  const [now, setNow] = useState(() => floorTo(Date.now(), resolutionMs));
  /**
   * The value last PUBLISHED, so an unchanged bucket never reaches setState at
   * all. Returning the previous value from a state updater would also let
   * React bail — but only on its second pass, so each boundary still cost two
   * renders instead of one. `setNow` is the only writer, so the mirror cannot
   * drift.
   */
  const publishedRef = useRef(now);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      const next = floorTo(Date.now(), resolutionMs);
      if (next === publishedRef.current) return;
      publishedRef.current = next;
      setNow(next);
    };
    const start = () => {
      if (!timer) timer = setInterval(tick, TICK_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    tick();
    if (AppState.currentState === "active") start();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        tick();
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, [active, resolutionMs]);

  return now;
}
