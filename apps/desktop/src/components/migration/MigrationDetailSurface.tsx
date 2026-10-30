import { type ReactElement, useEffect, useRef, useState } from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  type MigrationJob,
  type MigrationProgress,
  type MigrationProgressEvent,
  connectMigrationEvents,
} from "../../lib/api-client";
import { getDashboardUrl } from "../../lib/dashboard-url";
import { findSource } from "../../lib/migration-sources";
import { setSection } from "../../lib/store";
import { tauriApi } from "../../lib/tauri";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { isCancelledJob } from "./cancelledJob";
import {
  MigrationProgressMeter,
  MigrationStatusBadge,
  SourceIdentity,
  TimeEvidence,
} from "./MigrationHistorySurface";
import { MigrationVerificationEvidence } from "./MigrationVerificationEvidence";
import { MigrationSourceSessionRecovery } from "./MigrationSourceSessionRecovery";
import {
  decodeExactMigrationJob,
  migrationSourceSessionHealth,
  type MigrationSourceSessionHealth as SourceSessionHealthState,
} from "./migration-source-session";
import {
  formatMigrationCount,
  isKnownMigrationResource,
  isMigrationCancellable,
  isMigrationInFlight,
  mergeMigrationJob,
  migrationOverallProgress,
  migrationResourceLabel,
  migrationRollbackEligibility,
  normalizeMigrationProgress,
  parseMigrationTime,
  type MigrationStreamStatus,
} from "./migrations-surface-helpers";
import { useMigrationClock } from "./useMigrationClock";

interface MigrationDetailSurfaceProps {
  job: MigrationJob;
  canAdmin: boolean;
  listVerifiedAt: number | null;
  listStale: boolean;
  refreshing: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onRollback: () => void;
  onCancel: () => void;
  onResume: () => void;
  onSnapshot: (job: MigrationJob) => void;
}

interface CheckpointEvent {
  resource: MigrationProgressEvent["resource"];
  completed: number;
  total: number;
  snapshot: MigrationProgress;
  at: string;
}

