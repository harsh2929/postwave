/**
 * useResendCooldown — a live countdown for "Resend link" style controls.
 *
 * The arithmetic lives in `src/lib/cooldown.ts` (absolute deadline, so a
 * backgrounded app cannot stall the timer) and is tested there; this hook is
 * only the ticking and the teardown.
 *
 * `start()` takes an optional seconds argument so a 429 can seed the countdown
 * straight from the server's `Retry-After` instead of the self-imposed
 * default — the button then re-arms exactly when the server will accept it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cooldownRemaining,
  DEFAULT_RESEND_COOLDOWN_SECONDS,
  NO_COOLDOWN,
  startCooldown,
  type CooldownState,
} from "@/lib/cooldown";

export interface ResendCooldown {
  /** Whole seconds left; 0 when the action is available. */
  seconds: number;
  /** Arm the cooldown. Defaults to the self-imposed 30s gap. */
  start: (seconds?: number) => void;
  /** Disarm immediately (e.g. the user switched sign-in method). */
  reset: () => void;
}

export function useResendCooldown(): ResendCooldown {
  const [state, setState] = useState<CooldownState>(NO_COOLDOWN);
  const [seconds, setSeconds] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setSeconds(cooldownRemaining(state));
    if (!state.readyAt) return;
    timer.current = setInterval(() => {
      const remaining = cooldownRemaining(state);
      setSeconds(remaining);
      if (remaining <= 0 && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    }, 1000);
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [state]);

  const start = useCallback((next?: number) => {
    setState(startCooldown(next ?? DEFAULT_RESEND_COOLDOWN_SECONDS));
  }, []);

  const reset = useCallback(() => {
    setState(NO_COOLDOWN);
    setSeconds(0);
  }, []);

  return { seconds, start, reset };
}
