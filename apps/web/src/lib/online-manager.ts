// SPDX-License-Identifier: AGPL-3.0-only

/**
 * onlineManager — unified online/connecting/offline signal for the
 * Next.js app. Mirrors the desktop module but uses the web app's
 * fetch base URL and the apps/web httpFetch core.
 *
 * Inputs combined:
 *   1. window online/offline DOM events.
 *   2. Periodic /api/health heartbeat (30s visible / 120s hidden).
 *   3. Last-10s observed real-request success/failure, recorded by
 *      api.ts when a request resolves or throws.
 *
 * Recovery. "offline" pauses every TanStack query (the bridge maps it to
 * setOnline(false)), so the way back must be quick. A failed request probes
 * /api/health; one failed probe is only "connecting" — a blip, and the bridge
 * keeps queries running — and a second consecutive failure is "offline".
 * While not online the manager re-probes on a short backoff (1s, 2s, 4s, 8s,
 * 16s, then every 30s) rather than waiting for the next heartbeat: a lost
 * connection that never changes navigator.onLine fires no DOM `online` event,
 * and the heartbeat alone left pages on their skeletons for up to 30 seconds
 * after the network had come back.
 *
 * Consumed by PwaRegistrar (queue replay trigger + status toast) and
 * any future status chip. SSR-safe — all DOM hooks are gated.
 */

import { httpFetch } from "./http-fetch";

export type OnlineStatus = "online" | "connecting" | "offline";

const HEARTBEAT_VISIBLE_MS = 30_000;
const HEARTBEAT_HIDDEN_MS = 120_000;
const REAL_REQUEST_WINDOW_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
/** Consecutive failed health probes before the app is declared offline. */
const OFFLINE_AFTER_FAILED_PROBES = 2;
/** Delay before each re-probe while not online; the last entry repeats. */
const RECOVERY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

const API_ORIGIN =
  typeof window === "undefined"
    ? process.env.API_URL || process.env.POSTWAVE_API_URL || ""
    : "";

/**
 * The status the server renders with.
 *
 * Nothing starts the heartbeat during SSR, so every server render sees the seed
 * value. `useSyncExternalStore` needs this as its getServerSnapshot: the
 * hydration pass must reproduce the HTML the server sent, then update to the
 * live value on the next render. Reading the live status during hydration
 * instead is what made /app report a mismatch on the LayoutCustomizer trigger,
 * which the server had rendered disabled ("Connect to the internet to customize
 * this layout") and the browser re-rendered enabled.
 */
export const SSR_ONLINE_STATUS: OnlineStatus = "connecting";

let status: OnlineStatus = SSR_ONLINE_STATUS;
const listeners = new Set<() => void>();
let recentSuccessAt = 0;
let recentFailureAt = 0;
let consecutiveProbeFailures = 0;
let settlingProbe: Promise<void> | null = null;
let started = false;
let timerId: number | null = null;
let recoveryTimerId: number | null = null;

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn("[online-manager] listener threw:", err);
    }
  }
}

function setStatus(next: OnlineStatus): void {
  if (status === next) return;
  status = next;
  emit();
}

export function getOnlineStatus(): OnlineStatus {
  return status;
}

/**
 * Snapshot for server rendering and for the hydration pass. Deliberately
 * constant — see {@link SSR_ONLINE_STATUS}.
 */
export function getServerOnlineStatus(): OnlineStatus {
  return SSR_ONLINE_STATUS;
}

/** Test-only: drive the live status without waiting on a heartbeat. */
export function setOnlineStatusForTest(next: OnlineStatus): void {
  setStatus(next);
}

/**
 * Non-React subscription primitive — used by TanStack Query's
 * onlineManager.setEventListener bridge in lib/query-client.ts so
 * paused queries resume on the unified Moosewave signal (not just
 * navigator.onLine). Returns an unsubscribe function.
 */
export function subscribeOnlineStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function browserOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

function healthUrl(): string {
  const base = (API_ORIGIN || "").replace(/\/+$/, "");
  return `${base}/api/health`;
}

