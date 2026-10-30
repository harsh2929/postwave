/**
 * ProgressView — the live in-flight migration UI. Owns:
 *   - the SSE subscription via connectMigrationEvents()
 *   - polling fallback when the EventSource stays closed for ≥ 6s
 *   - per-resource progress bars
 *   - rolling activity log
 *   - cancel button (DELETE /migrations/{id})
 *
 * On completion fires `onComplete(MigrationDoneEvent)`. On terminal
 * failure fires `onComplete` too — the parent looks at `done.status` to
 * decide whether to render a celebration screen or the error UX.
 */

import {
  type Dispatch,
  type RefObject,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { ActivityLog, type ActivityEntry } from "./ActivityLog";
import { MigrationDestructiveDialog } from "./MigrationDestructiveDialog";
import { ResourceProgressBar } from "./ResourceProgressBar";
import {
  type MigrationDoneEvent,
  type MigrationDoneResourceCounts,
  type MigrationJob,
  type MigrationProgress,
  type MigrationProgressEvent,
  type MigrationSource,
  api,
  cancelMigration,
  connectMigrationEvents,
} from "../../lib/api-client";
import {
  mergeMigrationJob,
  normalizeMigrationJob,
  normalizeMigrationProgressEvent,
  safeMigrationOperationText,
} from "./migrations-surface-helpers";
import { isMigrationAuthFailureMessage } from "./failure-classification";

const POLL_FALLBACK_MS = 2000;
const SSE_CLOSED_TIMEOUT_MS = 6000;
type ProgressStreamStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "polling";

interface Props {
  jobId: string;
  source?: MigrationSource;
  /** Source label, e.g. "Mailchimp". */
  sourceLabel: string;
  onComplete: (done: MigrationDoneEvent) => void;
  onCancel?: () => void;
}

export function ProgressView({
  jobId,
  source,
  sourceLabel,
  onComplete,
  onCancel,
}: Props): ReactElement {
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [latestStep, setLatestStep] = useState<string>("Starting…");
  const [activeResource, setActiveResource] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [streamStatus, setStreamStatus] =
    useState<ProgressStreamStatus>("connecting");
  const [streamInterrupted, setStreamInterrupted] = useState(false);
  const [streamNonce, setStreamNonce] = useState(0);
  const jobRef = useRef<MigrationJob | null>(null);
  const seqRef = useRef(0);
  const completedRef = useRef(false);
  const sseClosedAtRef = useRef<number | null>(null);
  const surfaceGenerationRef = useRef(0);
  const streamGenerationRef = useRef(0);
  const onCompleteRef = useRef(onComplete);
  const onCancelRef = useRef(onCancel);
  const sourceRef = useRef(source);
  onCompleteRef.current = onComplete;
  onCancelRef.current = onCancel;
  sourceRef.current = source;

  useEffect(() => {
    const generation = ++surfaceGenerationRef.current;
    completedRef.current = false;
    sseClosedAtRef.current = null;
    seqRef.current = 0;
    jobRef.current = null;
    setJob(null);
    setLatestStep("Starting…");
    setActiveResource(null);
    setActivity([]);
    setStreamStatus("connecting");
    setStreamInterrupted(false);
    setStreamNonce(0);
    return () => {
      if (surfaceGenerationRef.current === generation) {
        surfaceGenerationRef.current += 1;
      }
    };
  }, [jobId]);

  const pushActivity = useCallback((message: string, at?: string): void => {
    const id = ++seqRef.current;
    const timestamp = at ?? new Date().toISOString();
    setActivity((prev) =>
      prev
        .concat({
          id,
          at: timestamp,
          message,
        })
        .slice(-100),
    );
  }, []);
  const cancellation = useMigrationCancellation({
    jobId,
    completedRef,
    surfaceGenerationRef,
    pushActivity,
    onAcknowledged: () => onCancelRef.current?.(),
  });

  const handleSnapshot = useCallback(
    (snap: MigrationJob): void => {
      const parsed = normalizeMigrationJob(snap);
      if (!parsed || parsed.id !== jobId) return;
      const normalized = withSafeTerminalError(parsed, snap);
      const merged = jobRef.current
        ? mergeMigrationJob(jobRef.current, normalized)
        : normalized;
      jobRef.current = merged;
      setJob(merged);
      if (
        merged.status === "completed" ||
        merged.status === "failed" ||
        merged.status === "rolled_back"
      ) {
        if (!completedRef.current) {
          completedRef.current = true;
          onCompleteRef.current({
            status: merged.status,
            // Polling snapshots do not carry exact terminal resource outcomes.
            // An empty record means "not reported"; unfinished rows are never
            // reconstructed as skipped work.
            resources: {},
            job: merged,
            ...(merged.status === "failed"
              ? { error: safeTerminalFailure(merged) }
              : {}),
          });
        }
      }
    },
    [jobId],
  );

  const handleProgress = useCallback(
    (evt: MigrationProgressEvent): void => {
      const normalized = normalizeMigrationProgressEvent(evt);
      if (!normalized) {
        setStreamInterrupted(true);
        return;
      }
      const displayStep = migrationProgressStep(sourceRef.current, normalized);
      setLatestStep(displayStep);
      setActiveResource(normalized.resource);
      pushActivity(
        `${displayStep} (${normalized.completed.toLocaleString()}${
          normalized.total > 0 ? ` of ${normalized.total.toLocaleString()}` : ""
        })`,
        normalized.at,
      );
      const current = jobRef.current;
      if (current) {
        const merged = mergeMigrationJob(current, {
          ...current,
          progress: normalized.snapshot,
        });
        jobRef.current = merged;
        setJob(merged);
      }
    },
    [pushActivity],
  );

  const handleDone = useCallback(
    (evt: MigrationDoneEvent): void => {
      if (completedRef.current) return;
      const parsed = normalizeMigrationJob(evt.job);
      if (!parsed || parsed.id !== jobId) {
        setStreamInterrupted(true);
        return;
      }
      const normalized = withSafeTerminalError(parsed, evt.job);
      const resources = normalizeMigrationDoneResources(evt.resources);
      if (
        resources === null ||
        !["completed", "failed", "rolled_back"].includes(normalized.status) ||
        evt.status !== normalized.status
      ) {
        setStreamInterrupted(true);
        pushActivity(
          "A terminal event could not be verified. Waiting for a matching job snapshot.",
        );
        return;
      }
      const merged = jobRef.current
        ? mergeMigrationJob(jobRef.current, normalized)
        : normalized;
      if (merged.status !== evt.status) {
        setStreamInterrupted(true);
        pushActivity(
          "A stale terminal event was ignored. Waiting for a newer verified job snapshot.",
        );
        return;
      }
      completedRef.current = true;
      pushActivity(
        merged.status === "completed"
          ? "Migration complete."
          : merged.status === "failed"
            ? "Migration stopped before completion. Provider detail is withheld."
            : "Migration reached a terminal state.",
      );
      jobRef.current = merged;
      setJob(merged);
      onCompleteRef.current({
        status: merged.status,
        resources,
        job: merged,
        ...(merged.status === "failed"
          ? { error: safeTerminalFailure(merged) }
          : {}),
      });
    },
    [jobId, pushActivity],
  );

  // Bring up the SSE stream. The wrapper retries automatically; we
  // still mount a polling fallback below for environments where SSE is
  // permanently blocked (corporate proxy, mobile webview).
  useEffect(() => {
    const generation = ++streamGenerationRef.current;
    let disconnect = (): void => undefined;
    try {
      disconnect = connectMigrationEvents(jobId, {
        onSnapshot: (snapshot) => {
          if (streamGenerationRef.current === generation) {
            handleSnapshot(snapshot);
          }
        },
        onProgress: (event) => {
          if (streamGenerationRef.current === generation) {
            handleProgress(event);
          }
        },
        onDone: (event) => {
          if (streamGenerationRef.current === generation) {
            handleDone(event);
          }
        },
        onError: () => {
          if (streamGenerationRef.current !== generation) return;
          setStreamInterrupted(true);
          pushActivity(
            "Live progress was interrupted. The client will reconnect or use verified polling.",
          );
        },
        onStatus: (status) => {
          if (streamGenerationRef.current !== generation) return;
          setStreamStatus(status);
          if (status === "closed" || status === "reconnecting") {
            sseClosedAtRef.current = sseClosedAtRef.current ?? Date.now();
          } else if (status === "open") {
            sseClosedAtRef.current = null;
            setStreamInterrupted(false);
          }
        },
      });
    } catch {
      setStreamInterrupted(true);
      setStreamStatus("reconnecting");
      sseClosedAtRef.current = Date.now();
    }
    return () => {
      streamGenerationRef.current += 1;
      disconnect();
    };
  }, [
    handleDone,
    handleProgress,
    handleSnapshot,
    jobId,
    pushActivity,
    streamNonce,
  ]);

  // Polling fallback. Fires only when the stream has been closed /
  // reconnecting for ≥ SSE_CLOSED_TIMEOUT_MS. Polls every 2s.
  //
  // streamStatus is intentionally NOT in the deps array even though
  // the body reads it. Including it caused the timer chain to be torn
  // down and re-created on every status transition (connecting →
  // open → reconnecting), which spun up overlapping setTimeout chains
  // — each calling handleSnapshot independently — and the manual
  // setStreamStatus("polling") below caused its own re-fire. Reading
  // the value through a ref captures the latest state without
  // re-subscribing the effect.
  const streamStatusRef = useRef(streamStatus);
  useEffect(() => {
    streamStatusRef.current = streamStatus;
  }, [streamStatus]);

  useMigrationPollingFallback({
    jobId,
    completedRef,
    surfaceGenerationRef,
    sseClosedAtRef,
    streamStatusRef,
    handleSnapshot,
    setStreamStatus,
    setStreamInterrupted,
  });

  const displaySource = job?.source ?? source;
  const overallPct = useMemo(
    () => (job?.progress ? computePercent(job.progress, displaySource) : null),
    [job?.progress, displaySource],
  );

  return (
    <MigrationProgressContent
      jobId={jobId}
      sourceLabel={sourceLabel}
      job={job}
      displaySource={displaySource}
      latestStep={latestStep}
      activeResource={activeResource}
      activity={activity}
      streamStatus={streamStatus}
      streamInterrupted={streamInterrupted}
      overallPct={overallPct}
      cancellation={cancellation}
      onReconnect={() => setStreamNonce((value) => value + 1)}
    />
  );
}

interface MigrationCancellationController {
  active: boolean;
  error: string | null;
  dialogOpen: boolean;
  reasonId: string;
  openDialog: () => void;
  closeDialog: () => void;
  confirm: () => void;
}

function MigrationProgressContent({
  jobId,
  sourceLabel,
  job,
  displaySource,
  latestStep,
  activeResource,
  activity,
  streamStatus,
  streamInterrupted,
  overallPct,
  cancellation,
  onReconnect,
}: {
  jobId: string;
  sourceLabel: string;
  job: MigrationJob | null;
  displaySource: MigrationSource | undefined;
  latestStep: string;
  activeResource: string | null;
  activity: ActivityEntry[];
  streamStatus: ProgressStreamStatus;
  streamInterrupted: boolean;
  overallPct: number | null;
  cancellation: MigrationCancellationController;
  onReconnect: () => void;
}): ReactElement {
  const progress = job?.progress;
  return (
    <div className="migration-progress-view">
      <div>
        <div className="migration-job-identity">
          Importing from {sourceLabel} · exact job <code>{jobId}</code>
        </div>
        <div className="migration-progress-summary">
          <span>{latestStep}</span>
          <span className="migration-stream-summary">
            <span className="tabular muted">
              {overallPct === null ? "Progress pending" : `${overallPct}%`} ·{" "}
              {streamLabel(streamStatus)}
            </span>
            {streamInterrupted ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onReconnect}
              >
                Reconnect live updates
              </button>
            ) : null}
          </span>
        </div>
        <div
          className="wizard-progress-bar"
          role="progressbar"
          aria-label="Overall migration progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={overallPct ?? undefined}
          aria-valuetext={
            overallPct === null
              ? "Waiting for verified progress counters"
              : displaySource === "customerio"
                ? `${overallPct}% of supported import and source-evidence work reported complete`
                : `${overallPct}% of supported runtime work reported complete`
          }
        >
          <div
            className={`wizard-progress-fill ${overallPct === null ? "is-indeterminate" : ""}`}
            style={{ width: overallPct === null ? "30%" : `${overallPct}%` }}
          />
        </div>
      </div>

      <MigrationResourceProgress
        progress={progress}
        source={displaySource}
        activeResource={activeResource}
        latestStep={latestStep}
      />
      <ActivityLog events={activity} />

      {cancellation.error ? (
        <div className="field-error" role="alert">
          {cancellation.error}
        </div>
      ) : null}
      <div className="migration-progress-actions">
        <button
          type="button"
          className="btn btn-danger"
          aria-disabled={cancellation.active || undefined}
          aria-busy={cancellation.active || undefined}
          aria-describedby={
            cancellation.active ? cancellation.reasonId : undefined
          }
          onClick={() => {
            if (!cancellation.active) cancellation.openDialog();
          }}
        >
          {cancellation.active ? "Cancelling…" : "Cancel migration"}
        </button>
      </div>
      {cancellation.active ? (
        <p
          id={cancellation.reasonId}
          className="migration-action-reason"
          role="status"
        >
          A cancellation acknowledgement is already pending. The action cannot
          be submitted again until it settles.
        </p>
      ) : null}
      <MigrationDestructiveDialog
        open={cancellation.dialogOpen}
        kind="cancel"
        jobId={jobId}
        sourceLabel={sourceLabel}
        busy={cancellation.active}
        importedSubscribers={job?.progress?.subscribers_done}
        rollbackDeadline={job?.rollback_until}
        onConfirm={cancellation.confirm}
        onClose={cancellation.closeDialog}
      />
    </div>
  );
}

