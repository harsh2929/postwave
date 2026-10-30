import type { SubscriberImportPreview } from "../../lib/api-client";
import type { ApiResult } from "../../lib/api/result";

const DEFAULT_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
const STALLED_AFTER_FAILURES = 3;

export interface ImportPollingIssue {
  kind: "offline" | "retrying" | "stalled" | "attention";
  message: string;
  retryDelayMs?: number;
}

interface ImportPollingHost {
  document: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  navigator: Pick<Navigator, "onLine">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  setTimeout: typeof window.setTimeout;
  clearTimeout: typeof window.clearTimeout;
}

export interface ImportPollingLifecycleOptions {
  fetchImport: (
    importId: string,
    signal: AbortSignal,
  ) => Promise<ApiResult<SubscriberImportPreview>>;
  onData: (preview: SubscriberImportPreview) => void;
  onTerminal: (preview: SubscriberImportPreview) => void;
  onIssue: (issue: ImportPollingIssue | null) => void;
  host?: ImportPollingHost;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ImportPollingLifecycle {
  start: (importId: string) => void;
  stop: () => void;
  retryNow: () => void;
  isRunning: () => boolean;
}

function defaultHost(): ImportPollingHost {
  return {
    document,
    navigator,
    window,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  };
}

function isTerminal(status: unknown): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

function isTransientFailure(
  result: Extract<ApiResult<unknown>, { error: unknown }>,
): boolean {
  if (result.retryability === "not-retryable") return false;
  const status = result.error.status;
  if (status == null) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function boundedRetryDelay(
  failures: number,
  retryAfterSeconds: number | undefined,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.min(maxDelayMs, Math.max(0, retryAfterSeconds * 1_000));
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failures - 1));
}

/**
 * A single-flight, visibility- and connectivity-aware import status poller.
 * The next timer is scheduled only after the current request settles, so a
 * slow response can never overlap another GET. Late results are discarded by
 * a generation token when the import identity changes or the owner unmounts.
 */
