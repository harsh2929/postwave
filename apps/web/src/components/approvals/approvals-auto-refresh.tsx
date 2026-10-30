// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Automatic approval-queue refresh (desktop parity:
// pages/approvals/useApprovalsController.ts useAutomaticApprovalRefresh):
// every 60 s, and on window focus, reconnect, and tab-visible — but only while
// the tab is visible and the browser reports itself online. Overlapping
// triggers (focus + visibilitychange fire together) coalesce into one refresh.
// Neither surface has SSE/WebSocket for approvals; this is polling by design.

import { useEffect, useRef } from "react";

export const APPROVALS_REFRESH_INTERVAL_MS = 60_000;

export function useApprovalsAutoRefresh(
  enabled: boolean,
  refresh: () => unknown,
): void {
  const refreshRef = useRef(refresh);
  const inFlightRef = useRef(false);

  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    if (!enabled) return;
    const trigger = (): void => {
      if (document.visibilityState !== "visible") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      void Promise.resolve()
        .then(() => refreshRef.current())
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    const interval = window.setInterval(trigger, APPROVALS_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", trigger);
    window.addEventListener("online", trigger);
    document.addEventListener("visibilitychange", trigger);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", trigger);
      window.removeEventListener("online", trigger);
      document.removeEventListener("visibilitychange", trigger);
    };
  }, [enabled]);
}

/** Drop-in form of the hook, with a one-line note of the cadence. */
export function ApprovalsAutoRefresh({
  enabled,
  onRefresh,
}: {
  enabled: boolean;
  onRefresh: () => unknown;
}) {
  useApprovalsAutoRefresh(enabled, onRefresh);
  if (!enabled) return null;
  return (
    <p className="text-xs text-muted-foreground">
      The queue refreshes every minute while this tab is visible, and again
      when you return to it or reconnect.
    </p>
  );
}