function MigrationResourceProgress({
  progress,
  source,
  activeResource,
  latestStep,
}: {
  progress: MigrationProgress | undefined;
  source: MigrationSource | undefined;
  activeResource: string | null;
  latestStep: string;
}): ReactElement | null {
  if (!progress) return null;
  return (
    <div className="migration-resource-progress-list">
      <ResourceProgressBar
        resource="Subscribers"
        completed={progress.subscribers_done ?? 0}
        total={progress.subscribers_total ?? 0}
        {...(activeResource === "subscribers" ? { step: latestStep } : {})}
      />
      <ResourceProgressBar
        resource={
          source === "beehiiv"
            ? "Frozen segment/list snapshots"
            : source === "customerio"
              ? "Frozen segment/topic membership snapshots"
              : "Segments"
        }
        completed={progress.segments_done ?? 0}
        total={progress.segments_total ?? 0}
        {...(activeResource === "segments" ? { step: latestStep } : {})}
      />
      <ResourceProgressBar
        resource={automationProgressLabel(source)}
        completed={automationProgressDone(progress, source)}
        total={progress.automations_total ?? 0}
        valueLabel={automationProgressValueLabel(progress, source)}
        {...(activeResource === "automations" ? { step: latestStep } : {})}
      />
      <ResourceProgressBar
        resource={
          source === "klaviyo"
            ? "Sent email campaign archive"
            : source === "customerio"
              ? "Sent email newsletter archive"
              : "Campaign archive"
        }
        completed={progress.archive_done ?? 0}
        total={progress.archive_total ?? 0}
        {...(activeResource === "archive" ? { step: latestStep } : {})}
      />
      {source !== "customerio" ? (
        <ResourceProgressBar
          resource={
            source === "beehiiv"
              ? "Premium memberships (metadata only)"
              : "Paid Stripe subs"
          }
          completed={progress.paid_subs_done ?? 0}
          total={progress.paid_subs_total ?? 0}
          valueLabel={
            source === "beehiiv"
              ? `${(progress.paid_subs_total ?? 0).toLocaleString()} metadata records; no Stripe billing`
              : undefined
          }
          {...(activeResource === "paid_subs" ? { step: latestStep } : {})}
        />
      ) : null}
      {source === "customerio" ? (
        <>
          <ResourceProgressBar
            resource="Exact-source Design Studio email templates"
            completed={progress.templates_done ?? 0}
            total={progress.templates_total ?? 0}
            {...(activeResource === "templates" ? { step: latestStep } : {})}
          />
          <ResourceProgressBar
            resource="Customer.io source evidence"
            completed={progress.source_archive_done ?? 0}
            total={progress.source_archive_total ?? 0}
            valueLabel={`${(progress.source_archive_total ?? 0).toLocaleString()} workflow, transactional, channel, preference, object, and ecosystem records`}
            {...(activeResource === "source_archive"
              ? { step: latestStep }
              : {})}
          />
        </>
      ) : null}
    </div>
  );
}