async function probe(): Promise<boolean> {
  try {
    const result = await httpFetch(
      healthUrl(),
      { method: "GET", credentials: "include" },
      { timeoutMs: PROBE_TIMEOUT_MS, maxAttempts: 1 },
    );
    return !!(result.res && result.res.ok);
  } catch {
    return false;
  }
}

/** A real request has succeeded since the last one failed, recently. */
function recentlyReachable(): boolean {
  return (
    recentSuccessAt >= recentFailureAt &&
    Date.now() - recentSuccessAt < REAL_REQUEST_WINDOW_MS
  );
}

function cancelRecovery(): void {
  if (recoveryTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(recoveryTimerId);
  }
  recoveryTimerId = null;
}

function markReachable(): void {
  consecutiveProbeFailures = 0;
  cancelRecovery();
  setStatus("online");
}

function scheduleRecovery(): void {
  if (typeof window === "undefined") return;
  cancelRecovery();
  const step = Math.min(
    Math.max(consecutiveProbeFailures, 1) - 1,
    RECOVERY_BACKOFF_MS.length - 1,
  );
  recoveryTimerId = window.setTimeout(() => {
    recoveryTimerId = null;
    void refresh(false);
  }, RECOVERY_BACKOFF_MS[step]);
}

/**
 * Probe /api/health once and settle the status from the answer. Concurrent
 * callers — a burst of failing queries each reporting in — share the probe in
 * flight, so one outage counts as one failure and nobody guesses at the
 * answer while it is pending.
 */
function probeAndSettle(): Promise<void> {
  if (settlingProbe) return settlingProbe;
  const startedAt = Date.now();
  settlingProbe = probe()
    .then((ok) => {
      if (ok || recentSuccessAt > startedAt) {
        // A real request that succeeded while the probe was out is as good
        // an answer as the probe.
        markReachable();
        return;
      }
      if (!browserOnline()) {
        cancelRecovery();
        setStatus("offline");
        return;
      }
      consecutiveProbeFailures += 1;
      setStatus(
        consecutiveProbeFailures >= OFFLINE_AFTER_FAILED_PROBES
          ? "offline"
          : "connecting",
      );
      scheduleRecovery();
    })
    .finally(() => {
      settlingProbe = null;
    });
  return settlingProbe;
}

async function refresh(transitionToConnecting = true): Promise<void> {
  if (!browserOnline()) {
    // Nothing to probe until the browser reports a connection; its `online`
    // event restarts recovery.
    cancelRecovery();
    setStatus("offline");
    return;
  }
  if (recentlyReachable()) {
    markReachable();
    return;
  }
  if (transitionToConnecting && status !== "online") {
    setStatus("connecting");
  }
  await probeAndSettle();
}

function scheduleHeartbeat(): void {
  if (typeof window === "undefined") return;
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  const hidden = typeof document !== "undefined" && document.hidden;
  const interval = hidden ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_VISIBLE_MS;
  timerId = window.setInterval(() => {
    if (hidden) {
      void refresh(false);
      return;
    }
    if (Date.now() - recentSuccessAt < REAL_REQUEST_WINDOW_MS) return;
    void refresh(false);
  }, interval);
}

export function noteRequestSuccess(): void {
  recentSuccessAt = Date.now();
  markReachable();
}

export function noteRequestFailure(): void {
  recentFailureAt = Date.now();
  if (status === "online") setStatus("connecting");
  void refresh(false);
}

export function startOnlineManager(): () => void {
  if (started) return () => undefined;
  started = true;

  const onOnline = (): void => {
    setStatus("connecting");
    void refresh(false);
  };
  const onOffline = (): void => {
    cancelRecovery();
    setStatus("offline");
  };
  const onVisibility = (): void => {
    scheduleHeartbeat();
    if (typeof document !== "undefined" && !document.hidden) {
      void refresh(false);
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  void refresh(true);
  scheduleHeartbeat();

  return () => {
    started = false;
    cancelRecovery();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

export function _debugTimestamps(): {
  recentSuccessAt: number;
  recentFailureAt: number;
} {
  return { recentSuccessAt, recentFailureAt };
}
