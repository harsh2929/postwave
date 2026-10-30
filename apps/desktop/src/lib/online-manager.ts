/**
 * onlineManager — unified online/connecting/offline signal.
 *
 * Single source of truth combining three inputs:
 *   1. window online/offline DOM events.
 *   2. Periodic /api/health heartbeat (30s visible / 120s hidden).
 *   3. Last-10s observed real-request success/failure (reported by
 *      api-client callers via noteRequestSuccess / noteRequestFailure).
 *
 * The status is also mirrored into the existing store conn slice via
 * setConn(), so legacy useConn() consumers (and any code that watches
 * the dot color) stay in sync without a parallel subscription.
 *
 * Heartbeat probes use the shared httpFetch core with timeoutMs:3000
 * and maxAttempts:1 so they never piggyback on user-facing retry
 * budgets; a single failed probe followed by a navigator.onLine flip
 * is enough to declare offline.
 */

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

import { getApiUrl } from "./api-client";
import { httpFetch } from "./http-fetch";
import { setConn } from "./store";
import { isTauri } from "./tauri";

export type OnlineStatus = "online" | "connecting" | "offline";
export type ConnectivityReason =
  | "online"
  | "connecting"
  | "no-interface"
  | "internet-unavailable"
  | "api-unavailable"
  | "maintenance"
  | "authentication"
  | "captive-portal"
  | "proxy-tls";

export interface ConnectivitySnapshot {
  status: OnlineStatus;
  reason: ConnectivityReason;
  checkedAt: number;
}

const HEARTBEAT_VISIBLE_MS = 30_000;
const HEARTBEAT_HIDDEN_MS = 120_000;
const REAL_REQUEST_WINDOW_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;

let status: OnlineStatus = "connecting";
let reason: ConnectivityReason = "connecting";
let checkedAt = Date.now();
let connectivitySnapshot: ConnectivitySnapshot = {
  status,
  reason,
  checkedAt,
};
const listeners = new Set<() => void>();
let recentFailureAt = 0;
let recentSuccessAt = 0;
let probePromise: Promise<ProbeResult> | null = null;
let started = false;
let timerId: number | null = null;

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[online-manager] listener threw");
    }
  }
}

function setStatus(
  next: OnlineStatus,
  nextReason: ConnectivityReason = next === "online"
    ? "online"
    : next === "connecting"
      ? "connecting"
      : "api-unavailable",
): void {
  if (status === next && reason === nextReason) return;
  const statusChanged = status !== next;
  status = next;
  reason = nextReason;
  checkedAt = Date.now();
  connectivitySnapshot = { status, reason, checkedAt };
  if (statusChanged) setConn(next);
  emit();
}

/** Public read accessor — for non-React callers (event-bus, queue). */
export function getOnlineStatus(): OnlineStatus {
  return status;
}

export function getConnectivitySnapshot(): ConnectivitySnapshot {
  return connectivitySnapshot;
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

interface ProbeResult {
  ok: boolean;
  reason: ConnectivityReason;
}

function probe(): Promise<ProbeResult> {
  // Coalesce concurrent probes onto the SAME in-flight request. A
  // refresh() that races an ongoing probe awaits the real result
  // instead of guessing from the current status — previously a refresh
  // during "connecting" would read `status === "online"` (false) and
  // flip us to "offline" without any probe evidence.
  if (probePromise) return probePromise;
  const p = (async (): Promise<ProbeResult> => {
    try {
      const url = `${getApiUrl().replace(/\/+$/, "")}/api/health`;
      const result = await httpFetch(
        url,
        { method: "GET" },
        { timeoutMs: PROBE_TIMEOUT_MS, maxAttempts: 1 },
      );
      if (result.res?.ok) return { ok: true, reason: "online" };
      return {
        ok: false,
        reason: classifyConnectivityFailure(
          result.res,
          result.err,
          browserOnline(),
        ),
      };
    } catch (error) {
      return {
        ok: false,
        reason: classifyConnectivityFailure(undefined, error, browserOnline()),
      };
    } finally {
      probePromise = null;
    }
  })();
  probePromise = p;
  return p;
}

async function refresh(transitionToConnecting = true): Promise<void> {
  if (!browserOnline()) {
    setStatus("offline", "no-interface");
    return;
  }
  // If a real request has succeeded within the last window, trust it
  // and skip the probe entirely — eliminates dual traffic on busy UIs.
  if (Date.now() - recentSuccessAt < REAL_REQUEST_WINDOW_MS) {
    setStatus("online");
    return;
  }
  if (transitionToConnecting && status !== "online") {
    setStatus("connecting");
  }
  const result = await probe();
  setStatus(result.ok ? "online" : "offline", result.reason);
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
    // Visible tab: if a recent real request succeeded, skip the probe.
    if (Date.now() - recentSuccessAt < REAL_REQUEST_WINDOW_MS) return;
    void refresh(false);
  }, interval);
}

/**
 * Report-back hook for the api-client. A successful HTTP response is strong
 * evidence only while the OS still reports an available interface; otherwise
 * it may be a late settlement from a request started before disconnection.
 */