function useMigrationPollingFallback({
  jobId,
  completedRef,
  surfaceGenerationRef,
  sseClosedAtRef,
  streamStatusRef,
  handleSnapshot,
  setStreamStatus,
  setStreamInterrupted,
}: {
  jobId: string;
  completedRef: RefObject<boolean>;
  surfaceGenerationRef: RefObject<number>;
  sseClosedAtRef: RefObject<number | null>;
  streamStatusRef: RefObject<ProgressStreamStatus>;
  handleSnapshot: (job: MigrationJob) => void;
  setStreamStatus: Dispatch<SetStateAction<ProgressStreamStatus>>;
  setStreamInterrupted: Dispatch<SetStateAction<boolean>>;
}): void {
  useEffect(() => {
    const generation = surfaceGenerationRef.current;
    let timer: number | null = null;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (
        cancelled ||
        completedRef.current ||
        surfaceGenerationRef.current !== generation
      ) {
        return;
      }
      const closedAt = sseClosedAtRef.current;
      if (closedAt && Date.now() - closedAt > SSE_CLOSED_TIMEOUT_MS) {
        try {
          const result = await Promise.resolve().then(() =>
            api.getMigration(jobId),
          );
          if (
            cancelled ||
            surfaceGenerationRef.current !== generation ||
            completedRef.current
          ) {
            return;
          }
          if (!result.error) {
            handleSnapshot(result.data);
            if (streamStatusRef.current !== "polling") {
              setStreamStatus("polling");
            }
          } else {
            setStreamInterrupted(true);
          }
        } catch {
          if (!cancelled && surfaceGenerationRef.current === generation) {
            setStreamInterrupted(true);
          }
        }
      }
      if (
        !cancelled &&
        !completedRef.current &&
        surfaceGenerationRef.current === generation
      ) {
        timer = window.setTimeout(() => void tick(), POLL_FALLBACK_MS);
      }
    };
    timer = window.setTimeout(() => void tick(), POLL_FALLBACK_MS);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [
    completedRef,
    handleSnapshot,
    jobId,
    setStreamInterrupted,
    setStreamStatus,
    sseClosedAtRef,
    streamStatusRef,
    surfaceGenerationRef,
  ]);
}

