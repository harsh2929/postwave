import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { celebrate } from "../Celebrate";
import { toast } from "../Toast";
import {
  parseSubscriberImportClosedEvent,
  parseSubscriberImportHeartbeatEvent,
  parseSubscriberImportProgressEvent,
  type SubscriberImportDryRunResults,
  type SubscriberImportPreview,
  type SubscriberImportProgressEvent,
} from "../../lib/api/subscriber-import-contract";
import { api } from "../../lib/api-client";
import type { ApiErr } from "../../lib/api/result";
import {
  type ImportPollingIssue,
  type ImportPollingLifecycle,
  createImportPollingLifecycle,
} from "./import-polling";

interface ImportExecutionOptions {
  preview: SubscriberImportPreview | null;
  cancelling: boolean;
  onCompleted: () => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setPolling: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPreview: Dispatch<SetStateAction<SubscriberImportPreview | null>>;
  setCancelling: Dispatch<SetStateAction<boolean>>;
  setPreflight: Dispatch<
    SetStateAction<SubscriberImportDryRunResults | null>
  >;
}

interface OperationOwner {
  importId: string;
  token: symbol;
}

type ImportAction = "preflight" | "queue";

const REVIEW_REQUIRED_CODES = new Set([
  "preflight_required",
  "preflight_expired",
  "preflight_stale",
  "preflight_has_conflicts",
  "source_fingerprint_mismatch",
  "invalid_consent_contract",
  "invalid_mapping_geometry",
  "invalid_mapping_header",
  "invalid_mapping_index",
  "duplicate_mapping_index",
  "duplicate_mapping_targets",
]);

function isTerminal(
  status: unknown,
): status is "ready" | "failed" | "cancelled" {
  return status === "ready" || status === "failed" || status === "cancelled";
}

function statusCanAdvance(
  previous: SubscriberImportPreview["status"],
  next: SubscriberImportPreview["status"],
): boolean {
  if (isTerminal(previous)) return false;
  if (previous === "running" && next === "queued") return false;
  if (previous === "preview") return next === "preview" || next === "queued";
  return next !== "preview";
}

/**
 * Accept a stream update only when it belongs to the frozen import and every
 * counter/status transition is monotonic. A stale replica or malformed SSE
 * frame can therefore never move the operator's progress backwards or turn a
 * terminal job live again.
 */
export function mergeSubscriberImportProgress(
  previous: SubscriberImportPreview,
  progress: SubscriberImportProgressEvent,
): SubscriberImportPreview | null {
  if (!progress || !statusCanAdvance(previous.status, progress.status)) return null;
  const expectedTotal = previous.rows_total;
  if (
    typeof expectedTotal !== "number" ||
    progress.total_rows !== expectedTotal ||
    progress.processed_rows < (previous.processed_rows ?? 0) ||
    progress.rows_imported < (previous.rows_imported ?? 0) ||
    progress.rows_skipped < (previous.rows_skipped ?? 0) ||
    progress.rows_failed < (previous.rows_failed ?? 0)
  ) {
    return null;
  }
  const settled =
    progress.rows_imported + progress.rows_skipped + progress.rows_failed;
  if (
    progress.status === "ready" &&
    (progress.processed_rows !== expectedTotal || settled !== expectedTotal)
  ) {
    return null;
  }
  return {
    ...previous,
    status: progress.status,
    processed_rows: progress.processed_rows,
    rows_total: progress.total_rows,
    rows_imported: progress.rows_imported,
    rows_skipped: progress.rows_skipped,
    rows_failed: progress.rows_failed,
  };
}

export function mergeSubscriberImportPoll(
  previous: SubscriberImportPreview,
  next: SubscriberImportPreview,
): SubscriberImportPreview | null {
  if (
    previous.id !== next.id ||
    !statusCanAdvance(previous.status, next.status) ||
    next.rows_total !== previous.rows_total ||
    next.configuration_revision !== previous.configuration_revision ||
    (next.processed_rows ?? 0) < (previous.processed_rows ?? 0) ||
    (next.rows_imported ?? 0) < (previous.rows_imported ?? 0) ||
    (next.rows_skipped ?? 0) < (previous.rows_skipped ?? 0) ||
    (next.rows_failed ?? 0) < (previous.rows_failed ?? 0)
  ) {
    return null;
  }
  if (
    next.status === "ready" &&
    ((next.processed_rows ?? 0) !== next.rows_total ||
      (next.rows_imported ?? 0) +
        (next.rows_skipped ?? 0) +
        (next.rows_failed ?? 0) !==
        next.rows_total)
  ) {
    return null;
  }
  return next;
}

