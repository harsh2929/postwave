// SPDX-License-Identifier: AGPL-3.0-only
//
// Migration progress streaming + cancellation. SSE first, polling fallback.

import { api, isApiError } from "./api";
import { whenStreamsMayOpen } from "./realtime/stream-gate";
import { parseJsonStreamPayload } from "./stream-payload";

export type MigrationResource =
  | "subscribers"
  | "segments"
  | "automations"
  | "archive"
  | "paid_subs"
  | "templates"
  | "source_archive"
  | "all";

export interface MigrationStreamProgress {
  resource: MigrationResource;
  completed: number;
  total: number;
  current_step: string;
  snapshot: {
    subscribers_total: number;
    subscribers_done: number;
    segments_total: number;
    segments_done: number;
    automations_total: number;
    automations_done: number;
    paid_subs_total: number;
    paid_subs_done: number;
    archive_total: number;
    archive_done: number;
    templates_total?: number;
    templates_done?: number;
    source_archive_total?: number;
    source_archive_done?: number;
  };
  at: string;
}

export interface MigrationStreamResourceCounts {
  imported: number;
  skipped: number;
  failed: number;
  review?: number;
}

export interface MigrationStreamDone {
  status: string;
  resources: Record<string, MigrationStreamResourceCounts>;
  job: unknown;
  error?: string;
}

export interface MigrationStreamHandlers {
  onSnapshot?: (job: unknown) => void;
  onProgress?: (evt: MigrationStreamProgress) => void;
  onDone?: (evt: MigrationStreamDone) => void;
  onError?: (err: { message: string }) => void;
  onStatus?: (
    status: "connecting" | "open" | "reconnecting" | "closed" | "polling",
  ) => void;
}

export function subscribeMigrationEvents(
  jobId: string,
  handlers: MigrationStreamHandlers,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const path = `/api/v1/migrations/${encodeURIComponent(jobId)}/events`;
  let es: EventSource | null = null;
  let stopped = false;
  let backoffMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollController: AbortController | null = null;
  let sseClosedAt: number | null = null;
  let usingPolling = false;

  const setStatus = (
    status: "connecting" | "open" | "reconnecting" | "closed" | "polling",
  ): void => {
    handlers.onStatus?.(status);
  };

  const cleanupES = (): void => {
    if (!es) return;
    es.onopen = null;
    es.onerror = null;
    es.close();
    es = null;
  };

  const startPolling = (): void => {
    if (stopped || usingPolling) return;
    usingPolling = true;
    setStatus("polling");
    const pollPath = `/api/v1/migrations/${encodeURIComponent(jobId)}`;
    let consecutiveFailures = 0;
    let successfulPolls = 0;
    let nextPollDelay = 2000;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      const controller = new AbortController();
      pollController = controller;
      try {
        const job = (await api.get<unknown>(pollPath, {
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
        })) as {
          status?: string;
          error?: string;
          progress?: MigrationStreamProgress["snapshot"];
        };
        if (stopped || controller.signal.aborted) return;
        consecutiveFailures = 0;
        successfulPolls += 1;
        nextPollDelay = 2000;
        handlers.onSnapshot?.(job);
        if (
          job.status === "completed" ||
          job.status === "failed" ||
          job.status === "rolled_back"
        ) {
          handlers.onDone?.({
            status: job.status,
            resources: {},
            job,
            ...(job.error ? { error: job.error } : {}),
          });
          stopped = true;
          setStatus("closed");
          return;
        }
        // Periodically retry the richer SSE stream while polling remains the
        // reliable fallback. If it fails again, onerror returns here.
        if (successfulPolls >= 15) {
          usingPolling = false;
          sseClosedAt = null;
          successfulPolls = 0;
          open();
          return;
        }
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        const status = isApiError(err) ? err.status : 0;
        const nonRetryable = status >= 400 && status < 500;
        consecutiveFailures += 1;
        const message = err instanceof Error ? err.message : "Polling failed";
        if (nonRetryable) {
          stopped = true;
          handlers.onError?.({
            message,
          });
          setStatus("closed");
          return;
        }
        handlers.onError?.({ message });
        nextPollDelay = Math.min(
          30_000,
          2_000 * 2 ** Math.min(consecutiveFailures, 4),
        );
      } finally {
        if (pollController === controller) pollController = null;
      }
      if (!stopped) {
        pollTimer = setTimeout(() => void tick(), nextPollDelay);
      }
    };
    void tick();
  };

  function open(): void {
    if (stopped) return;
    setStatus(backoffMs === 1000 ? "connecting" : "reconnecting");
    try {
      es = new EventSource(path, { withCredentials: true });
    } catch {
      startPolling();
      return;
    }

    es.onopen = (): void => {
      if (stopped) return;
      backoffMs = 1000;
      sseClosedAt = null;
      usingPolling = false;
      setStatus("open");
    };

    es.addEventListener("snapshot", (ev: MessageEvent<string>) => {
      if (stopped) return;
      const parsed = parseJsonStreamPayload<unknown>(ev.data);
      if (parsed.ok) handlers.onSnapshot?.(parsed.value);
      else handlers.onError?.({ message: parsed.message });
    });

    es.addEventListener("progress", (ev: MessageEvent<string>) => {
      if (stopped) return;
      const parsed = parseJsonStreamPayload<MigrationStreamProgress>(ev.data);
      if (parsed.ok) handlers.onProgress?.(parsed.value);
      else handlers.onError?.({ message: parsed.message });
    });

    es.addEventListener("done", (ev: MessageEvent<string>) => {
      if (stopped) return;
      const parsed = parseJsonStreamPayload<MigrationStreamDone>(ev.data);
      if (parsed.ok) handlers.onDone?.(parsed.value);
      else handlers.onError?.({ message: parsed.message });
      cleanupES();
      stopped = true;
      setStatus("closed");
    });

    es.onerror = (): void => {
      if (stopped) return;
      handlers.onError?.({ message: "Stream connection error" });
      cleanupES();
      sseClosedAt = sseClosedAt ?? Date.now();
      if (Date.now() - sseClosedAt > 6000) {
        startPolling();
        return;
      }
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30_000);
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, wait);
    };
  }

  // The first open waits for the page to finish loading and go idle once; see
  // realtime/stream-gate.ts. Retries and the polling fallback below are
  // untouched — only the initial high-priority connection is deferred.
  const cancelPendingOpen = whenStreamsMayOpen(open);

  return (): void => {
    stopped = true;
    cancelPendingOpen();
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearTimeout(pollTimer);
    pollController?.abort();
    pollController = null;
    cleanupES();
    setStatus("closed");
  };
}

export function cancelMigrationJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<{
  job_id: string;
  cancelled: boolean;
  status: string;
  progress?: MigrationStreamProgress["snapshot"];
  rollback_available?: boolean;
  rollback_until?: string | null;
}> {
  return api.delete<{
    job_id: string;
    cancelled: boolean;
    status: string;
    progress?: MigrationStreamProgress["snapshot"];
    rollback_available?: boolean;
    rollback_until?: string | null;
  }>(`/api/v1/migrations/${encodeURIComponent(jobId)}`, {
    signal,
    requireOnline: true,
    maxAttempts: 1,
  });
}