function useMigrationCancellation({
  jobId,
  completedRef,
  surfaceGenerationRef,
  pushActivity,
  onAcknowledged,
}: {
  jobId: string;
  completedRef: RefObject<boolean>;
  surfaceGenerationRef: RefObject<number>;
  pushActivity: (message: string, at?: string) => void;
  onAcknowledged: () => void;
}): MigrationCancellationController {
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const operation = useSingleFlightOperation({
    ownerId: `migration-progress-cancel-${jobId}`,
    label: "Cancel migration",
    detail:
      "Wait for the migration cancellation acknowledgement before leaving Moosewave.",
  });
  const reasonId = useId();
  const acknowledgedRef = useRef(onAcknowledged);
  acknowledgedRef.current = onAcknowledged;

  useEffect(() => {
    setError(null);
    setDialogOpen(false);
  }, [jobId]);

  const confirm = (): void => {
    if (operation.promiseRef.current || completedRef.current) return;
    const generation = surfaceGenerationRef.current;
    setError(null);
    pushActivity("Cancellation requested…");
    const flight = operation.run(async () => {
      const result = await Promise.resolve().then(() => cancelMigration(jobId));
      if (result.error) throw result.error;
      if (
        result.data.job_id !== jobId ||
        typeof result.data.cancelled !== "boolean" ||
        !isCancellationAckStatus(result.data.status)
      ) {
        throw {
          kind: "parse",
          code: "migration_cancel_invalid_ack",
        };
      }
      return result.data;
    });
    if (!flight) return;
    void flight
      .then((acknowledgement) => {
        if (surfaceGenerationRef.current !== generation) return;
        setDialogOpen(false);
        setError(null);
        pushActivity(
          acknowledgement.cancelled
            ? "Cancellation acknowledged. Waiting for the durable terminal snapshot."
            : "The server accepted the request but reported no new cancellation. Refreshing job state.",
        );
        acknowledgedRef.current();
      })
      .catch((caught: unknown) => {
        if (surfaceGenerationRef.current !== generation) return;
        setError(safeMigrationOperationText(caught, "Cancellation"));
        pushActivity(
          "Cancellation was not confirmed. The migration may still be running.",
        );
      });
  };

  return {
    active: operation.active,
    error,
    dialogOpen,
    reasonId,
    openDialog: () => {
      if (!operation.promiseRef.current) setDialogOpen(true);
    },
    closeDialog: () => {
      if (!operation.promiseRef.current) setDialogOpen(false);
    },
    confirm,
  };
}

