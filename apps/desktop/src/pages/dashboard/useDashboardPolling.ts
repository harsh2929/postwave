import { type MutableRefObject, useEffect } from "react";

import { type SseStatus } from "../../lib/sse";

export const DASHBOARD_POLL_INTERVAL_MS = 5_000;
export const DASHBOARD_CAMPAIGN_POLL_INTERVAL_MS = 30_000;
const DASHBOARD_LIVE_SAFETY_POLL_INTERVAL_MS = 60_000;

/**
 * Keep the selected reporting window current without spending work while the
 * app cannot present it. The caller only passes `open` for the one range the
 * stream actually represents (30d); every other range therefore keeps the
 * five-second HTTP cadence.
 */
export function useDashboardPolling(
  enabled: boolean,
  liveStatus: SseStatus,
  refreshRef: MutableRefObject<() => Promise<void>>,
  markUnavailableRef: MutableRefObject<() => void>,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const intervalMs =
      liveStatus === "open"
        ? DASHBOARD_LIVE_SAFETY_POLL_INTERVAL_MS
        : DASHBOARD_POLL_INTERVAL_MS;
    let timer: number | null = null;
    const hasNetworkInterface = (): boolean =>
      typeof navigator === "undefined" || navigator.onLine !== false;
    const stop = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const start = (): void => {
      if (timer !== null || document.hidden || !hasNetworkInterface()) return;
      timer = window.setInterval(() => {
        if (!document.hidden && hasNetworkInterface()) {
          void refreshRef.current();
        }
      }, intervalMs);
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        stop();
      } else {
        if (hasNetworkInterface()) void refreshRef.current();
        start();
      }
    };
    const onOffline = (): void => {
      stop();
      markUnavailableRef.current();
    };
    const onOnline = (): void => {
      if (document.hidden || timer !== null) return;
      void refreshRef.current();
      start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, liveStatus, markUnavailableRef, refreshRef]);
}

/**
 * Campaign status drives the global "currently sending" strip, so it needs a
 * bounded cadence of its own. Unlike the stats poll this never fires on mount
 * (the controller's initial load already covers that branch), but it does
 * verify immediately when a hidden/offline app becomes presentable again.
 */
export function useDashboardCampaignPolling(
  enabled: boolean,
  refreshRef: MutableRefObject<() => Promise<void>>,
  markUnavailableRef: MutableRefObject<() => void>,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: number | null = null;
    const hasNetworkInterface = (): boolean =>
      typeof navigator === "undefined" || navigator.onLine !== false;
    const stop = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const start = (): void => {
      if (timer !== null || document.hidden || !hasNetworkInterface()) return;
      timer = window.setInterval(() => {
        if (!document.hidden && hasNetworkInterface()) {
          void refreshRef.current();
        }
      }, DASHBOARD_CAMPAIGN_POLL_INTERVAL_MS);
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        stop();
        markUnavailableRef.current();
        return;
      }
      if (hasNetworkInterface()) void refreshRef.current();
      start();
    };
    const onOffline = (): void => {
      stop();
      markUnavailableRef.current();
    };
    const onOnline = (): void => {
      if (document.hidden || timer !== null) return;
      void refreshRef.current();
      start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, markUnavailableRef, refreshRef]);
}
