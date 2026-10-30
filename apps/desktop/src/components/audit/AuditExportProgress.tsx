/**
 * AuditExportProgress — sse-pinned-tail feature.
 *
 * Modal that backs the async CSV export flow. On open, immediately
 * calls /audit/count to pre-fetch the row estimate, then enqueues a
 * job via /audit/export-async and polls /audit/export-jobs/{id} until
 * completion. Shows a live progress bar + ETA + email-on-complete
 * toggle.
 *
 * The synchronous Export CSV button remains the fast-path for small
 * filter sets. This modal opens when the operator picks "Async export"
 * from the export dropdown OR when the count pre-flight indicates the
 * sync stream would exceed ~5,000 rows.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import { type AuditExportJob, api } from "../../lib/api-client";
import { downloadUrlToFile } from "../../lib/file-transfer";
import { ConfirmModal } from "../ConfirmModal";
import { Modal } from "../Modal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import { parseAuditCount } from "./audit-count-contract";

type Filters = {
  actorType?: string;
  actorLabel?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
};

interface Props {
  open: boolean;
  filters: Filters;
  /** Optional preset email — defaults to the calling actor's email. */
  defaultEmail?: string;
  onClose: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtEta(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

export function AuditExportProgress({
  open,
  filters,
  defaultEmail,
  onClose,
}: Props): ReactElement | null {
  // Phase machine: estimating → queued → in_progress → complete | failed.
  const [phase, setPhase] = useState<
    "estimating" | "queued" | "running" | "complete" | "failed"
  >("estimating");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<"exact" | "approximate">(
    "exact",
  );
  const [job, setJob] = useState<AuditExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state for the queue-confirm pane.
  const [emailOnComplete, setEmailOnComplete] = useState(false);
  const [emailAddress, setEmailAddress] = useState(defaultEmail ?? "");

  const pollRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const openRef = useRef(open);
  const generationRef = useRef(0);
  openRef.current = open;

  const clearPoll = useCallback((): void => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const revokePolling = useCallback((): void => {
    generationRef.current += 1;
    clearPoll();
  }, [clearPoll]);

  const isCurrentGeneration = (generation: number): boolean =>
    mountedRef.current &&
    openRef.current &&
    generationRef.current === generation;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearPoll();
    };
  }, [clearPoll]);

  useEffect(() => {
    const generation = ++generationRef.current;
    clearPoll();
    if (!open) return undefined;
    setPhase("estimating");
    setEstimate(null);
    setJob(null);
    setError(null);
    setEmailOnComplete(false);
    setEmailAddress(defaultEmail ?? "");
    void (async () => {
      const res = await api.getAuditCount(filters);
      if (!isCurrentGeneration(generation)) return;
      const count = parseAuditCount(res.data);
      if (res.error || !count) {
        setError(res.error?.message ?? "The audit count response was invalid");
        setPhase("failed");
        return;
      }
      setEstimate(count.totalEstimate);
      setConfidence(count.confidence);
      setPhase("queued");
    })();
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      clearPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearPoll, open]);

  // Enqueue + poll.
  const onStart = async (): Promise<boolean> => {
    const generation = generationRef.current;
    if (isCurrentGeneration(generation)) setPhase("running");
    let enq;
    try {
      enq = await api.exportAuditAsync({
        ...filters,
        emailOnComplete,
        emailAddress: emailOnComplete ? emailAddress : undefined,
      });
    } catch (requestError) {
      if (isCurrentGeneration(generation)) {
        setError(
          lifecycleOperationError(requestError, "Could not enqueue export"),
        );
        setPhase("queued");
      }
      return false;
    }
    if (enq.error || !enq.data) {
      if (isCurrentGeneration(generation)) {
        setError(enq.error?.message ?? "Could not enqueue export");
        setPhase("queued");
      }
      return false;
    }
    if (!isCurrentGeneration(generation)) return true;
    setJob(enq.data);
    setEmailOnComplete(false);
    setEmailAddress(defaultEmail ?? "");
    // Exponential-backoff polling: 1s → 2s → 4s → 8s, capped at 10s.
    let interval = 1000;
    const tick = async (): Promise<void> => {
      if (!isCurrentGeneration(generation)) return;
      let cur;
      try {
        cur = await api.getAuditExportJob(enq.data!.id);
      } catch (requestError) {
        if (!isCurrentGeneration(generation)) return;
        setError(
          lifecycleOperationError(
            requestError,
            "Couldn't refresh export progress. Retrying…",
          ),
        );
        schedule(interval);
        return;
      }
      if (!isCurrentGeneration(generation)) return;
      if (cur.error || !cur.data) {
        setError(
          cur.error?.message ?? "Couldn't refresh export progress. Retrying…",
        );
        schedule(interval);
        return;
      }
      setError(null);
      setJob(cur.data);
      if (cur.data.status === "completed") {
        setPhase("complete");
        clearPoll();
        toast.success(
          `Export ready — ${cur.data.exportedRows.toLocaleString()} rows`,
        );
        return;
      }
      if (cur.data.status === "failed") {
        setPhase("failed");
        setError(cur.data.errorReason ?? "Export failed");
        clearPoll();
        return;
      }
      // Bump the interval until we're capped at 10s.
      interval = Math.min(10_000, Math.round(interval * 1.5));
      schedule(interval);
    };
    const schedule = (delay: number): void => {
      clearPoll();
      if (!isCurrentGeneration(generation)) return;
      pollRef.current = window.setTimeout(() => {
        pollRef.current = null;
        void tick();
      }, delay);
    };
    schedule(interval);
    return true;
  };

  const baseline = {
    emailOnComplete: false,
    emailAddress: defaultEmail ?? "",
  };
  const lifecycle = useDraftLifecycleController({
    ownerId: "audit-export-queue-draft",
    label: "Audit export request or progress handle",
    mode: "action",
    enabled: open && (phase === "queued" || phase === "running"),
    dirty:
      phase === "running" ||
      JSON.stringify({ emailOnComplete, emailAddress }) !==
        JSON.stringify(baseline),
    save: onStart,
    discard: () => {
      setEmailOnComplete(false);
      setEmailAddress(defaultEmail ?? "");
      setError(null);
      revokePolling();
    },
    close: onClose,
    detail:
      phase === "running"
        ? "This is the only visible progress and download handle for the running export. The server job continues if you explicitly abandon it."
        : "This audit export request has not been queued. Return to it or explicitly discard the notification draft.",
    operationDetail:
      "Wait for the audit export request to be accepted before leaving Moosewave.",
  });

  const requestClose = (): void => {
    if (lifecycle.promiseRef.current) return;
    if (phase === "queued" || phase === "running") lifecycle.requestClose();
    else onClose();
  };

  const onDownload = async (): Promise<void> => {
    if (!job) return;
    try {
      const url = await api.auditExportJobDownloadUrlAuthed(job.id);
      const saved = await downloadUrlToFile({
        url,
        suggestedName: `audit-export-${job.id}.csv`,
        label: "Prepared audit export",
        privacy: "confidential",
        mimeType: "text/csv;charset=utf-8",
      });
      if (!saved.ok) toast.error(saved.message);
    } catch {
      toast.error("Couldn't download the prepared audit export.");
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title="Export audit log as CSV"
    >
      <div style={{ display: "grid", gap: 12, minWidth: 360 }}>
        {phase === "estimating" ? (
          <div>
            <div className="muted small">
              Counting matching rows for your filter…
            </div>
          </div>
        ) : phase === "queued" ? (
          <QueuedExportPane
            confidence={confidence}
            estimate={estimate}
            error={error}
            emailOnComplete={emailOnComplete}
            emailAddress={emailAddress}
            busy={lifecycle.active}
            onEmailToggle={setEmailOnComplete}
            onEmailChange={setEmailAddress}
            onClose={requestClose}
            onStart={() => void lifecycle.submit()}
          />
        ) : phase === "running" ? (
          <RunningExportPane job={job} estimate={estimate} error={error} />
        ) : phase === "complete" ? (
          <>
            <div className="label" style={{ color: "var(--pw-success)" }}>
              Ready
            </div>
            <div className="muted small">
              {job?.exportedRows?.toLocaleString() ?? 0} rows ·{" "}
              {fmtBytes(job?.totalBytes ?? 0)}
            </div>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void onDownload()}
                data-testid="audit-export-download"
              >
                Download CSV
              </button>
            </div>
          </>
        ) : (
          <>
            <Notice tone="danger" announcement="assertive">
              {error ?? "Export failed"}
            </Notice>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
      <ExportDiscardConfirm
        open={lifecycle.discardConfirmOpen}
        running={phase === "running"}
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </Modal>
  );
}

function RunningExportPane({
  job,
  estimate,
  error,
}: {
  job: AuditExportJob | null;
  estimate: number | null;
  error: string | null;
}): ReactElement {
  const progressPct =
    job && estimate && estimate > 0
      ? Math.min(100, Math.round((job.exportedRows / estimate) * 100))
      : 0;
  return (
    <>
      <div className="label">Exporting…</div>
      <div
        style={{
          height: 8,
          background: "var(--pw-bg-elev-2)",
          borderRadius: 999,
          overflow: "hidden",
        }}
        data-testid="audit-export-progress-bar"
      >
        <div
          style={{
            width: `${progressPct}%`,
            height: "100%",
            background: "var(--pw-accent)",
            transition: "width 200ms ease",
          }}
        />
      </div>
      <div className="muted small" data-testid="audit-export-progress-text">
        {job?.exportedRows?.toLocaleString() ?? 0}
        {estimate ? ` / ~${estimate.toLocaleString()}` : ""} rows ·{" "}
        {fmtBytes(job?.totalBytes ?? 0)}
        {job?.etaSeconds ? ` · ETA ${fmtEta(job.etaSeconds)}` : ""}
      </div>
      {error ? (
        <Notice tone="warning" announcement="polite">
          {error}
        </Notice>
      ) : null}
    </>
  );
}

function ExportDiscardConfirm({
  open,
  running,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  running: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <ConfirmModal
      open={open}
      title={
        running ? "Stop watching this export?" : "Discard audit export draft?"
      }
      description={
        running
          ? "The server job will continue, but this build has no export-history screen for reopening its download handle."
          : "The export has not been queued. Notification settings will be cleared."
      }
      confirmLabel={running ? "Stop watching" : "Discard draft"}
      danger
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function QueuedExportPane({
  confidence,
  estimate,
  error,
  emailOnComplete,
  emailAddress,
  busy,
  onEmailToggle,
  onEmailChange,
  onClose,
  onStart,
}: {
  confidence: "exact" | "approximate";
  estimate: number | null;
  error: string | null;
  emailOnComplete: boolean;
  emailAddress: string;
  busy: boolean;
  onEmailToggle: (enabled: boolean) => void;
  onEmailChange: (email: string) => void;
  onClose: () => void;
  onStart: () => void;
}): ReactElement {
  return (
    <>
      <div data-testid="audit-export-estimate">
        <div className="label">Estimated rows</div>
        <div style={{ fontSize: 22, fontWeight: 600 }}>
          {confidence === "approximate" ? "~" : ""}
          {(estimate ?? 0).toLocaleString()}
        </div>
        <div className="muted small">
          {confidence === "approximate"
            ? "Planner estimate — actual count may differ slightly."
            : "Exact count from the audit_log table."}
        </div>
      </div>
      {error ? (
        <Notice tone="danger" announcement="assertive">
          {error}
        </Notice>
      ) : null}
      <label
        className="row"
        style={{ gap: 6, alignItems: "center", fontSize: 13 }}
      >
        <input
          type="checkbox"
          checked={emailOnComplete}
          disabled={busy}
          onChange={(event) => onEmailToggle(event.target.checked)}
        />
        Email me when ready
      </label>
      {emailOnComplete ? (
        <input
          className="input"
          type="email"
          placeholder="you@example.com"
          value={emailAddress}
          disabled={busy}
          onChange={(event) => onEmailChange(event.target.value)}
        />
      ) : null}
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onStart}
          disabled={busy}
          data-testid="audit-export-start"
        >
          Start export
        </button>
      </div>
    </>
  );
}