function streamLabel(s: ProgressStreamStatus): string {
  switch (s) {
    case "open":
      return "live";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "polling":
      return "polling";
    case "closed":
      return "closed";
  }
}

export function computeMigrationPercent(
  p: MigrationProgress | undefined,
  source?: MigrationSource,
): number | null {
  if (!p) return null;
  let totals = 0;
  let done = 0;
  const buckets: Array<[number, number]> = [
    [p.subscribers_done ?? 0, p.subscribers_total ?? 0],
    [p.segments_done ?? 0, p.segments_total ?? 0],
    [p.archive_done ?? 0, p.archive_total ?? 0],
  ];
  if (
    source !== "beehiiv" &&
    source !== "activecampaign" &&
    source !== "klaviyo" &&
    source !== "customerio"
  ) {
    buckets.push([automationProgressDone(p, source), p.automations_total ?? 0]);
  }
  if (source !== "beehiiv" && source !== "customerio") {
    buckets.push([p.paid_subs_done ?? 0, p.paid_subs_total ?? 0]);
  }
  if (source === "customerio") {
    buckets.push(
      [p.templates_done ?? 0, p.templates_total ?? 0],
      [p.source_archive_done ?? 0, p.source_archive_total ?? 0],
    );
  }
  for (const [d, t] of buckets) {
    if (!Number.isFinite(d) || !Number.isFinite(t) || d < 0 || t < 0) {
      continue;
    }
    if (d > t) return null;
    if (t === 0) continue;
    totals += t;
    done += d;
  }
  if (totals <= 0) return null;
  return Math.max(0, Math.min(99, Math.round((done / totals) * 100)));
}

