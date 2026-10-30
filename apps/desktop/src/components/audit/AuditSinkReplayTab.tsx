/**
 * Cursor-based audit-log replay UI.
 *
 * Kept outside the Audit Sinks page so polling, validation, cancellation,
 * and progress rendering form a bounded controller rather than extending the
 * page-level CRUD surface.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { type AuditSink, type ReplayJob, api } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";

const MAX_REPLAY_ROWS = 100_000;

export interface AuditReplayRange {
  size: number;
  tooLarge: boolean;
}

function parseAuditReplayId(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function getAuditReplayRange(
  fromId: string,
  toId: string,
): AuditReplayRange {
  const from = parseAuditReplayId(fromId);
  const to = parseAuditReplayId(toId);
  const size = from == null || to == null || to < from ? 0 : to - from + 1;
  return { size, tooLarge: size > MAX_REPLAY_ROWS };
}

function getReplayUnavailableReason({
  canExecute,
  operationActive,
  sinkId,
  fromId,
  toId,
  range,
}: {
  canExecute: boolean;
  operationActive: boolean;
  sinkId: string;
  fromId: string;
  toId: string;
  range: AuditReplayRange;
}): string | null {
  const parsedFromId = parseAuditReplayId(fromId);
  const parsedToId = parseAuditReplayId(toId);
  if (!canExecute)
    return "Restricted: audit:execute_actions permission is required.";
  if (operationActive) return "A replay job is already being queued.";
  if (!sinkId) return "Choose an audit sink first.";
  if (!fromId.trim() || !toId.trim())
    return "Enter both ends of the audit-log ID range.";
  if (parsedFromId == null || parsedToId == null)
    return "Audit-log IDs must be non-negative safe integers.";
  if (parsedFromId > parsedToId)
    return "The starting audit-log ID must not exceed the ending ID.";
  if (range.tooLarge)
    return "The range exceeds the 100,000-row cap; split it into multiple jobs.";
  return null;
}

function useMountedGuard(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}

export function getAuditReplayProgress(job: ReplayJob): {
  total: number;
  percent: number;
} {
  const total = job.to_audit_id - job.from_audit_id + 1;
  const percent =
    total > 0 ? Math.min(100, Math.round((job.rows_sent / total) * 100)) : 0;
  return { total, percent };
}

// Renders an ISO timestamp as a compact relative label.
export function formatAuditReplayAge(iso: string, now = Date.now()): string {
  if (!iso) return "—";
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const difference = now - timestamp;
  if (difference < 60_000) return "just now";
  if (difference < 3_600_000) return `${Math.round(difference / 60_000)}m ago`;
  if (difference < 86_400_000)
    return `${Math.round(difference / 3_600_000)}h ago`;
  return `${Math.round(difference / 86_400_000)}d ago`;
}

export function AuditSinkReplayTab({
  sinks,
  canExecute,
}: {
  sinks: AuditSink[];
  canExecute: boolean;
}): ReactElement {
  const [sinkId, setSinkId] = useState<string>(() => {
    const firstEnabled = sinks.find((sink) => sink.enabled);
    return firstEnabled?.id ?? sinks[0]?.id ?? "";
  });
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [pendingSinkId, setPendingSinkId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ReplayJob[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const activeSinkId = useRef(sinkId);
  activeSinkId.current = sinkId;
  const jobsRequestSeq = useRef(0);
  const isMounted = useMountedGuard();
  const cancelOperation = useSingleFlightOperation({
    ownerId: "audit-sink-replay-cancel",
    label: "Audit replay cancellation",
    detail: "Wait for the replay cancellation to finish before leaving.",
  });

  useEffect(() => {
    const firstEnabled = sinks.find((sink) => sink.enabled);
    const preferred = firstEnabled?.id ?? sinks[0]?.id ?? "";
    if (!sinks.some((sink) => sink.id === sinkId)) setSinkId(preferred);
  }, [sinks, sinkId]);

  const loadJobs = useCallback(async (): Promise<void> => {
    const requestSinkId = sinkId;
    const requestSeq = ++jobsRequestSeq.current;
    if (!requestSinkId) {
      if (isMounted()) setJobs([]);
      return;
    }
    const result = await api.auditSinkReplayJobsList(requestSinkId, {
      limit: 25,
    });
    if (
      !isMounted() ||
      requestSeq !== jobsRequestSeq.current ||
      activeSinkId.current !== requestSinkId
    ) {
      return;
    }
    if (result.error) {
      setJobsError(result.error.message);
      setJobs([]);
      return;
    }
    setJobsError(null);
    setJobs(result.data?.jobs ?? []);
  }, [isMounted, sinkId]);

  useEffect(() => {
    setJobs(null);
    setJobsError(null);
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    const hasActiveJob = (jobs ?? []).some(
      (job) => job.status === "pending" || job.status === "in_progress",
    );
    if (!hasActiveJob) return;
    const handle = setInterval(() => {
      void loadJobs();
    }, 3000);
    return () => clearInterval(handle);
  }, [jobs, loadJobs]);

  const range = useMemo(
    () => getAuditReplayRange(fromId, toId),
    [fromId, toId],
  );

  const submit = async (): Promise<boolean> => {
    if (!canExecute) {
      toast.error("Replay requires audit:execute_actions permission.");
      return false;
    }
    const from = parseAuditReplayId(fromId);
    const to = parseAuditReplayId(toId);
    if (from == null || to == null) {
      toast.error("from_id and to_id must be non-negative safe integers.");
      return false;
    }
    if (from > to) {
      toast.error("from_id must be <= to_id.");
      return false;
    }
    if (range.tooLarge) {
      toast.error("Range exceeds 100k-row cap. Split into multiple jobs.");
      return false;
    }
    const requestSinkId = sinkId;
    const result = await api.auditSinkReplay(requestSinkId, {
      from_id: from,
      to_id: to,
    });
    if (result.error) {
      toast.error(result.error.message);
      return false;
    }
    toast.success(`Replay job queued — ${result.data?.job_id ?? ""}`);
    if (isMounted() && activeSinkId.current === requestSinkId) {
      setFromId("");
      setToId("");
      void loadJobs();
    }
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: `audit-sink-replay-${sinkId || "none"}`,
    label: "Audit sink replay range",
    mode: "action",
    enabled: sinks.length > 0,
    dirty: Boolean(fromId.trim()) || Boolean(toId.trim()),
    save: submit,
    discard: () => {
      setFromId("");
      setToId("");
    },
    close: () => {
      if (!pendingSinkId) return;
      jobsRequestSeq.current += 1;
      setJobs(null);
      setJobsError(null);
      setSinkId(pendingSinkId);
      setPendingSinkId(null);
    },
    detail:
      "This audit replay range has not been queued. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the audit replay request to be accepted before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The replay couldn't be queued."),
      ),
  });

  const cancel = async (jobId: string): Promise<void> => {
    if (!canExecute) {
      toast.error("Cancel requires audit:execute_actions permission.");
      return;
    }
    const requestSinkId = sinkId;
    const request = cancelOperation.run(async () => {
      try {
        const result = await api.auditSinkReplayJobCancel(requestSinkId, jobId);
        if (result.error) {
          toast.error(result.error.message);
          return;
        }
        toast.success("Job cancelled");
        if (isMounted() && activeSinkId.current === requestSinkId) {
          void loadJobs();
        }
      } catch (error) {
        toast.error(
          lifecycleOperationError(error, "The replay couldn't be cancelled."),
        );
      }
    });
    if (!request) await cancelOperation.wait();
  };

  const replayUnavailableReason = getReplayUnavailableReason({
    canExecute,
    operationActive: lifecycle.active,
    sinkId,
    fromId,
    toId,
    range,
  });

  return (
    <div>
      <SectionHeader
        title="Replay audit rows to a sink"
        description="Re-ship a range of audit_log rows to a specific sink. Useful after a SIEM outage, when bootstrapping a new sink with historical data, or to re-deliver rows after fixing a credential."
      />

      {sinks.length === 0 ? (
        <div className="callout">
          No sinks configured yet — create one on the Sinks tab before queuing a
          replay.
        </div>
      ) : (
        <div
          className="card"
          style={{ padding: 16, marginBottom: 16 }}
          data-testid="replay-form"
        >
          <div
            className="row"
            style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}
          >
            <label className="col" style={{ gap: 4, flex: "1 1 220px" }}>
              <span className="muted small">Sink</span>
              <select
                className="input"
                value={sinkId}
                disabled={lifecycle.active || cancelOperation.active}
                onChange={(event) => {
                  if (fromId.trim() || toId.trim()) {
                    setPendingSinkId(event.target.value);
                    lifecycle.requestClose();
                    return;
                  }
                  jobsRequestSeq.current += 1;
                  setJobs(null);
                  setJobsError(null);
                  setSinkId(event.target.value);
                }}
              >
                {sinks.map((sink) => (
                  <option key={sink.id} value={sink.id}>
                    {sink.name} ({sink.kind}) {sink.enabled ? "" : "— disabled"}
                  </option>
                ))}
              </select>
            </label>
            <ReplayRangeInput
              label="From audit_log id"
              value={fromId}
              onChange={setFromId}
              disabled={lifecycle.active || cancelOperation.active}
              testId="replay-from-id"
            />
            <ReplayRangeInput
              label="To audit_log id"
              value={toId}
              onChange={setToId}
              disabled={lifecycle.active || cancelOperation.active}
              testId="replay-to-id"
            />
            <button
              type="button"
              className="btn btn-primary"
              aria-disabled={replayUnavailableReason ? true : undefined}
              aria-describedby={
                replayUnavailableReason
                  ? "audit-replay-unavailable-reason"
                  : undefined
              }
              onClick={() => {
                if (replayUnavailableReason) return;
                void lifecycle.submit();
              }}
            >
              {lifecycle.active ? "Queuing…" : "Start replay job"}
            </button>
          </div>
          {replayUnavailableReason ? (
            <p
              id="audit-replay-unavailable-reason"
              className="muted small"
              style={{ margin: "8px 0 0" }}
            >
              {replayUnavailableReason}
            </p>
          ) : null}
          <AuditReplayRangePreview range={range} />
        </div>
      )}

      <RecentAuditReplayJobs
        jobs={jobs}
        jobsError={jobsError}
        canExecute={canExecute}
        cancelBusy={cancelOperation.active}
        onCancel={cancel}
      />
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard replay range and switch sink?"
        description="The current audit row range has not been queued for replay."
        confirmLabel="Discard and switch"
        danger
        busy={lifecycle.active || cancelOperation.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={() => {
          setPendingSinkId(null);
          lifecycle.keepEditing();
        }}
      />
    </div>
  );
}

function AuditReplayRangePreview({
  range,
}: {
  range: AuditReplayRange;
}): ReactElement | null {
  if (range.size === 0) return null;
  return (
    <div
      className="muted small"
      style={{ marginTop: 8 }}
      data-testid="replay-range-preview"
    >
      {range.tooLarge
        ? `Warning: ${range.size.toLocaleString()} rows exceeds the 100,000 cap — split into multiple jobs.`
        : `Will replay ${range.size.toLocaleString()} row${range.size === 1 ? "" : "s"} in batches of 100 (worker BatchSize).`}
    </div>
  );
}

function RecentAuditReplayJobs({
  jobs,
  jobsError,
  canExecute,
  cancelBusy,
  onCancel,
}: {
  jobs: ReplayJob[] | null;
  jobsError: string | null;
  canExecute: boolean;
  cancelBusy: boolean;
  onCancel: (jobId: string) => Promise<void>;
}): ReactElement {
  return (
    <>
      <SectionHeader
        title="Recent replay jobs"
        description="Polls every 3s while any job is active. Cancel sends a terminal-state update; in-flight batches may complete before the cancel lands."
      />
      {jobsError ? <div className="callout error">{jobsError}</div> : null}
      {jobs === null ? (
        <div className="muted">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="muted">No replay jobs for this sink yet.</div>
      ) : (
        <AuditReplayJobsTable
          jobs={jobs}
          canExecute={canExecute}
          cancelBusy={cancelBusy}
          onCancel={onCancel}
        />
      )}
    </>
  );
}

function ReplayRangeInput({
  label,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  testId: string;
}): ReactElement {
  return (
    <label className="col" style={{ gap: 4, flex: "0 0 140px" }}>
      <span className="muted small">{label}</span>
      <input
        type="number"
        className="input"
        value={value}
        placeholder="0"
        min={0}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
    </label>
  );
}

function AuditReplayJobsTable({
  jobs,
  canExecute,
  cancelBusy,
  onCancel,
}: {
  jobs: ReplayJob[];
  canExecute: boolean;
  cancelBusy: boolean;
  onCancel: (jobId: string) => Promise<void>;
}): ReactElement {
  return (
    <table className="data-table" style={{ width: "100%" }}>
      <thead>
        <tr>
          <th>Job</th>
          <th>Range</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Created</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <AuditReplayJobRow
            key={job.id}
            job={job}
            canExecute={canExecute}
            cancelBusy={cancelBusy}
            onCancel={onCancel}
          />
        ))}
      </tbody>
    </table>
  );
}

function AuditReplayJobRow({
  job,
  canExecute,
  cancelBusy,
  onCancel,
}: {
  job: ReplayJob;
  canExecute: boolean;
  cancelBusy: boolean;
  onCancel: (jobId: string) => Promise<void>;
}): ReactElement {
  const { total, percent } = getAuditReplayProgress(job);
  const active = job.status === "pending" || job.status === "in_progress";
  const badgeClass =
    job.status === "completed"
      ? "badge success"
      : job.status === "failed"
        ? "badge error"
        : job.status === "cancelled"
          ? "badge"
          : "badge warning";
  return (
    <tr data-testid={`replay-job-${job.id}`}>
      <td className="tabular" style={{ fontSize: 11 }}>
        {job.id.slice(0, 8)}…
      </td>
      <td className="tabular" style={{ fontSize: 12 }}>
        {job.from_audit_id.toLocaleString()} →{" "}
        {job.to_audit_id.toLocaleString()}
      </td>
      <td>
        <span className={badgeClass}>{job.status}</span>
        {job.last_error && (
          <div
            className="muted small"
            style={{ marginTop: 4, fontSize: 11 }}
            title={job.last_error}
          >
            {job.last_error.slice(0, 80)}
            {job.last_error.length > 80 ? "…" : ""}
          </div>
        )}
      </td>
      <td style={{ minWidth: 140 }}>
        <div
          style={{
            background: "var(--pw-bg-elev-2)",
            height: 6,
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: "100%",
              background:
                job.status === "failed"
                  ? "var(--pw-danger)"
                  : "var(--pw-accent)",
            }}
          />
        </div>
        <div
          className="muted small tabular"
          style={{ fontSize: 11, marginTop: 2 }}
        >
          {job.rows_sent.toLocaleString()} / {total.toLocaleString()} ({percent}
          %)
          {job.rows_failed > 0 && (
            <span style={{ color: "var(--pw-danger)" }}>
              {" "}
              · {job.rows_failed} failed
            </span>
          )}
        </div>
      </td>
      <td className="muted small">{formatAuditReplayAge(job.created_at)}</td>
      <td>
        {active && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void onCancel(job.id)}
            disabled={!canExecute || cancelBusy}
          >
            Cancel
          </button>
        )}
      </td>
    </tr>
  );
}