function confirmationOutcomeUncertain(error: ApiErr["error"]): boolean {
  return (
    error.kind === "timeout" ||
    error.kind === "network" ||
    error.status === 408 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

function safeActionError(
  error: ApiErr["error"] | undefined,
  action: ImportAction | "cancel",
): string {
  const reviewRequired = error?.code && REVIEW_REQUIRED_CODES.has(error.code);
  if (reviewRequired) {
    return "The reviewed import evidence is no longer current. Nothing was queued; run a fresh exhaustive preflight.";
  }
  if (error?.code === "aborted") {
    return action === "cancel"
      ? "The cancellation request was interrupted. Check live status before trying again."
      : "The request was interrupted. The reviewed draft was kept.";
  }
  if (error?.status === 403) {
    return "Your current workspace role no longer permits subscriber imports. The draft was not submitted.";
  }
  if (error?.status === 404) {
    return "This import review is no longer available. Upload the file again to create a fresh review.";
  }
  if (error?.status === 429) {
    const wait = error.retryAfterSeconds
      ? ` Wait about ${Math.ceil(error.retryAfterSeconds)} seconds.`
      : "";
    return `The import service is busy.${wait} The reviewed draft was kept.`;
  }
  if (action === "preflight") {
    return "The exhaustive preflight could not finish. Nothing was written; review connectivity and try again.";
  }
  if (action === "queue") {
    return "The verified import could not be queued. No second import was started; refresh the preflight before retrying if its evidence expired.";
  }
  return "The cancellation request could not be confirmed. Keep this view open and check live status before retrying.";
}

export function useImportExecution({
  preview,
  cancelling,
  onCompleted,
  setBusy,
  setPolling,
  setError,
  setPreview,
  setCancelling,
  setPreflight,
}: ImportExecutionOptions) {
  const [progressIssue, setProgressIssue] = useState<ImportPollingIssue | null>(
    null,
  );
  const [activeAction, setActiveAction] = useState<ImportAction | null>(null);
  const mountedRef = useRef(true);
  const currentIdRef = useRef<string | null>(preview?.id ?? null);
  const latestRef = useRef({ preview, cancelling, onCompleted });
  const confirmFlightRef = useRef<OperationOwner | null>(null);
  const confirmAbortRef = useRef<AbortController | null>(null);
  const cancelFlightRef = useRef<OperationOwner | null>(null);
  const cancelAbortRef = useRef<AbortController | null>(null);
  const progressOwnerRef = useRef<OperationOwner | null>(null);
  const progressSnapshotRef = useRef<SubscriberImportPreview | null>(preview);
  const pollerRef = useRef<ImportPollingLifecycle | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);

  currentIdRef.current = preview?.id ?? null;
  latestRef.current = { preview, cancelling, onCompleted };

  const owns = (owner: OperationOwner | null): boolean =>
    mountedRef.current &&
    owner != null &&
    currentIdRef.current === owner.importId;

  const clearProgressResources = useCallback(
    (updateState: boolean): void => {
      streamCleanupRef.current?.();
      streamCleanupRef.current = null;
      sseRef.current?.close();
      sseRef.current = null;
      pollerRef.current?.stop();
      pollerRef.current = null;
      progressOwnerRef.current = null;
      progressSnapshotRef.current = null;
      if (updateState && mountedRef.current) {
        setProgressIssue(null);
        setPolling(false);
      }
    },
    [setPolling],
  );

  const stopProgress = useCallback((): void => {
    clearProgressResources(true);
    confirmAbortRef.current?.abort();
    cancelAbortRef.current?.abort();
  }, [clearProgressResources]);

  const finishImport = useCallback(
    (owner: OperationOwner, terminal: SubscriberImportPreview): void => {
      if (!owns(owner)) return;
      clearProgressResources(true);
      setCancelling(false);
      if (terminal.status === "ready") {
        toast.success("Subscriber import complete.");
        latestRef.current.onCompleted();
        try {
          if (!localStorage.getItem("pw:celebrated:first-import")) {
            celebrate();
            localStorage.setItem("pw:celebrated:first-import", "1");
          }
        } catch {
          // An optional flourish must never change a successful settlement.
        }
      } else if (terminal.status === "cancelled") {
        toast.info("Subscriber import cancelled.");
      } else {
        toast.error("Subscriber import failed. Review the safe outcome summary.");
      }
    },
    [clearProgressResources, setCancelling],
  );

  const startPollFallback = useCallback(
    (owner: OperationOwner): void => {
      if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) {
        return;
      }
      sseRef.current?.close();
      sseRef.current = null;
      pollerRef.current?.stop();
      const poller = createImportPollingLifecycle({
        fetchImport: async (importId, signal) => {
          const result = await api.getSubscriberImport(importId, { signal });
          if (result.error) return result;
          const previous = progressSnapshotRef.current;
          const merged = previous
            ? mergeSubscriberImportPoll(previous, result.data)
            : result.data;
          if (!merged) {
            return {
              error: {
                kind: "parse" as const,
                code: "subscriber_import_progress_regression",
                message: "Subscriber import progress regressed.",
              },
              retryability: "not-retryable" as const,
            };
          }
          progressSnapshotRef.current = merged;
          return { data: merged };
        },
        onData: (nextPreview) => {
          if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) {
            return;
          }
          setPreview(nextPreview);
        },
        onTerminal: (terminal) => {
          if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) {
            return;
          }
          setPreview(terminal);
          finishImport(owner, terminal);
        },
        onIssue: (issue) => {
          if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) {
            return;
          }
          setProgressIssue(issue);
        },
      });
      pollerRef.current = poller;
      poller.start(owner.importId);
    },
    [finishImport, setPreview],
  );

  const startProgressStream = useCallback(
    async (importId: string): Promise<void> => {
      clearProgressResources(false);
      const owner = { importId, token: Symbol(`import-progress:${importId}`) };
      progressOwnerRef.current = owner;
      progressSnapshotRef.current =
        latestRef.current.preview?.id === importId
          ? latestRef.current.preview
          : null;
      setProgressIssue(null);
      setPolling(true);

      let url: string;
      try {
        url = await api.subscriberImportProgressUrlAuthed(importId);
      } catch {
        startPollFallback(owner);
        return;
      }
      if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) return;
      if (document.visibilityState === "hidden" || navigator.onLine === false) {
        startPollFallback(owner);
        return;
      }

      let eventSource: EventSource;
      try {
        eventSource = new EventSource(url, { withCredentials: true });
      } catch {
        startPollFallback(owner);
        return;
      }
      if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) {
        eventSource.close();
        return;
      }
      sseRef.current = eventSource;
      const handOffToPolling = (): void => {
        if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) return;
        eventSource.close();
        if (sseRef.current === eventSource) sseRef.current = null;
        startPollFallback(owner);
      };
      const onVisibility = (): void => {
        if (document.visibilityState === "hidden") handOffToPolling();
      };
      window.addEventListener("offline", handOffToPolling);
      document.addEventListener("visibilitychange", onVisibility);
      streamCleanupRef.current = () => {
        window.removeEventListener("offline", handOffToPolling);
        document.removeEventListener("visibilitychange", onVisibility);
      };

      eventSource.addEventListener("progress", (event: MessageEvent) => {
        if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(String(event.data));
        } catch {
          handOffToPolling();
          return;
        }
        const progress = parseSubscriberImportProgressEvent(decoded);
        if (!progress) {
          handOffToPolling();
          return;
        }
        const previous = progressSnapshotRef.current;
        const next = previous
          ? mergeSubscriberImportProgress(previous, progress)
          : null;
        if (!next) {
          handOffToPolling();
          return;
        }
        progressSnapshotRef.current = next;
        setProgressIssue(null);
        setPreview(next);
        if (isTerminal(next.status)) finishImport(owner, next);
      });
      eventSource.addEventListener("heartbeat", (event: MessageEvent) => {
        if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) return;
        try {
          if (!parseSubscriberImportHeartbeatEvent(JSON.parse(String(event.data)))) {
            handOffToPolling();
          }
        } catch {
          handOffToPolling();
        }
      });
      eventSource.addEventListener("closed", (event: MessageEvent) => {
        if (!owns(owner) || progressOwnerRef.current?.token !== owner.token) return;
        try {
          if (!parseSubscriberImportClosedEvent(JSON.parse(String(event.data)))) {
            handOffToPolling();
            return;
          }
        } catch {
          handOffToPolling();
          return;
        }
        handOffToPolling();
      });
      eventSource.onerror = handOffToPolling;
    },
    [clearProgressResources, finishImport, setPolling, setPreview, startPollFallback],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      confirmFlightRef.current = null;
      cancelFlightRef.current = null;
      confirmAbortRef.current?.abort();
      cancelAbortRef.current?.abort();
      clearProgressResources(false);
    };
  }, [clearProgressResources]);

  useEffect(() => {
    const currentId = preview?.id ?? null;
    if (progressOwnerRef.current?.importId !== currentId) {
      clearProgressResources(true);
    }
    if (confirmFlightRef.current?.importId !== currentId) {
      confirmAbortRef.current?.abort();
      confirmAbortRef.current = null;
      confirmFlightRef.current = null;
      setBusy(false);
      setActiveAction(null);
    }
    if (cancelFlightRef.current?.importId !== currentId) {
      cancelAbortRef.current?.abort();
      cancelAbortRef.current = null;
      cancelFlightRef.current = null;
      setCancelling(false);
    }
  }, [clearProgressResources, preview?.id, setBusy, setCancelling]);

  const settleConfirmation = useCallback(
    async (action: ImportAction): Promise<void> => {
      const selected = latestRef.current.preview;
      if (
        !selected ||
        selected.status !== "preview" ||
        confirmFlightRef.current != null ||
        progressOwnerRef.current != null
      ) {
        return;
      }
      const owner = { importId: selected.id, token: Symbol(`import-${action}`) };
      const controller = new AbortController();
      confirmFlightRef.current = owner;
      confirmAbortRef.current = controller;
      setBusy(true);
      setActiveAction(action);
      setError(null);
      const recoverUncertainOutcome = async (): Promise<boolean> => {
        if (controller.signal.aborted) return false;
        const recovered = await api.getSubscriberImport(selected.id, {
          signal: controller.signal,
        });
        if (
          recovered.error ||
          !owns(owner) ||
          confirmFlightRef.current?.token !== owner.token ||
          recovered.data.source_fingerprint !== selected.source_fingerprint ||
          recovered.data.configuration_revision !==
            selected.configuration_revision
        ) {
          return false;
        }
        if (action === "preflight") {
          const results = recovered.data.dry_run_results;
          if (
            recovered.data.status !== "preview" ||
            recovered.data.classification_authoritative !== true ||
            recovered.data.preflight_required !== false ||
            !results ||
            results.preflight_fingerprint !==
              recovered.data.preflight_fingerprint
          ) {
            return false;
          }
          latestRef.current = {
            ...latestRef.current,
            preview: recovered.data,
          };
          setPreview(recovered.data);
          setPreflight(results);
          toast.info(
            "The preflight response was interrupted, but its authoritative server result was recovered safely.",
          );
          return true;
        }
        if (recovered.data.status === "preview") return false;
        latestRef.current = {
          ...latestRef.current,
          preview: recovered.data,
        };
        progressSnapshotRef.current = recovered.data;
        setPreview(recovered.data);
        if (isTerminal(recovered.data.status)) {
          finishImport(owner, recovered.data);
        } else {
          toast.info(
            "The queue response was interrupted, but the single server-side import was recovered.",
          );
          void startProgressStream(selected.id);
        }
        return true;
      };
      const recoverSafely = async (): Promise<boolean> => {
        try {
          return await recoverUncertainOutcome();
        } catch {
          return false;
        }
      };
      try {
        const response = await api.confirmSubscriberImport(selected.id, {
          dry_run: action === "preflight",
          signal: controller.signal,
        });
        if (!owns(owner) || confirmFlightRef.current?.token !== owner.token) return;
        if (response.error) {
          if (
            response.error.code !== "aborted" &&
            confirmationOutcomeUncertain(response.error) &&
            (await recoverSafely())
          ) {
            return;
          }
          if (response.error.code && REVIEW_REQUIRED_CODES.has(response.error.code)) {
            setPreflight(null);
            setPreview((previous) =>
              previous?.id === selected.id
                ? { ...previous, preflight_required: true, dry_run_results: undefined }
                : previous,
            );
          }
          setError(safeActionError(response.error, action));
          return;
        }
        if (action === "preflight") {
          const results = response.data.dry_run_results;
          if (!results) {
            setPreflight(null);
            setError(
              "The server did not return a complete authoritative preflight. Nothing was written; try again.",
            );
            return;
          }
          setPreflight(results);
          setPreview((previous) =>
            previous?.id === selected.id
              ? {
                  ...previous,
                  ...response.data,
                  status: "preview",
                  preflight_required: false,
                  preflight_fingerprint: results.preflight_fingerprint,
                  preflight_at: results.validated_at,
                  preflight_expires_at: results.expires_at,
                  preflight_rows_total: results.rows_total,
                  preflight_rows_failed: results.would_fail,
                  preflight_rows_existing:
                    results.would_update +
                    (selected.on_existing === "skip" ? results.would_skip - results.file_dupes : 0),
                }
              : previous,
          );
          toast.success(
            `Exhaustive preflight verified ${results.rows_total.toLocaleString()} rows. Nothing was written.`,
          );
          return;
        }
        const queued: SubscriberImportPreview = {
          ...selected,
          ...response.data,
          status: "queued",
        };
        latestRef.current = { ...latestRef.current, preview: queued };
        progressSnapshotRef.current = queued;
        setPreview(queued);
        toast.success("Verified subscriber import queued once.");
        void startProgressStream(selected.id);
      } catch {
        if (owns(owner) && confirmFlightRef.current?.token === owner.token) {
          if (await recoverSafely()) return;
          setError(safeActionError(undefined, action));
        }
      } finally {
        if (confirmFlightRef.current?.token === owner.token) {
          confirmFlightRef.current = null;
          confirmAbortRef.current = null;
          if (owns(owner)) {
            setBusy(false);
            setActiveAction(null);
          }
        }
      }
    }, [
      finishImport,
      setBusy,
      setError,
      setPreflight,
      setPreview,
      startProgressStream,
    ],
  );

  const runPreflight = useCallback(
    (): Promise<void> => settleConfirmation("preflight"),
    [settleConfirmation],
  );
  const queueImport = useCallback(
    (): Promise<void> => settleConfirmation("queue"),
    [settleConfirmation],
  );

  const requestCancel = useCallback(async (): Promise<void> => {
    const selected = latestRef.current.preview;
    if (
      !selected ||
      latestRef.current.cancelling ||
      cancelFlightRef.current != null ||
      !progressOwnerRef.current
    ) {
      return;
    }
    const owner = { importId: selected.id, token: Symbol("import-cancel") };
    const controller = new AbortController();
    cancelFlightRef.current = owner;
    cancelAbortRef.current = controller;
    setCancelling(true);
    setError(null);
    try {
      const response = await api.cancelSubscriberImport(selected.id, {
        signal: controller.signal,
      });
      if (!owns(owner) || cancelFlightRef.current?.token !== owner.token) return;
      if (response.error) {
        setError(safeActionError(response.error, "cancel"));
        setCancelling(false);
        return;
      }
      const previous = progressSnapshotRef.current ?? selected;
      const next: SubscriberImportPreview = {
        ...previous,
        status: response.data.status,
        cancel_requested: true,
      };
      progressSnapshotRef.current = next;
      latestRef.current = { ...latestRef.current, preview: next };
      setPreview(next);
      if (response.data.status === "cancelled") {
        const progressOwner = progressOwnerRef.current;
        if (progressOwner) finishImport(progressOwner, next);
      } else {
        toast.info("Cancellation requested. Waiting for the worker to settle safely.");
      }
    } catch {
      if (owns(owner) && cancelFlightRef.current?.token === owner.token) {
        setError(safeActionError(undefined, "cancel"));
        setCancelling(false);
      }
    } finally {
      if (cancelFlightRef.current?.token === owner.token) {
        cancelFlightRef.current = null;
        cancelAbortRef.current = null;
      }
    }
  }, [finishImport, setCancelling, setError, setPreview]);

  const retryProgress = useCallback((): void => {
    pollerRef.current?.retryNow();
  }, []);

  return {
    runPreflight,
    queueImport,
    requestCancel,
    stopProgress,
    progressIssue,
    retryProgress,
    activeAction,
  };
}