export function deriveMigrationDoneResources(
  p: MigrationProgress | undefined,
  source?: MigrationSource,
): MigrationDoneEvent["resources"] {
  const safe = (n?: number): number => n ?? 0;
  // The progress snapshot only tells us done vs total — it carries no
  // per-row outcome. Rows that were never attempted (e.g. the operator
  // cancelled mid-run) are NOT failures, so the remainder is reported
  // as `skipped`. Real per-row failure counts only arrive on the
  // server's `done` event; this derivation is the fallback path for
  // snapshot-detected terminal states.
  const total = (
    imported: number,
    grand: number,
  ): { imported: number; skipped: number; failed: number } => ({
    imported,
    skipped: Math.max(0, grand - imported),
    failed: 0,
  });
  const activeCampaignAutomationTotal = safe(p?.automations_total);
  const activeCampaignAutomationImported = safe(p?.automations_done);
  const activeCampaignAutomationReview = Math.max(
    0,
    activeCampaignAutomationTotal - activeCampaignAutomationImported,
  );
  return {
    subscribers: total(safe(p?.subscribers_done), safe(p?.subscribers_total)),
    segments: total(safe(p?.segments_done), safe(p?.segments_total)),
    automations:
      source === "customerio"
        ? {
            imported: 0,
            skipped: activeCampaignAutomationTotal,
            failed: 0,
            review: activeCampaignAutomationTotal,
          }
        : source === "activecampaign" ||
            source === "beehiiv" ||
            source === "klaviyo"
          ? {
              imported: activeCampaignAutomationImported,
              skipped: activeCampaignAutomationReview,
              failed: 0,
              review: activeCampaignAutomationReview,
            }
          : total(safe(p?.automations_done), safe(p?.automations_total)),
    archive: total(safe(p?.archive_done), safe(p?.archive_total)),
    paid_subs: total(safe(p?.paid_subs_done), safe(p?.paid_subs_total)),
    templates: total(safe(p?.templates_done), safe(p?.templates_total)),
    source_archive: total(
      safe(p?.source_archive_done),
      safe(p?.source_archive_total),
    ),
  };
}