export function noteRequestSuccess(): void {
  recentSuccessAt = Date.now();
  // A response that was already in flight can settle after the operating
  // system has reported that the network interface is gone. The interface
  // signal is authoritative in that race: treating the late response as a
  // reconnect would hide the offline banner and resume work that cannot be
  // delivered. A real reconnect emits `online`, which performs a fresh probe.
  if (!browserOnline()) {
    setStatus("offline", "no-interface");
    return;
  }
  if (status !== "online" || reason !== "online") setStatus("online", "online");
}

/**
 * Counterpart for transport-level failures. A single failed request
 * doesn't tip us to offline (could be a 503 on one endpoint while the
 * API is otherwise fine); instead, we record it and fire a probe to
 * confirm. Multiple failures in the 10s window count as evidence.
 */
export function noteRequestFailure(): void {
  recentFailureAt = Date.now();
  if (status === "online") setStatus("connecting", "connecting");
  void refresh(false);
}

/**
 * Boot the manager — idempotent. Wires window online/offline events,
 * visibility-change re-schedule, and the initial probe.
 */
export function startOnlineManager(): () => void {
  if (started) return () => undefined;
  started = true;

  const onOnline = (): void => {
    // navigator.onLine flipped true — don't trust it blindly. Transition
    // to 'connecting' and probe once before declaring online; prevents
    // the dot from going green during a single DNS hiccup recovery.
    setStatus("connecting", "connecting");
    void refresh(false);
  };
  const onOffline = (): void => {
    // Browser says offline — trust it; probe is futile.
    setStatus("offline", "no-interface");
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

  const disposeTauri = bridgeTauriOnlineSignals();

  return () => {
    started = false;
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
    disposeTauri();
  };
}

/** React hook — subscribe to the unified online status. */
export function useOnline(): OnlineStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => status,
    () => status,
  );
}

/** Rich connectivity reason for trust-sensitive offline/recovery copy. */
export function useConnectivity(): ConnectivitySnapshot {
  return useSyncExternalStore(
    subscribeOnlineStatus,
    getConnectivitySnapshot,
    getConnectivitySnapshot,
  );
}

/**
 * Public single-shot probe — fires one /api/health request immediately
 * and updates status. Used by the Tauri tauri://focus listener so
 * macOS sleep/resume catches a fresh signal without waiting for the
 * 30s heartbeat interval. Safe to call from anywhere; the in-flight
 * guard inside `probe()` prevents stampedes.
 */
export async function probeOnline(): Promise<void> {
  await refresh(false);
}

/**
 * Wire Tauri-side net:state and tauri://focus events into the manager.
 * Gated on isTauri() so non-Tauri test runs never register native listeners.
 * `App.tsx` already uses both the Tauri detector and event module on the
 * desktop critical path, so dynamically importing them here did not create a
 * lazy chunk; it only added an asynchronous hop and emitted Rolldown's
 * INEFFECTIVE_DYNAMIC_IMPORT warning. The bridge is idempotent and the
 * returned disposer cleans both listeners.
 */
export function bridgeTauriOnlineSignals(): () => void {
  let disposed = false;
  const disposers: Array<() => void> = [];

  void (async () => {
    if (!isTauri()) return;
    if (disposed) return;

    // net:state — { state: "online" | "offline" | "probe" }. Rust side
    // emits "probe" on window focus today; the long-running watcher
    // (v2) will start emitting concrete online/offline transitions.
    try {
      const un = await listen<{ state: string }>("net:state", (event) => {
        const next = event.payload?.state;
        if (next === "online") setStatus("online", "online");
        else if (next === "offline") setStatus("offline", "no-interface");
        else void refresh(false);
      });
      if (disposed) un();
      else disposers.push(un);
    } catch {
      /* ignore — listener registration is best-effort */
    }

    // tauri://focus — fires when the window regains focus (incl.
    // post-sleep). Single heartbeat with maxAttempts:1 baked into
    // probe() above; no retry budget so it never blocks startup.
    try {
      const un = await listen("tauri://focus", () => {
        void refresh(false);
      });
      if (disposed) un();
      else disposers.push(un);
    } catch {
      /* ignore */
    }
  })();

  return () => {
    disposed = true;
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  };
}

export function classifyConnectivityFailure(
  response: Response | undefined,
  error: unknown,
  hasInterface: boolean,
): ConnectivityReason {
  if (!hasInterface) return "no-interface";
  if (response) {
    if (response.status === 401 || response.status === 403) {
      return "authentication";
    }
    if (
      response.status === 503 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-postwave-maintenance") === "true")
    ) {
      return "maintenance";
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      response.redirected ||
      (contentType.includes("text/html") && response.status >= 200)
    ) {
      return "captive-portal";
    }
    return "api-unavailable";
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/certificate|\btls\b|ssl|proxy|self[- ]signed/i.test(message)) {
    return "proxy-tls";
  }
  if (/network|dns|fetch|timed?\s*out|timeout|connect/i.test(message)) {
    return "internet-unavailable";
  }
  return "api-unavailable";
}

/** Test/debug helper — read recent activity timestamps. */
export function _debugTimestamps(): {
  recentSuccessAt: number;
  recentFailureAt: number;
} {
  return { recentSuccessAt, recentFailureAt };
}