export function createImportPollingLifecycle({
  fetchImport,
  onData,
  onTerminal,
  onIssue,
  host = defaultHost(),
  baseDelayMs = DEFAULT_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
}: ImportPollingLifecycleOptions): ImportPollingLifecycle {
  let active = false;
  let importId: string | null = null;
  let generation = 0;
  let timer: number | null = null;
  let requestInFlight = false;
  let failures = 0;
  let listenersAttached = false;
  let nextDelayMs: number | null = null;
  let requestController: AbortController | null = null;

  const runnable = (): boolean =>
    host.document.visibilityState !== "hidden" &&
    host.navigator.onLine !== false;

  const clearTimer = (): void => {
    if (timer == null) return;
    host.clearTimeout(timer);
    timer = null;
  };

  const abortRequest = (): void => {
    requestController?.abort();
    requestController = null;
  };

  const schedule = (delayMs: number): void => {
    clearTimer();
    if (!active || importId == null || !runnable() || requestInFlight) return;
    const owner = generation;
    timer = host.setTimeout(
      () => {
        timer = null;
        void poll(owner);
      },
      Math.max(0, delayMs),
    );
  };

  const reportFailure = (
    transient: boolean,
    retryAfterSeconds?: number,
  ): void => {
    failures += 1;
    if (!transient) {
      nextDelayMs = null;
      onIssue({
        kind: "attention",
        message:
          "Live progress needs attention. Retry now, or close this window; the server-side import is not cancelled.",
      });
      return;
    }
    const retryDelayMs = boundedRetryDelay(
      failures,
      retryAfterSeconds,
      baseDelayMs,
      maxDelayMs,
    );
    nextDelayMs = retryDelayMs;
    const stalled = failures >= STALLED_AFTER_FAILURES;
    onIssue({
      kind: stalled ? "stalled" : "retrying",
      message: stalled
        ? "Live progress appears stalled. Moosewave is still retrying safely; no duplicate status requests are running."
        : "Live progress was interrupted. Moosewave will retry automatically.",
      retryDelayMs,
    });
  };

  async function poll(owner: number): Promise<void> {
    if (
      !active ||
      importId == null ||
      owner !== generation ||
      requestInFlight ||
      !runnable()
    ) {
      return;
    }
    requestInFlight = true;
    nextDelayMs = null;
    const requestedId = importId;
    const controller = new AbortController();
    requestController = controller;
    try {
      const result = await fetchImport(requestedId, controller.signal);
      if (!active || owner !== generation || importId !== requestedId) return;
      if (result.error) {
        reportFailure(
          isTransientFailure(result),
          result.error.retryAfterSeconds,
        );
        if (host.navigator.onLine === false) onOffline();
        return;
      }
      failures = 0;
      nextDelayMs = baseDelayMs;
      if (host.navigator.onLine !== false) onIssue(null);
      onData(result.data);
      if (isTerminal(result.data.status)) {
        active = false;
        clearTimer();
        detachListeners();
        onTerminal(result.data);
        return;
      }
    } catch {
      if (
        controller.signal.aborted ||
        !active ||
        owner !== generation ||
        importId !== requestedId ||
        !runnable()
      ) {
        return;
      }
      reportFailure(true);
    } finally {
      if (requestController === controller) requestController = null;
      requestInFlight = false;
      if (owner !== generation) {
        // A new import may have taken ownership while the previous GET was
        // settling. Start it now, without ever overlapping the old request.
        if (active && importId != null && runnable()) schedule(0);
      } else if (
        // Re-arm only after settlement. This is the single-flight guarantee:
        // there is no interval capable of firing while a GET remains unresolved.
        active &&
        importId === requestedId &&
        timer == null &&
        runnable() &&
        nextDelayMs != null
      ) {
        schedule(nextDelayMs);
      }
    }
  }

  const resume = (): void => {
    if (!active || importId == null || !runnable()) return;
    onIssue(null);
    if (requestInFlight) {
      nextDelayMs = 0;
      return;
    }
    schedule(0);
  };

  const onVisibilityChange = (): void => {
    if (host.document.visibilityState === "hidden") {
      clearTimer();
      abortRequest();
      return;
    }
    resume();
  };

  const onOffline = (): void => {
    clearTimer();
    abortRequest();
    if (active) {
      onIssue({
        kind: "offline",
        message:
          "Live progress is paused while this device is offline. It will resume after reconnection; the server-side import continues.",
      });
    }
  };

  const attachListeners = (): void => {
    if (listenersAttached) return;
    host.document.addEventListener("visibilitychange", onVisibilityChange);
    host.window.addEventListener("online", resume);
    host.window.addEventListener("offline", onOffline);
    listenersAttached = true;
  };

  function detachListeners(): void {
    if (!listenersAttached) return;
    host.document.removeEventListener("visibilitychange", onVisibilityChange);
    host.window.removeEventListener("online", resume);
    host.window.removeEventListener("offline", onOffline);
    listenersAttached = false;
  }

  const stop = (): void => {
    active = false;
    importId = null;
    generation += 1;
    failures = 0;
    nextDelayMs = null;
    clearTimer();
    abortRequest();
    detachListeners();
    onIssue(null);
  };

  return {
    start(nextImportId) {
      stop();
      active = true;
      importId = nextImportId;
      generation += 1;
      attachListeners();
      if (host.navigator.onLine === false) {
        onOffline();
      } else if (host.document.visibilityState !== "hidden") {
        schedule(0);
      }
    },
    stop,
    retryNow() {
      if (!active || importId == null) return;
      failures = 0;
      if (host.navigator.onLine === false) {
        onOffline();
        return;
      }
      if (host.document.visibilityState === "hidden") return;
      onIssue(null);
      if (requestInFlight) {
        nextDelayMs = 0;
        return;
      }
      schedule(0);
    },
    isRunning: () => active,
  };
}