function computePercent(
  p: MigrationProgress | undefined,
  source?: MigrationSource,
): number | null {
  return computeMigrationPercent(p, source);
}

export function normalizeMigrationDoneResources(
  value: unknown,
): Record<string, MigrationDoneResourceCounts> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) return null;
  const normalized: Record<string, MigrationDoneResourceCounts> = {};
  for (const [resource, raw] of entries) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/u.test(resource) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      return null;
    }
    const counts = raw as Record<string, unknown>;
    const imported = safeDoneCount(counts.imported);
    const skipped = safeDoneCount(counts.skipped);
    const failed = safeDoneCount(counts.failed);
    const review =
      counts.review === undefined ? undefined : safeDoneCount(counts.review);
    if (
      imported === null ||
      skipped === null ||
      failed === null ||
      (counts.review !== undefined && review === null)
    ) {
      return null;
    }
    normalized[resource] = {
      imported,
      skipped,
      failed,
      ...(typeof review === "number" ? { review } : {}),
    };
  }
  return normalized;
}

function safeDoneCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function automationProgressLabel(source?: MigrationSource): string {
  if (source === "beehiiv") return "Beehiiv automation rebuild inventory";
  if (source === "klaviyo") return "Klaviyo flow rebuild inventory";
  if (source === "customerio") return "Customer.io workflow rebuild inventory";
  return source === "activecampaign" ? "Automation rebuilds" : "Sequences";
}

export function automationProgressDone(
  p: MigrationProgress,
  _source?: MigrationSource,
): number {
  return p.automations_done ?? 0;
}