export function MigrationDetailSurface({
  job,
  canAdmin,
  listVerifiedAt,
  listStale,
  refreshing,
  onClose,
  onRefresh,
  onRollback,
  onCancel,
  onResume,
  onSnapshot,
}: MigrationDetailSurfaceProps): ReactElement {
  const now = useMigrationClock();
  const [live, setLive] = useState(job);
  const [streamStatus, setStreamStatus] =
    useState<MigrationStreamStatus>("idle");
  const [streamInterrupted, setStreamInterrupted] = useState(false);
  const [lastCheckpoint, setLastCheckpoint] = useState<CheckpointEvent | null>(
    null,
  );
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const streamGenerationRef = useRef(0);
  const snapshotRef = useRef(onSnapshot);
  snapshotRef.current = onSnapshot;

  useEffect(() => {
    setLive((current) =>
      current.id === job.id ? mergeMigrationJob(current, job) : job,
    );
    if (live.id !== job.id) {
      setLastCheckpoint(null);
      setStreamInterrupted(false);
    }
  }, [job, live.id]);

  const terminal = !isMigrationInFlight(live.status);
  useEffect(() => {
    const generation = ++streamGenerationRef.current;
    if (terminal) {
      setStreamStatus("idle");
      return;
    }
    setStreamStatus("connecting");
    setStreamInterrupted(false);
    let disconnect = (): void => undefined;
    try {
      disconnect = connectMigrationEvents(live.id, {
        onStatus: (status) => {
          if (streamGenerationRef.current === generation) {
            setStreamStatus(status);
            if (status === "open") setStreamInterrupted(false);
          }
        },
        onSnapshot: (snapshot) => {
          if (streamGenerationRef.current !== generation) return;
          const normalized = decodeExactMigrationJob(snapshot, live);
          if (!normalized) return;
          setLive((current) => mergeMigrationJob(current, normalized));
          snapshotRef.current(normalized);
        },
        onProgress: (event) => {
          if (streamGenerationRef.current !== generation) return;
          const checkpoint = normalizeCheckpointEvent(event);
          if (!checkpoint) return;
          setLastCheckpoint(checkpoint);
          setLive((current) =>
            mergeMigrationJob(current, {
              ...current,
              progress: checkpoint.snapshot,
            }),
          );
        },
        onDone: (event) => {
          if (streamGenerationRef.current !== generation) return;
          const normalized = decodeExactMigrationJob(event.job, live);
          if (!normalized) return;
          if (
            !["completed", "failed", "rolled_back"].includes(
              normalized.status,
            ) ||
            event.status !== normalized.status
          ) {
            setStreamInterrupted(true);
            return;
          }
          setLive((current) => mergeMigrationJob(current, normalized));
          snapshotRef.current(normalized);
          setStreamStatus("closed");
        },
        onError: () => {
          if (streamGenerationRef.current !== generation) return;
          setStreamInterrupted(true);
        },
      });
    } catch {
      setStreamInterrupted(true);
      setStreamStatus("reconnecting");
    }
    return () => {
      streamGenerationRef.current += 1;
      disconnect();
    };
  }, [live.id, reconnectNonce, terminal]);

  const rollback = migrationRollbackEligibility(live, canAdmin, now);
  const cancelled = isCancelledJob(live);
  const overall = migrationOverallProgress(live.progress, live.source);
  const sourceName = findSource(live.source)?.name ?? "Unknown source";
  const sourceSessionHealth = migrationSourceSessionHealth(live, now);

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`${sourceName} migration`}
      description={`Verified job identifier ${live.id}`}
      size="xl"
    >
      <div className="migration-detail">
        <div className="migration-detail-toolbar">
          <div className="migration-detail-status">
            <MigrationStatusBadge status={live.status} />
            {isMigrationInFlight(live.status) ? (
              <StreamHealth
                status={streamStatus}
                interrupted={streamInterrupted}
                lastCheckpoint={lastCheckpoint}
                onReconnect={() => setReconnectNonce((value) => value + 1)}
              />
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={refreshing || undefined}
            aria-describedby={
              refreshing ? "migration-detail-refresh-reason" : undefined
            }
            onClick={() => {
              if (!refreshing) onRefresh();
            }}
          >
            {refreshing ? "Refreshing…" : "Refresh snapshot"}
          </button>
        </div>
        {refreshing ? (
          <p
            id="migration-detail-refresh-reason"
            className="migration-action-reason"
          >
            A verified history refresh is already in progress.
          </p>
        ) : null}

        <MigrationProvenance
          job={live}
          listVerifiedAt={listVerifiedAt}
          listStale={listStale}
          rollbackDeadline={rollback.deadline}
        />

        <SourceSessionHealth health={sourceSessionHealth} />

        {sourceSessionHealth.blocksAction ? (
          <MigrationSourceSessionRecovery
            job={live}
            health={sourceSessionHealth}
            canAdmin={canAdmin}
            onVerifiedJob={(verified) => {
              setLive((current) => mergeMigrationJob(current, verified));
              snapshotRef.current(verified);
            }}
          />
        ) : null}

        {live.progress ? (
          <MigrationProgressEvidence
            job={live}
            overall={overall}
            lastCheckpoint={lastCheckpoint}
          />
        ) : (
          <div className="migration-empty-panel" role="status">
            <strong>No progress counters have been verified yet.</strong>
            <span>
              Status is available, but totals and checkpoints remain pending. No
              zero-count assumption has been made.
            </span>
          </div>
        )}

        <CheckpointEvidence job={live} lastCheckpoint={lastCheckpoint} />

        {cancelled ? (
          <CancelledMigrationRecovery
            job={live}
            canAdmin={canAdmin}
            sourceSessionHealth={sourceSessionHealth}
            onClose={onClose}
            onResume={onResume}
          />
        ) : live.status === "failed" ? (
          <div className="migration-truth-callout is-limited" role="alert">
            <strong>Migration stopped before completion.</strong>
            <span>
              Provider or server detail is intentionally withheld from this
              client surface. Review verification evidence and use job{" "}
              <code>{live.id}</code> as the support reference before retrying.
            </span>
          </div>
        ) : null}

        <MigrationVerificationEvidence job={live} />

        <MigrationDetailActions
          job={live}
          canAdmin={canAdmin}
          rollbackAllowed={rollback.allowed}
          rollbackReason={rollback.reason}
          onCancel={onCancel}
          onRollback={onRollback}
        />
      </div>

      <ModalFooter>
        {live.source === "beehiiv" && live.status === "completed" ? (
          <BeehiivCutoverAction jobId={live.id} />
        ) : null}
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

function SourceSessionHealth({
  health,
}: {
  health: SourceSessionHealthState;
}): ReactElement | null {
  if (health.kind === "healthy") return null;
  const title =
    health.kind === "missing"
      ? "Source authorization could not be verified."
      : health.kind === "expired"
        ? "Source authorization has expired."
        : "Source authorization is inside the cutover safety window.";
  return (
    <div className="migration-truth-callout is-limited" role="alert">
      <strong>{title}</strong>
      <span>{health.message}</span>
    </div>
  );
}

function MigrationProvenance({
  job,
  listVerifiedAt,
  listStale,
  rollbackDeadline,
}: {
  job: MigrationJob;
  listVerifiedAt: number | null;
  listStale: boolean;
  rollbackDeadline: string | null;
}): ReactElement {
  return (
    <section aria-labelledby="migration-provenance-heading">
      <div className="migration-section-heading">
        <div>
          <h3 id="migration-provenance-heading">Job provenance</h3>
          <p>
            Identifiers and server timestamps are shown in full for audit
            evidence.
          </p>
        </div>
      </div>
      <dl className="migration-kv-list">
        <KeyValue label="Source">
          <SourceIdentity source={job.source} />
        </KeyValue>
        <KeyValue label="Job identifier">
          <code>{job.id}</code>
        </KeyValue>
        <KeyValue label="Started">
          <TimeEvidence value={job.started_at} />
        </KeyValue>
        {job.completed_at ? (
          <KeyValue label="Completed">
            <TimeEvidence value={job.completed_at} />
          </KeyValue>
        ) : null}
        {job.source_session_expires_at ? (
          <KeyValue label="Source authorization expiry">
            <TimeEvidence value={job.source_session_expires_at} />
          </KeyValue>
        ) : null}
        <KeyValue label="Selected source audiences">
          {Array.isArray(job.selected_audience_ids) &&
          job.selected_audience_ids.length > 0 ? (
            <span className="migration-id-list">
              {job.selected_audience_ids.map((audienceId) => (
                <code key={audienceId}>{audienceId}</code>
              ))}
            </span>
          ) : (
            "No audience identifiers reported"
          )}
        </KeyValue>
        {rollbackDeadline ? (
          <KeyValue label="Rollback deadline">
            <TimeEvidence value={rollbackDeadline} />
          </KeyValue>
        ) : (
          <KeyValue label="Rollback deadline">Not verified</KeyValue>
        )}
        <KeyValue label="List snapshot provenance">
          {listVerifiedAt === null ? (
            "Verification pending"
          ) : (
            <span>
              Server list verified <TimeEvidence value={listVerifiedAt} />
              {listStale ? " · retained stale snapshot" : ""}
            </span>
          )}
        </KeyValue>
      </dl>
    </section>
  );
}

function MigrationProgressEvidence({
  job,
  overall,
  lastCheckpoint,
}: {
  job: MigrationJob;
  overall: number | null;
  lastCheckpoint: CheckpointEvent | null;
}): ReactElement {
  const rows = migrationDetailProgressRows(job);
  const rollingBack = job.status === "rolling_back";
  return (
    <section aria-labelledby="migration-progress-heading">
      <div className="migration-section-heading">
        <div>
          <h3 id="migration-progress-heading">
            {rollingBack ? "Rollback execution evidence" : "Progress evidence"}
          </h3>
          <p>
            {rollingBack
              ? "Import counters describe the original committed scope, not rollback completion. Live server checkpoints are the rollback authority."
              : job.source === "customerio"
                ? "Overall progress weights subscribers most heavily, includes exact source-evidence persistence, and excludes rebuild-only workflows and unsupported paid subscriptions."
                : "Overall progress weights subscribers most heavily and excludes Beehiiv rebuild-evidence and metadata-only buckets."}
          </p>
        </div>
      </div>
      {!rollingBack ? (
        <div className="migration-overall-progress">
          <MigrationProgressMeter
            value={overall}
            label={
              job.source === "customerio"
                ? "Weighted supported import and source-evidence progress"
                : "Weighted runtime-import progress"
            }
          />
        </div>
      ) : (
        <div className="migration-truth-callout is-warning">
          <strong>No rollback percentage is inferred.</strong>
          <span>
            A rollback may remove resources in checkpointed batches. Wait for
            the terminal Rolled back status and verification evidence.
          </span>
        </div>
      )}
      <div className="migration-resource-progress-list">
        {rows.map((row) => (
          <div
            key={row.key}
            className={`migration-resource-progress${lastCheckpoint?.resource === row.key ? " is-active" : ""}`}
          >
            <div>
              <strong>{row.label}</strong>
              <span>{row.truth}</span>
            </div>
            {rollingBack ? (
              <span className="migration-progress-count">
                Original import counter: {formatMigrationCount(row.done)} of{" "}
                {formatMigrationCount(row.total)}. Not a rollback percentage.
              </span>
            ) : (
              <MigrationProgressMeter
                value={
                  row.total > 0 && row.done <= row.total
                    ? Math.min(100, Math.round((row.done / row.total) * 100))
                    : null
                }
                label={`${formatMigrationCount(row.done)} of ${formatMigrationCount(row.total)}${row.done > row.total ? " · reported completed count exceeds total" : ""}`}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function CheckpointEvidence({
  job,
  lastCheckpoint,
}: {
  job: MigrationJob;
  lastCheckpoint: CheckpointEvent | null;
}): ReactElement {
  const cursorFields =
    job.cursor && typeof job.cursor === "object"
      ? Object.keys(job.cursor).length
      : 0;
  return (
    <section aria-labelledby="migration-checkpoint-heading">
      <div className="migration-section-heading">
        <div>
          <h3 id="migration-checkpoint-heading">
            Checkpoint and resume evidence
          </h3>
          <p>
            Cursor values can contain provider detail, so this surface exposes
            only the existence and timing of server-owned checkpoints.
          </p>
        </div>
      </div>
      <dl className="migration-kv-list">
        <KeyValue label="Durable cursor">
          {cursorFields > 0
            ? `${cursorFields} server cursor field${cursorFields === 1 ? "" : "s"} recorded`
            : "No durable cursor fields reported"}
        </KeyValue>
        <KeyValue label="Latest live checkpoint">
          {lastCheckpoint ? (
            <span>
              {migrationResourceLabel(lastCheckpoint.resource, job.source)} ·{" "}
              {formatMigrationCount(lastCheckpoint.completed)} of{" "}
              {formatMigrationCount(lastCheckpoint.total)} ·{" "}
              <TimeEvidence value={lastCheckpoint.at} />
            </span>
          ) : (
            "No live checkpoint received in this open detail session"
          )}
        </KeyValue>
        <KeyValue label="Resume behavior">
          {job.source === "customerio"
            ? "Continues from the server-recorded checkpoint; already committed runtime records and preserved source evidence are not intentionally replayed."
            : "Continues from the server-recorded checkpoint; already imported records are not intentionally re-imported."}
        </KeyValue>
      </dl>
    </section>
  );
}

function StreamHealth({
  status,
  interrupted,
  lastCheckpoint,
  onReconnect,
}: {
  status: MigrationStreamStatus;
  interrupted: boolean;
  lastCheckpoint: CheckpointEvent | null;
  onReconnect: () => void;
}): ReactElement {
  const label =
    status === "open"
      ? "Live updates connected"
      : status === "connecting"
        ? "Connecting live updates"
        : status === "reconnecting"
          ? "Reconnecting live updates"
          : "Live updates closed";
  return (
    <div className="migration-stream-health" role="status" aria-live="polite">
      <span
        className={`badge ${status === "open" ? "success" : interrupted ? "warning" : ""}`}
      >
        {label}
      </span>
      {lastCheckpoint ? (
        <span>
          Last checkpoint <TimeEvidence value={lastCheckpoint.at} />
        </span>
      ) : null}
      {interrupted ? (
        <>
          <span>
            The stream was interrupted. Automatic reconnect continues; the
            verified list refresh remains authoritative.
          </span>
          <button type="button" className="btn btn-sm" onClick={onReconnect}>
            Reconnect now
          </button>
        </>
      ) : null}
    </div>
  );
}

function CancelledMigrationRecovery({
  job,
  canAdmin,
  sourceSessionHealth,
  onClose,
  onResume,
}: {
  job: MigrationJob;
  canAdmin: boolean;
  sourceSessionHealth: SourceSessionHealthState;
  onClose: () => void;
  onResume: () => void;
}): ReactElement {
  const permissionId = `migration-resume-permission-${safeDomId(job.id)}`;
  const resumeBlocked = !canAdmin || sourceSessionHealth.blocksAction;
  const imported =
    job.verification_report?.subscribers_imported ??
    job.progress?.subscribers_done ??
    0;
  return (
    <section
      className="migration-cancelled-recovery"
      aria-labelledby="migration-cancelled-heading"
    >
      <h3 id="migration-cancelled-heading">Import cancelled at a checkpoint</h3>
      <p>
        {formatMigrationCount(imported)} subscriber
        {imported === 1 ? "" : "s"} were reported imported and remain in
        Moosewave. Resume continues from the server checkpoint; it does not
        certify that every source resource is complete.
      </p>
      <div className="migration-inline-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          aria-disabled={resumeBlocked || undefined}
          aria-describedby={resumeBlocked ? permissionId : undefined}
          onClick={() => {
            if (!resumeBlocked) onResume();
          }}
        >
          Resume from checkpoint
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onClose();
            setSection("subscribers");
          }}
        >
          View imported subscribers
        </button>
      </div>
      {resumeBlocked ? (
        <p id={permissionId} className="migration-action-reason">
          {!canAdmin
            ? "Admin role required to resume a tenant migration."
            : sourceSessionHealth.message}
        </p>
      ) : null}
    </section>
  );
}

function MigrationDetailActions({
  job,
  canAdmin,
  rollbackAllowed,
  rollbackReason,
  onCancel,
  onRollback,
}: {
  job: MigrationJob;
  canAdmin: boolean;
  rollbackAllowed: boolean;
  rollbackReason: string;
  onCancel: () => void;
  onRollback: () => void;
}): ReactElement {
  const permissionId = `migration-detail-permission-${safeDomId(job.id)}`;
  const rollbackId = `migration-detail-rollback-${safeDomId(job.id)}`;
  const cancellable = isMigrationCancellable(job.status);
  if (!cancellable && job.status !== "completed") return <></>;
  return (
    <section
      className="migration-detail-actions"
      aria-labelledby="migration-job-actions-heading"
    >
      <h3 id="migration-job-actions-heading">Job actions</h3>
      <div className="migration-inline-actions">
        {cancellable ? (
          <button
            type="button"
            className="btn btn-danger"
            aria-disabled={!canAdmin || undefined}
            aria-describedby={!canAdmin ? permissionId : undefined}
            onClick={() => {
              if (canAdmin) onCancel();
            }}
          >
            Cancel at next checkpoint
          </button>
        ) : null}
        {job.status === "completed" ? (
          <button
            type="button"
            className="btn btn-danger"
            aria-disabled={!rollbackAllowed || undefined}
            aria-describedby={rollbackAllowed ? undefined : rollbackId}
            onClick={() => {
              if (rollbackAllowed) onRollback();
            }}
          >
            Roll back imported records
          </button>
        ) : null}
      </div>
      {!canAdmin ? (
        <p id={permissionId} className="migration-action-reason">
          Admin role required for tenant migration mutations.
        </p>
      ) : null}
      {job.status === "completed" && !rollbackAllowed ? (
        <p id={rollbackId} className="migration-action-reason">
          {rollbackReason}
        </p>
      ) : null}
    </section>
  );
}

function BeehiivCutoverAction({ jobId }: { jobId: string }): ReactElement {
  const operation = useSingleFlightOperation();
  const reasonId = `beehiiv-cutover-${safeDomId(jobId)}`;
  const open = (): void => {
    const flight = operation.run(async () => {
      const review = new URL(
        `/app/migrations/${encodeURIComponent(jobId)}`,
        `${getDashboardUrl()}/`,
      );
      try {
        await tauriApi.openUrl(review.toString());
      } catch {
        toast.error({
          message: "Hosted cutover review could not be opened.",
          detail: `No external page was confirmed. Use migration job ${jobId} as the support reference.`,
        });
      }
    });
    if (flight) void flight;
  };
  return (
    <span className="migration-cutover-action">
      <button
        type="button"
        className="btn"
        aria-disabled={operation.active || undefined}
        aria-describedby={operation.active ? reasonId : undefined}
        onClick={() => {
          if (!operation.active) open();
        }}
      >
        {operation.active
          ? "Opening review…"
          : "Continue Beehiiv cutover in web"}
      </button>
      {operation.active ? (
        <span id={reasonId} className="migration-row-reason">
          The hosted review is already being opened.
        </span>
      ) : null}
    </span>
  );
}

function KeyValue({
  label,
  children,
}: {
  label: string;
  children: ReactElement | string;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function normalizeCheckpointEvent(value: unknown): CheckpointEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const progress = normalizeMigrationProgress(event.snapshot);
  if (
    !isKnownMigrationResource(event.resource) ||
    !progress ||
    typeof event.completed !== "number" ||
    !Number.isFinite(event.completed) ||
    event.completed < 0 ||
    typeof event.total !== "number" ||
    !Number.isFinite(event.total) ||
    event.total < 0 ||
    event.completed > event.total ||
    parseMigrationTime(event.at) === null
  ) {
    return null;
  }
  return {
    resource: event.resource,
    completed: event.completed,
    total: event.total,
    snapshot: progress,
    at: new Date(parseMigrationTime(event.at)!).toISOString(),
  };
}

export function migrationDetailProgressRows(job: MigrationJob): Array<{
  key: keyof MigrationProgress extends infer _Key ? string : never;
  label: string;
  done: number;
  total: number;
  truth: string;
}> {
  const progress = job.progress ?? {};
  const definitions = [
    ["subscribers", "Subscribers", "Runtime import records"],
    [
      "segments",
      job.source === "beehiiv"
        ? "Frozen segment/list snapshots"
        : job.source === "customerio"
          ? "Frozen segment/topic membership snapshots"
          : job.source === "hubspot"
            ? "Frozen list/subscription targeting boundaries"
            : "Segments",
      job.source === "beehiiv"
        ? "Snapshot evidence; dynamic rules require rebuild"
        : job.source === "customerio"
          ? "Exact snapshot evidence; provider predicates require rebuild or retirement"
          : job.source === "hubspot"
            ? "Combined list snapshots and active subscription-definition targeting boundaries"
            : "Runtime or translated resources",
    ],
    [
      "automations",
      job.source === "beehiiv"
        ? "Automation rebuild records"
        : job.source === "customerio"
          ? "Customer.io workflow rebuild records"
          : "Automations",
      job.source === "beehiiv"
        ? "Rebuild evidence, not activated runtime flows"
        : job.source === "customerio"
          ? "Rebuild-only evidence; never activated as runtime workflows"
          : "Runtime only where the source report confirms support",
    ],
    [
      "paid_subs",
      job.source === "beehiiv"
        ? "Premium membership metadata"
        : "Paid subscriptions",
      job.source === "beehiiv"
        ? "Metadata only; no Stripe billing objects"
        : "Runtime only where the source report confirms support",
    ],
    [
      "archive",
      job.source === "customerio"
        ? "Sent email newsletter archive"
        : "Campaign archive",
      job.source === "customerio"
        ? "Immutable history for sent email newsletters only"
        : "Source-exposed archive evidence",
    ],
    [
      "templates",
      job.source === "customerio"
        ? "Editable Design Studio email templates"
        : "Templates",
      job.source === "customerio"
        ? "Exact non-empty source HTML only; provider rendering, components, Liquid, styles/assets, and transformers require validation; no-HTML definitions remain rebuild evidence"
        : "Source-exposed template evidence",
    ],
    [
      "source_archive",
      job.source === "customerio"
        ? "Customer.io source evidence"
        : "Source archive",
      job.source === "customerio"
        ? "Read-only workflow, transactional, channel, preference, object, deliverability, and ecosystem evidence"
        : "Source-exposed raw archive evidence",
    ],
  ] as const;
  const record = progress as Record<string, number | undefined>;
  return definitions
    .map(([key, label, truth]) => ({
      key,
      label,
      truth,
      done: record[`${key}_done`] ?? 0,
      total: record[`${key}_total`] ?? 0,
    }))
    .filter(
      (row) =>
        (job.source !== "customerio" || row.key !== "paid_subs") &&
        (row.total > 0 || row.done > 0),
    );
}

function safeDomId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
}
