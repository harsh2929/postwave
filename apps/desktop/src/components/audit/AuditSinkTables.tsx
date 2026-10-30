/**
 * Audit-sink list, dead-letter queue, and circuit-health presentation.
 *
 * This module owns table-local interaction state and keeps the page controller
 * focused on loading, permissions, and modal orchestration.
 */

import {
  Fragment,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type AuditSink,
  type AuditSinkDLQEntry,
  api,
} from "../../lib/api-client";
import { HERO } from "../../lib/heroAssets";
import { Card } from "../Card";
import { ConfirmModal } from "../ConfirmModal";
import { HeroEmptyState } from "../HeroEmptyState";
import { SectionHeader } from "../SectionHeader";
import { Skeleton } from "../Skeleton";
import { toast } from "../Toast";

export function formatAuditSinkRelative(
  iso?: string | null,
  now = Date.now(),
): string {
  if (!iso) return "—";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const difference = now - timestamp;
  const absolute = Math.abs(difference);
  const future = difference < 0;
  const unit = (value: number, suffix: string): string =>
    `${value}${suffix}${future ? " from now" : " ago"}`;
  if (absolute < 60_000) return future ? "in <1m" : "just now";
  if (absolute < 3_600_000) return unit(Math.round(absolute / 60_000), "m");
  if (absolute < 86_400_000) return unit(Math.round(absolute / 3_600_000), "h");
  return unit(Math.round(absolute / 86_400_000), "d");
}

/* ---------- sinks table ---------- */

