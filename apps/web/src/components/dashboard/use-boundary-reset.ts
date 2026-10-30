// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type BoundaryReset = () => void | Promise<void>;

/**
 * Coordinates an App Router error-boundary reset.
 *
 * Next's reset callback is normally synchronous and replaces the boundary.
 * Keeping a synchronous ref in addition to React state closes the small window
 * where two click/keyboard events can land before the disabled state commits.
 * The promise branch also makes the primitive deterministic for boundaries
 * whose recovery work is asynchronous.
 */
export function useBoundaryReset(reset: BoundaryReset) {
  const resetLockRef = useRef(false);
  const mountedRef = useRef(true);
  const [resetting, setResetting] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);

  useEffect(() => {
    // React Strict Mode deliberately replays setup/cleanup in development.
    // Restore the flag during each setup so the second mounted pass remains
    // capable of releasing a failed or completed async retry.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const release = useCallback((failed: boolean) => {
    resetLockRef.current = false;
    if (!mountedRef.current) return;
    setResetting(false);
    setResetFailed(failed);
  }, []);

  const retry = useCallback(() => {
    if (resetLockRef.current) return;

    resetLockRef.current = true;
    setResetFailed(false);
    setResetting(true);

    try {
      const result = reset();
      if (result && typeof result.then === "function") {
        void result.then(
          () => release(false),
          () => release(true),
        );
        return;
      }

      // A successful Next reset normally unmounts this boundary. If it does
      // not, release after the current activation so the user is not trapped.
      queueMicrotask(() => release(false));
    } catch {
      release(true);
    }
  }, [release, reset]);

  return { resetFailed, resetting, retry };
}