export function automationProgressValueLabel(
  p: MigrationProgress,
  source?: MigrationSource,
): string | undefined {
  if (source === "beehiiv") {
    return `${(p.automations_total ?? 0).toLocaleString()} to rebuild or retire`;
  }
  if (source === "klaviyo") {
    return `${(p.automations_total ?? 0).toLocaleString()} to rebuild or retire`;
  }
  if (source === "customerio") {
    return `${(p.automations_total ?? 0).toLocaleString()} to rebuild or retire`;
  }
  if (source !== "activecampaign") return undefined;
  return `${(p.automations_total ?? 0).toLocaleString()} to review`;
}

export function migrationProgressStep(
  source: MigrationSource | undefined,
  event: Pick<MigrationProgressEvent, "resource" | "completed" | "total"> &
    Partial<Pick<MigrationProgressEvent, "current_step">>,
): string {
  if (source === "beehiiv" && event.resource === "automations") {
    return event.total > 0 && event.completed < event.total
      ? "Preserving Beehiiv automation rebuild evidence"
      : "Beehiiv automation rebuild inventory complete";
  }
  if (source === "klaviyo" && event.resource === "automations") {
    return event.total > 0 && event.completed < event.total
      ? "Preserving Klaviyo flow rebuild evidence"
      : "Klaviyo flow rebuild inventory complete";
  }
  if (source === "customerio" && event.resource === "automations") {
    return event.total > 0 && event.completed < event.total
      ? "Preserving Customer.io workflow rebuild evidence"
      : "Customer.io workflow rebuild inventory complete";
  }
  switch (event.resource) {
    case "subscribers":
      return "Importing subscribers";
    case "segments":
      return source === "beehiiv"
        ? "Preserving frozen segment and list snapshots"
        : source === "customerio"
          ? "Preserving frozen segment and subscription-topic membership snapshots"
          : "Translating segments and tags";
    case "automations":
      return source === "activecampaign"
        ? "Preserving automation rebuild evidence"
        : "Importing supported automation records";
    case "archive":
      return source === "klaviyo"
        ? "Preserving sent email campaign archive records"
        : source === "customerio"
          ? "Preserving sent email newsletter archive records"
          : "Preserving campaign archive records";
    case "paid_subs":
      return source === "beehiiv"
        ? "Preserving premium membership metadata"
        : "Importing supported paid-subscription links";
    case "templates":
      return source === "customerio"
        ? "Importing exact-source Design Studio email templates"
        : "Preserving template evidence";
    case "source_archive":
      return source === "klaviyo"
        ? "Preserving SMS/push, identity-consent, rebuild, and static checklist evidence"
        : source === "customerio"
          ? "Preserving workflow, transactional, channel, preference, object, and ecosystem source evidence"
          : "Preserving source archive evidence";
    case "all":
      return "Finalizing migration verification";
  }
}

function safeTerminalFailure(job: MigrationJob): string {
  const message = typeof job.error === "string" ? job.error : "";
  if (/cancel/i.test(message)) return "migration cancelled by operator";
  if (isMigrationAuthFailureMessage(message)) {
    return "migration authorization failed";
  }
  if (
    /unreachable|HTTP\s*5\d\d|status\s*5\d\d|5\d\d\s*(response|error)|timeout|temporarily\s+unavailable/i.test(
      message,
    )
  ) {
    return "migration source temporarily unavailable";
  }
  return "Migration failure detail withheld";
}

function withSafeTerminalError(
  normalized: MigrationJob,
  raw: MigrationJob,
): MigrationJob {
  return normalized.status === "failed"
    ? { ...normalized, error: safeTerminalFailure(raw) }
    : normalized;
}

function isCancellationAckStatus(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [
      "pending",
      "authenticating",
      "discovering",
      "dry_run",
      "awaiting_confirmation",
      "importing",
      "failed",
      "completed",
      "rolling_back",
      "rolled_back",
      "cancelled",
      "cancelling",
    ].includes(value)
  );
}