export function AuditSinkTable({
  rows,
  loading,
  canAdmin,
  onCreate,
  onOpen,
  onToggle,
  onResetCircuit,
}: {
  rows: AuditSink[] | null;
  loading: boolean;
  canAdmin: boolean;
  onCreate: () => void;
  onOpen: (s: AuditSink) => void;
  onToggle: (s: AuditSink) => Promise<void>;
  onResetCircuit: (s: AuditSink) => Promise<void>;
}): ReactElement {
  if (loading && rows == null) {
    return (
      <SkeletonRows
        label="audit sinks"
        headers={[
          "Name",
          "Kind",
          "Status",
          "Health",
          "Last delivery",
          "Failures",
          "Actions",
        ]}
      />
    );
  }
  if (rows && rows.length === 0) {
    return (
      <HeroEmptyState
        tone="blue"
        eyebrow="Streaming"
        title="Stream audit logs to your SIEM."
        subtitle="S3, Splunk, Datadog, or any HTTPS endpoint. Moosewave signs every batch and retries on failure."
        primaryCta={
          canAdmin
            ? {
                label: "+ Sink",
                onClick: onCreate,
              }
            : undefined
        }
        imageSrc={HERO.auditSinks}
        imageAlt="A brass funnel pouring teal liquid"
      />
    );
  }
  return (
    <div
      className="audit-table-scroll"
      role="region"
      aria-label="Configured audit sinks"
      // Keyboard users need a focus target to pan the table at high zoom.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <table className="data-table" style={{ width: "100%" }}>
        <caption className="visually-hidden">
          Configured audit delivery sinks and their current health
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col">Health</th>
            <th scope="col">Last delivery</th>
            <th scope="col">Failures</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((s) => (
            <SinkRow
              key={s.id}
              sink={s}
              canAdmin={canAdmin}
              onOpen={() => onOpen(s)}
              onToggle={() => onToggle(s)}
              onResetCircuit={() => onResetCircuit(s)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SinkRow({
  sink,
  canAdmin,
  onOpen,
  onToggle,
  onResetCircuit,
}: {
  sink: AuditSink;
  canAdmin: boolean;
  onOpen: () => void;
  onToggle: () => Promise<void>;
  onResetCircuit: () => Promise<void>;
}): ReactElement {
  const operation = useSingleFlightOperation({
    ownerId: `audit-sink-row-${sink.id}`,
    label: `Audit sink update for ${sink.name}`,
    detail: "Wait for the audit sink update to finish before leaving.",
  });
  const mountedRef = useRef(true);
  const statusId = useId();
  const [activeAction, setActiveAction] = useState<"toggle" | "reset" | null>(
    null,
  );
  const [actionStatus, setActionStatus] = useState("");
  const [actionError, setActionError] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runAction = async (
    kind: "toggle" | "reset",
    action: () => Promise<void>,
  ): Promise<void> => {
    const pending = operation.promiseRef.current;
    if (pending) {
      await pending;
      return;
    }
    const label =
      kind === "reset"
        ? "Circuit reset"
        : sink.enabled
          ? "Pause delivery"
          : "Resume delivery";
    setActiveAction(kind);
    setActionError(false);
    setActionStatus(`${label} in progress…`);
    const request = operation.run(async (): Promise<void> => {
      try {
        await action();
        if (mountedRef.current) {
          setActionStatus(`${label} request finished.`);
        }
      } catch (error) {
        const message = lifecycleOperationError(
          error,
          `${label} failed. Try again.`,
        );
        if (mountedRef.current) {
          setActionError(true);
          setActionStatus(message);
        }
        toast.error(message);
      } finally {
        if (mountedRef.current) setActiveAction(null);
      }
    });
    if (request) await request;
  };
  const failurePct = Math.min(
    100,
    Math.round(
      (sink.consecutive_failures / Math.max(1, sink.auto_disable_after)) * 100,
    ),
  );
  const failuresLabel = `${sink.consecutive_failures} / ${sink.auto_disable_after}`;
  return (
    <tr aria-busy={operation.active}>
      <td>
        <button
          type="button"
          className="link-button"
          onClick={onOpen}
          style={{ fontWeight: 600, textAlign: "left" }}
        >
          {sink.name}
        </button>
      </td>
      <td>
        <span className="badge">{sink.kind}</span>
      </td>
      <td>
        {sink.enabled ? (
          <span className="badge success">enabled</span>
        ) : (
          <span className="badge warning">disabled</span>
        )}
      </td>
      <td>
        <AuditSinkCircuitBadge sink={sink} />
      </td>
      <td className="muted tabular" style={{ fontSize: 12 }}>
        {sink.last_success_at ? (
          <time dateTime={sink.last_success_at}>
            {formatAuditSinkRelative(sink.last_success_at)}
            <span className="visually-hidden"> ({sink.last_success_at})</span>
          </time>
        ) : (
          "never"
        )}
      </td>
      <td>
        <AuditSinkFailureMeter pct={failurePct} label={failuresLabel} />
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <div
          className="list-row-actions"
          style={{ justifyContent: "flex-end" }}
        >
          <button type="button" className="list-row-action" onClick={onOpen}>
            Details
          </button>
          {canAdmin && (
            <>
              <button
                type="button"
                className="list-row-action"
                onClick={() => void runAction("toggle", onToggle)}
                disabled={operation.active}
                aria-describedby={statusId}
              >
                {activeAction === "toggle"
                  ? sink.enabled
                    ? "Pausing…"
                    : "Resuming…"
                  : sink.enabled
                    ? "Pause"
                    : "Resume"}
              </button>
              {sink.circuit_state !== "closed" && (
                <button
                  type="button"
                  className="list-row-action"
                  onClick={() => void runAction("reset", onResetCircuit)}
                  disabled={operation.active}
                  aria-describedby={statusId}
                >
                  {activeAction === "reset"
                    ? "Resetting…"
                    : "Reset breaker now"}
                </button>
              )}
            </>
          )}
          <span
            id={statusId}
            className={`audit-sink-action-status${
              actionError ? " is-error" : ""
            }`}
            role={actionError ? "alert" : "status"}
            aria-live={actionError ? "assertive" : "polite"}
            aria-atomic="true"
          >
            {actionStatus}
          </span>
        </div>
      </td>
    </tr>
  );
}

export function AuditSinkCircuitBadge({
  sink,
}: {
  sink: AuditSink;
}): ReactElement {
  if (sink.circuit_state === "closed") {
    return <span className="badge success">healthy</span>;
  }
  if (sink.circuit_state === "half_open") {
    return (
      <span className="audit-sink-health-state">
        <span className="badge warning">probing</span>
        <span className="muted small">Next delivery tests the upstream.</span>
      </span>
    );
  }
  // open
  return (
    <span className="audit-sink-health-state">
      <span className="badge error">open</span>
      <span className="muted small">
        {sink.cooldown_until
          ? `Next probe ${formatAuditSinkRelative(sink.cooldown_until)}.`
          : "Cooldown active."}
      </span>
    </span>
  );
}

export function AuditSinkFailureMeter({
  pct,
  label,
}: {
  pct: number;
  label: string;
}): ReactElement {
  const color =
    pct >= 80
      ? "var(--pw-danger)"
      : pct >= 40
        ? "var(--pw-warning)"
        : "var(--pw-success)";
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.max(0, Math.min(100, pct))}
      aria-valuetext={`${label} consecutive failures before auto-disable`}
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
    >
      <div
        style={{
          width: 64,
          height: 6,
          borderRadius: 3,
          background: "var(--pw-border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, pct))}%`,
            height: "100%",
            background: color,
            transition: "width .2s",
          }}
        />
      </div>
      <span className="muted tabular" style={{ fontSize: 12 }}>
        {label} failures
      </span>
    </div>
  );
}

/**
 * sse-pinned-tail (Audit UX, P1): live countdown to the next breaker
 * probe. Re-renders every second while open so the operator sees
 * "Reopens in 47s" rather than re-doing the math from an absolute
 * timestamp. Self-disposes when the deadline passes.
 */
export function AuditSinkCircuitRecoveryCountdown({
  until,
}: {
  until: string;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const deadline = new Date(until).getTime();
  if (Number.isNaN(deadline)) return <span />;
  const remaining = Math.max(0, Math.round((deadline - now) / 1000));
  if (remaining <= 0) {
    return (
      <span className="audit-sink-recovery">
        <strong className="mono" data-testid="audit-sink-recovery-countdown">
          Probing now
        </strong>
        <span className="muted small">
          Cooldown elapsed; the next delivery tests the upstream.
        </span>
      </span>
    );
  }
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return (
    <span className="audit-sink-recovery">
      <strong className="mono" data-testid="audit-sink-recovery-countdown">
        Reopens in {mm > 0 ? `${mm}m ${ss}s` : `${ss}s`}
      </strong>
      <span className="muted small">
        Auto-probe at {new Date(until).toLocaleTimeString()}.
      </span>
    </span>
  );
}

/**
 * sse-pinned-tail (Audit UX, P1): circuit-state legend + collapsible
 * history timeline. The state machine is a recurring source of
 * operator confusion ("does open mean broken or open-for-business?")
 * — render the meanings inline alongside the recent transitions we
 * can synthesize from sink fields.
 */
export function AuditSinkCircuitHealthLegend({
  sink,
}: {
  sink: AuditSink;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <Card
      variant="subtle"
      padding="sm"
      style={{ fontSize: 12 }}
      data-testid="audit-sink-circuit-legend"
    >
      <button
        type="button"
        className="link-button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={contentId}
        style={{ fontWeight: 600 }}
      >
        {open ? "Hide" : "Show"} circuit legend & history
      </button>
      {open ? (
        <div id={contentId} style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <table className="data-table" style={{ width: "100%", fontSize: 12 }}>
            <caption className="visually-hidden">
              Audit sink circuit-breaker states
            </caption>
            <tbody>
              <tr>
                <th scope="row" style={{ width: 110, textAlign: "left" }}>
                  <span
                    className="badge"
                    style={{
                      background:
                        "color-mix(in srgb, var(--pw-success) 14%, transparent)",
                      color: "var(--pw-success)",
                      padding: "1px 6px",
                      borderRadius: 3,
                    }}
                  >
                    closed
                  </span>
                </th>
                <td>
                  Healthy — events flow normally. Counter resets after each
                  successful delivery.
                </td>
              </tr>
              <tr>
                <th scope="row" style={{ textAlign: "left" }}>
                  <span
                    className="badge"
                    style={{
                      background:
                        "color-mix(in srgb, var(--pw-warning) 14%, transparent)",
                      color: "var(--pw-warning)",
                      padding: "1px 6px",
                      borderRadius: 3,
                    }}
                  >
                    half-open
                  </span>
                </th>
                <td>
                  Probing — one tentative request is allowed; success closes the
                  breaker, failure re-opens it.
                </td>
              </tr>
              <tr>
                <th scope="row" style={{ textAlign: "left" }}>
                  <span
                    className="badge"
                    style={{
                      background:
                        "color-mix(in srgb, var(--pw-danger) 14%, transparent)",
                      color: "var(--pw-danger)",
                      padding: "1px 6px",
                      borderRadius: 3,
                    }}
                  >
                    open
                  </span>
                </th>
                <td>
                  Tripped — deliveries short-circuit to the DLQ until the
                  cooldown elapses (then transitions to half-open).
                </td>
              </tr>
            </tbody>
          </table>
          <div>
            <div className="label" style={{ marginBottom: 4 }}>
              Recent transitions
            </div>
            <ul
              style={{
                margin: 0,
                paddingLeft: 16,
                fontSize: 12,
                color: "var(--pw-fg-muted)",
              }}
              data-testid="audit-sink-circuit-history"
            >
              {sink.last_failure_at ? (
                <li>
                  Last failure {formatAuditSinkRelative(sink.last_failure_at)}
                  {sink.consecutive_failures
                    ? ` · ${sink.consecutive_failures} consecutive`
                    : ""}
                </li>
              ) : null}
              <li>
                Current state: <strong>{sink.circuit_state}</strong>
                {sink.cooldown_until
                  ? ` · cooldown ends ${formatAuditSinkRelative(sink.cooldown_until)}`
                  : ""}
              </li>
              <li>
                Auto-disables after <strong>{sink.auto_disable_after}</strong>{" "}
                consecutive failures.
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function SkeletonRows({
  label,
  headers,
}: {
  label: string;
  headers: string[];
}): ReactElement {
  return (
    <div
      className="audit-table-scroll"
      role="status"
      aria-busy="true"
      aria-label={`Loading ${label}`}
    >
      <table className="data-table" style={{ width: "100%" }}>
        <caption className="visually-hidden">Loading {label}</caption>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <tr key={row}>
              {headers.map((header, column) => (
                <td key={header}>
                  <Skeleton
                    variant="row"
                    height={14}
                    width={
                      column === 0
                        ? 160
                        : column === headers.length - 1
                          ? 100
                          : 80
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- DLQ table ---------- */

type BulkReplayResult = "ok" | "failed" | "skipped" | "not_found";

interface ReplayFeedback {
  tone: "neutral" | "success" | "error";
  message: string;
}

function useAuditDlqReplayController({
  entries,
  onReplay,
  onAfterBulkReplay,
  onBulkSettled,
}: {
  entries: AuditSinkDLQEntry[] | null;
  onReplay: (entry: AuditSinkDLQEntry) => Promise<void>;
  onAfterBulkReplay: () => Promise<void>;
  onBulkSettled: () => void;
}): {
  active: boolean;
  target: "bulk" | number | null;
  results: Record<number, BulkReplayResult>;
  feedback: ReplayFeedback;
  runEntry: (entry: AuditSinkDLQEntry) => Promise<void>;
  runBulk: () => Promise<void>;
} {
  const operation = useSingleFlightOperation({
    ownerId: "audit-sink-dlq-replay",
    label: "Audit sink dead-letter replay",
    detail: "Wait for the audit replay request to finish before leaving.",
  });
  const mountedRef = useRef(true);
  const [target, setTarget] = useState<"bulk" | number | null>(null);
  const [results, setResults] = useState<Record<number, BulkReplayResult>>({});
  const [feedback, setFeedback] = useState<ReplayFeedback>({
    tone: "neutral",
    message: "No replay in progress.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runEntry = async (entry: AuditSinkDLQEntry): Promise<void> => {
    const pending = operation.promiseRef.current;
    if (pending) {
      await pending;
      return;
    }
    setTarget(entry.id);
    setFeedback({
      tone: "neutral",
      message: `Replaying DLQ entry ${entry.id}…`,
    });
    const request = operation.run(async (): Promise<void> => {
      try {
        await onReplay(entry);
        if (mountedRef.current) {
          setFeedback({
            tone: "neutral",
            message: `Replay request for DLQ entry ${entry.id} finished. Refreshed results show any successful delivery.`,
          });
        }
      } catch (error) {
        const message = lifecycleOperationError(
          error,
          `DLQ entry ${entry.id} couldn't be replayed.`,
        );
        if (mountedRef.current) {
          setFeedback({ tone: "error", message });
        }
        toast.error(message);
      } finally {
        if (mountedRef.current) setTarget(null);
      }
    });
    if (request) await request;
  };

  const runBulk = async (): Promise<void> => {
    const pending = operation.promiseRef.current;
    if (pending) {
      await pending;
      return;
    }
    const snapshot = entries ? [...entries] : [];
    if (snapshot.length === 0) {
      if (mountedRef.current) onBulkSettled();
      return;
    }
    setTarget("bulk");
    setFeedback({
      tone: "neutral",
      message: `Replaying ${snapshot.length} pending ${snapshot.length === 1 ? "entry" : "entries"}…`,
    });
    const request = operation.run(async (): Promise<void> => {
      const ids = snapshot.map((entry) => entry.id);
      const chunkSize = 500;
      let totalReplayed = 0;
      let totalFailed = 0;
      let totalSkipped = 0;
      const merged: Record<number, BulkReplayResult> = {};

      for (let index = 0; index < ids.length; index += chunkSize) {
        const slice = ids.slice(index, index + chunkSize);
        try {
          const response = await api.replayDLQBulk(slice);
          if (response.error || !response.data) {
            totalFailed += slice.length;
            for (const id of slice) merged[id] = "failed";
            continue;
          }
          totalReplayed += response.data.replayed;
          totalFailed += response.data.failed;
          totalSkipped += response.data.skipped;
          for (const entry of response.data.entries) {
            merged[entry.id] = entry.status;
          }
        } catch {
          totalFailed += slice.length;
          for (const id of slice) merged[id] = "failed";
        }
      }

      const summary =
        totalFailed === 0
          ? `Replayed ${totalReplayed} ${totalReplayed === 1 ? "event" : "events"}${
              totalSkipped > 0 ? `; ${totalSkipped} skipped` : ""
            }; 0 failed.`
          : `Replayed ${totalReplayed}; ${totalFailed} failed${
              totalSkipped > 0 ? `; ${totalSkipped} skipped` : ""
            }. Review the per-row results.`;
      if (mountedRef.current) {
        setResults(merged);
        setFeedback({
          tone: totalFailed === 0 ? "success" : "error",
          message: summary,
        });
      }
      if (totalFailed === 0) toast.success(summary);
      else toast.error(summary);

      try {
        await onAfterBulkReplay();
      } catch (error) {
        const refreshMessage = lifecycleOperationError(
          error,
          "Replay finished, but the dead-letter queue couldn't be refreshed.",
        );
        if (mountedRef.current) {
          setFeedback({
            tone: "error",
            message: `${summary} ${refreshMessage}`,
          });
        }
        toast.error(refreshMessage);
      } finally {
        if (mountedRef.current) {
          setTarget(null);
          onBulkSettled();
        }
      }
    });
    if (request) await request;
  };

  return {
    active: operation.active,
    target,
    results,
    feedback,
    runEntry,
    runBulk,
  };
}

export function AuditSinkDLQTable({
  entries,
  loading,
  sinksById,
  canAdmin,
  onReplay,
  onAfterBulkReplay,
}: {
  entries: AuditSinkDLQEntry[] | null;
  loading: boolean;
  sinksById: Map<string, AuditSink>;
  canAdmin: boolean;
  onReplay: (entry: AuditSinkDLQEntry) => Promise<void>;
  /**
   * Called after a bulk replay finishes (success or partial failure).
   * Wired to the page-level reload so successfully-replayed entries
   * disappear from the table — pre-fix bulk replay left the table
   * stale until manual refresh, which made operators distrust the
   * "replay all" button.
   */
  onAfterBulkReplay: () => Promise<void>;
}): ReactElement {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showBulk, setShowBulk] = useState(false);
  const statusId = useId();
  const replay = useAuditDlqReplayController({
    entries,
    onReplay,
    onAfterBulkReplay,
    onBulkSettled: () => setShowBulk(false),
  });

  if (loading && entries == null) {
    return (
      <SkeletonRows
        label="dead-letter queue"
        headers={[
          "Sink",
          "Audit IDs",
          "Attempts",
          "First failed",
          "Last error",
          "Actions",
        ]}
      />
    );
  }

  if (entries && entries.length === 0) {
    return (
      <>
        <SectionHeader
          title="Dead-letter queue"
          description="Failed delivery batches land here so they don't get lost — replay once the upstream is healthy."
        />
        <div className="empty-section">
          <div className="empty-section-title">No pending replays</div>
          <div className="empty-section-body">
            Every sink is keeping up. Failed batches will appear here
            automatically with full error context for replay.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <SectionHeader
        title="Dead-letter queue"
        description={`${entries?.length ?? 0} pending ${
          (entries?.length ?? 0) === 1 ? "batch" : "batches"
        }. Use “Show error details” on a row to inspect the full upstream response.`}
        helpText="Sinks short-circuit to the DLQ after 10 consecutive failures so events aren't dropped. Replay once the upstream is healthy."
        actions={
          canAdmin && entries && entries.length > 0 ? (
            <button
              type="button"
              className="btn"
              disabled={replay.active}
              aria-describedby={statusId}
              onClick={() => setShowBulk(true)}
            >
              {replay.target === "bulk" ? "Replaying…" : "Replay all"}
            </button>
          ) : undefined
        }
      />

      <ConfirmModal
        open={showBulk}
        title="Replay all pending entries?"
        description={`Issues one upstream call per entry — ${entries?.length ?? 0} ${
          (entries?.length ?? 0) === 1 ? "entry" : "entries"
        } total. Idempotent on the receiver if your sink dedupes by audit row id.`}
        confirmLabel="Replay all"
        busy={replay.target === "bulk"}
        onClose={() => {
          if (!replay.active) setShowBulk(false);
        }}
        onConfirm={() => void replay.runBulk()}
      />
      <div
        id={statusId}
        className={`audit-dlq-replay-status is-${replay.feedback.tone}`}
        role={replay.feedback.tone === "error" ? "alert" : "status"}
        aria-live={replay.feedback.tone === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {replay.feedback.message}
      </div>
      <div
        className="audit-table-scroll"
        role="region"
        aria-label="Audit sink dead-letter queue"
        // Keyboard users need a focus target to pan the table at high zoom.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <table
          className="data-table"
          style={{ width: "100%" }}
          aria-busy={replay.active}
        >
          <caption className="visually-hidden">
            Failed audit delivery batches available for replay
          </caption>
          <thead>
            <tr>
              <th scope="col">Sink</th>
              <th scope="col">Audit IDs</th>
              <th scope="col">Attempts</th>
              <th scope="col">First failed</th>
              <th scope="col">Last error</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e) => {
              const sink = sinksById.get(e.sink_id);
              const rowCount = e.to_audit_id - e.from_audit_id + 1;
              const isOpen = expanded === e.id;
              const detailsId = `audit-dlq-details-${e.id}`;
              const bulkResult = replay.results[e.id];
              return (
                <Fragment key={e.id}>
                  <tr data-expanded={isOpen}>
                    <td>
                      <button
                        type="button"
                        className="link-button audit-dlq-disclosure"
                        aria-expanded={isOpen}
                        aria-controls={detailsId}
                        onClick={() => setExpanded(isOpen ? null : e.id)}
                      >
                        <strong>{sink?.name ?? "(deleted sink)"}</strong>
                        <span className="muted small">
                          {isOpen ? "Hide error details" : "Show error details"}
                        </span>
                      </button>
                      {sink && (
                        <>
                          {" "}
                          <span className="badge">{sink.kind}</span>
                        </>
                      )}
                      {/* sse-pinned-tail (Audit UX, P1): per-entry bulk
                        replay outcome badge. Renders when the entry was
                        included in the most recent bulk run. */}
                      {bulkResult ? (
                        <span
                          className="badge"
                          data-testid={`dlq-bulk-status-${e.id}`}
                          style={{
                            marginLeft: 6,
                            background:
                              bulkResult === "ok"
                                ? "color-mix(in srgb, var(--pw-success) 14%, transparent)"
                                : bulkResult === "skipped"
                                  ? "color-mix(in srgb, var(--pw-warning) 14%, transparent)"
                                  : "color-mix(in srgb, var(--pw-danger) 14%, transparent)",
                            color:
                              bulkResult === "ok"
                                ? "var(--pw-success)"
                                : bulkResult === "skipped"
                                  ? "var(--pw-warning)"
                                  : "var(--pw-danger)",
                          }}
                        >
                          {bulkResult === "ok"
                            ? "Bulk replay: succeeded"
                            : bulkResult === "skipped"
                              ? "Bulk replay: already replayed"
                              : bulkResult === "not_found"
                                ? "Bulk replay: entry no longer exists"
                                : "Bulk replay: failed"}
                        </span>
                      ) : null}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {e.from_audit_id}–{e.to_audit_id}{" "}
                      <span className="muted">({rowCount} rows)</span>
                    </td>
                    <td>{e.attempt_count}</td>
                    <td className="muted tabular" style={{ fontSize: 12 }}>
                      {formatAuditSinkRelative(e.first_failed_at)}
                    </td>
                    <td className="muted audit-dlq-error-preview">
                      {e.last_error || "—"}
                    </td>
                    <td>
                      {canAdmin && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => void replay.runEntry(e)}
                          disabled={replay.active}
                          aria-describedby={statusId}
                        >
                          {replay.target === e.id ? "Replaying…" : "Replay"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={detailsId} className="audit-dlq-details-row">
                      <td
                        colSpan={6}
                        style={{ background: "var(--pw-bg-elev)" }}
                      >
                        <div className="label">Full error</div>
                        <pre
                          className="mono"
                          style={{
                            fontSize: 12,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            margin: "4px 0 8px",
                          }}
                        >
                          {e.last_error || "(no error string)"}
                        </pre>
                        <div className="muted" style={{ fontSize: 12 }}>
                          Last attempt{" "}
                          {formatAuditSinkRelative(e.last_attempt_at)} · DLQ id
                          #{e.id}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
