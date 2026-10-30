/**
 * RoutinesPanel — scheduled agent routines for the Moosewave AI page
 * (roadmap R5, /api/v1/agent-routines).
 *
 * A routine is a stored prompt + kind (draft_campaign | draft_sequence,
 * immutable after create) + schedule. HONEST framing repeated in the
 * UI: routines only ever CREATE DRAFTS. require_approval controls whether
 * a successful draft also opens an Approvals request; disabling that option
 * does not make the routine send, but it does mean no approval request is
 * created by the run.
 *
 * Run now → 202 {run_id} (execution continues server-side; the runs
 * list refreshes to pick up the status). Runs drill down per routine:
 * status, output link to the draft campaign/sequence, approval link,
 * bounded operator-safe failure copy.
 */

import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type AgentRoutine,
  type AgentRoutineKind,
  type AgentRoutineRun,
  type AgentRoutineSchedule,
  agentRoutinesApi,
} from "../../lib/api-client";
import { navigateDesktopSectionResource } from "../../lib/desktop-router";
import { fmtDateTime } from "../../lib/format-date";
import { useCanWrite } from "../../lib/store";
import {
  remoteFailureFromError,
  type RemoteFailure,
} from "../../lib/remote-resource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { type Segment, segmentsClient } from "../segments/segmentsClient";
import { toast } from "../Toast";
import { AgentTrustPanel, agentRunHasTrust } from "./AgentTrustPanel";
import {
  ROUTINE_KINDS,
  ROUTINE_NAME_MAX,
  ROUTINE_PROMPT_MAX,
  ROUTINE_SCHEDULES,
  kindLabel,
  routineDraftFingerprint,
  routineFailureMessage,
  routineRunFailureMessage,
  runOutputLink,
  runStatusLabel,
  runStatusTone,
  scheduleLabel,
  targetIdOrNull,
  validateRoutineDraft,
} from "./routines-helpers";
import "../../styles-action-availability.css";
import "../../styles-postwave-ai-routines.css";

/* ---------- target option loading ----------------------------------- */

interface TargetOptions {
  segments: Array<{ id: string; name: string }>;
  segmentTransport: "loading" | "ready" | "error";
  segmentFailure: RemoteFailure | null;
}

async function fetchTargetOptions(): Promise<TargetOptions> {
  // agent_routines.target_segment_id is a FK to canonical segments(id).
  // Directory saved views live in saved_segments and are not valid hints.
  const segsRes = await segmentsClient.list().catch(() => null);
  if (!segsRes) {
    return {
      segments: [],
      segmentTransport: "error",
      segmentFailure: remoteFailureFromError({ kind: "network" }),
    };
  }
  if (segsRes.error) {
    return {
      segments: [],
      segmentTransport: "error",
      segmentFailure: remoteFailureFromError(segsRes.error),
    };
  }
  const segments = canonicalSegmentOptions(segsRes.data);
  if (!segments) {
    return {
      segments: [],
      segmentTransport: "error",
      segmentFailure: remoteFailureFromError({
        kind: "parse",
        code: "invalid_canonical_segment_catalog",
      }),
    };
  }
  return {
    segments,
    segmentTransport: "ready",
    segmentFailure: null,
  };
}

function canonicalSegmentOptions(
  payload: unknown,
): Array<Pick<Segment, "id" | "name">> | null {
  if (!Array.isArray(payload)) return null;
  const options: Array<Pick<Segment, "id" | "name">> = [];
  const seenIDs = new Set<string>();
  for (const candidate of payload) {
    if (!candidate || typeof candidate !== "object") return null;
    const row = candidate as { id?: unknown; name?: unknown };
    if (
      typeof row.id !== "string" ||
      row.id.trim() === "" ||
      typeof row.name !== "string" ||
      row.name.trim() === ""
    ) {
      return null;
    }
    const id = row.id.trim();
    if (seenIDs.has(id)) return null;
    seenIDs.add(id);
    options.push({ id, name: row.name.trim() });
  }
  return options.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

/* ---------- panel ---------------------------------------------------- */

interface RoutinesContentProps {
  routines: AgentRoutine[] | null;
  loading: boolean;
  error: string | null;
  canMutate: boolean;
  mutationActive: boolean;
  runBusy: string | null;
  toggleBusy: string | null;
  expandedRuns: string | null;
  runsRefresh: number;
  actionGuidanceId: string;
  permissionGuidanceId: string;
  onRetry: () => void;
  onRun: (routine: AgentRoutine) => void;
  onToggle: (routine: AgentRoutine) => void;
  onEdit: (routine: AgentRoutine) => void;
  onDelete: (routine: AgentRoutine) => void;
  onToggleRuns: (id: string) => void;
  onRunningChange: (id: string, active: boolean) => void;
}

function RoutinesContent({
  routines,
  loading,
  error,
  canMutate,
  mutationActive,
  runBusy,
  toggleBusy,
  expandedRuns,
  runsRefresh,
  actionGuidanceId,
  permissionGuidanceId,
  onRetry,
  onRun,
  onToggle,
  onEdit,
  onDelete,
  onToggleRuns,
  onRunningChange,
}: RoutinesContentProps): ReactElement {
  const permissionDescription = !canMutate ? permissionGuidanceId : undefined;
  if (error) {
    return (
      <div className="notice pw-ai-routines__state" role="alert">
        <span>Couldn&apos;t load routines: {error}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRetry}
          disabled={loading}
        >
          Retry
        </button>
      </div>
    );
  }
  if (loading && routines === null) {
    return (
      <div className="pw-ai-routines__state muted" role="status">
        Loading routines…
      </div>
    );
  }
  if ((routines ?? []).length === 0) {
    return (
      <div className="pw-ai-routines__empty">
        <strong>No routines yet</strong>
        <span className="muted">
          {canMutate
            ? "Create a reusable brief for manual or interval-based background drafting. A successful run creates a draft only; approval requests are optional per routine."
            : "This workspace has no routines to review. Viewer access can't create one."}
        </span>
      </div>
    );
  }
  return (
    <div className="pw-ai-routines__list" role="list" aria-label="Routines">
      {(routines ?? []).map((routine) => {
        const activeRun = routine.has_active_run;
        const routineMutationUnavailable = !canMutate || activeRun;
        const mutationUnavailableDescription = !canMutate
          ? permissionGuidanceId
          : activeRun
            ? actionGuidanceId
            : undefined;
        return (
          <article
            key={routine.id}
            className="pw-ai-routine-card"
            role="listitem"
            aria-labelledby={`routine-title-${routine.id}`}
          >
            <div className="pw-ai-routine-card__row">
              <div className="pw-ai-routine-card__primary">
                <h4
                  id={`routine-title-${routine.id}`}
                  className="pw-ai-routine-card__title"
                >
                  {routine.name}
                  {!routine.enabled && routine.schedule !== "manual" ? (
                    <span className="pw-ai-routine-card__paused">
                      Schedule paused
                    </span>
                  ) : null}
                  {activeRun ? (
                    <span className="pw-ai-routine-card__paused">
                      Draft in progress
                    </span>
                  ) : null}
                </h4>
                <div className="pw-ai-routine-card__meta">
                  <span>{kindLabel(routine.kind)}</span>
                  <span>{scheduleLabel(routine.schedule)}</span>
                  <span>
                    {routine.last_run_at
                      ? `Last started ${fmtDateTime(routine.last_run_at)}`
                      : routine.schedule !== "manual"
                        ? routine.enabled
                          ? "First interval run eligible now"
                          : "First interval run eligible when enabled"
                        : "No run recorded"}
                  </span>
                  <span
                    className={`pw-ai-routine-card__approval ${
                      routine.require_approval
                        ? "pw-ai-routine-card__approval--on"
                        : "pw-ai-routine-card__approval--off"
                    }`}
                  >
                    {routine.require_approval
                      ? "Approval request on"
                      : "No approval request"}
                  </span>
                </div>
              </div>
              <div
                className="pw-ai-routine-card__actions"
                role="group"
                aria-label={`Actions for ${routine.name}`}
              >
                <button
                  type="button"
                  className={`btn btn-sm${routineMutationUnavailable ? " pw-discoverable-unavailable" : ""}`}
                  disabled={mutationActive}
                  aria-disabled={routineMutationUnavailable || undefined}
                  onClick={() => {
                    if (!routineMutationUnavailable) onRun(routine);
                  }}
                  aria-describedby={
                    permissionDescription
                      ? `${actionGuidanceId} ${permissionDescription}`
                      : actionGuidanceId
                  }
                  aria-busy={runBusy === routine.id ? "true" : undefined}
                >
                  {runBusy === routine.id ? "Starting…" : "Run now"}
                </button>
                {routine.schedule !== "manual" ? (
                  <button
                    type="button"
                    className={`btn btn-sm btn-ghost${routineMutationUnavailable ? " pw-discoverable-unavailable" : ""}`}
                    disabled={mutationActive}
                    aria-disabled={routineMutationUnavailable || undefined}
                    onClick={() => {
                      if (!routineMutationUnavailable) onToggle(routine);
                    }}
                    aria-describedby={
                      permissionDescription
                        ? `${actionGuidanceId} ${permissionDescription}`
                        : actionGuidanceId
                    }
                    aria-busy={toggleBusy === routine.id ? "true" : undefined}
                  >
                    {toggleBusy === routine.id
                      ? routine.enabled
                        ? "Pausing…"
                        : "Resuming…"
                      : routine.enabled
                        ? "Pause interval"
                        : "Resume interval"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`btn btn-sm btn-ghost${routineMutationUnavailable ? " pw-discoverable-unavailable" : ""}`}
                  disabled={mutationActive}
                  aria-disabled={routineMutationUnavailable || undefined}
                  onClick={() => {
                    if (!routineMutationUnavailable) onEdit(routine);
                  }}
                  aria-describedby={mutationUnavailableDescription}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`btn btn-sm btn-ghost${routineMutationUnavailable ? " pw-discoverable-unavailable" : ""}`}
                  disabled={mutationActive}
                  aria-disabled={routineMutationUnavailable || undefined}
                  onClick={() => {
                    if (!routineMutationUnavailable) onDelete(routine);
                  }}
                  aria-describedby={mutationUnavailableDescription}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onToggleRuns(routine.id)}
                  aria-expanded={expandedRuns === routine.id}
                  aria-controls={`routine-runs-${routine.id}`}
                >
                  {expandedRuns === routine.id ? "Hide runs" : "Run history"}
                </button>
              </div>
            </div>
            {expandedRuns === routine.id ? (
              <section
                id={`routine-runs-${routine.id}`}
                className="pw-ai-routine-card__runs"
                aria-label={`Run history for ${routine.name}`}
              >
                <RoutineRuns
                  routineId={routine.id}
                  refreshToken={runsRefresh}
                  onRunningChange={onRunningChange}
                />
              </section>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function RoutinesPanel(): ReactElement {
  const canMutate = useCanWrite();
  const headingId = useId();
  const actionGuidanceId = "routine-action-guidance";
  const permissionGuidanceId = useId();
  const [routines, setRoutines] = useState<AgentRoutine[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<AgentRoutine | null>(null);

  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);
  // Bumped after "Run now" so the open runs drilldown refetches.
  const [runsRefresh, setRunsRefresh] = useState<number>(0);

  const [pendingDelete, setPendingDelete] = useState<AgentRoutine | null>(null);
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const mutation = useSingleFlightOperation({
    ownerId: "agent-routine-mutation",
    label: "Agent routine operation",
    detail: "Wait for the routine request to finish before leaving.",
  });

  const handleRunningChange = useCallback(
    (routineID: string, active: boolean): void => {
      setRoutines((current) => {
        if (!current) return current;
        let changed = false;
        const next = current.map((routine) => {
          if (routine.id !== routineID || routine.has_active_run === active) {
            return routine;
          }
          changed = true;
          return { ...routine, has_active_run: active };
        });
        return changed ? next : current;
      });
    },
    [],
  );

  async function load(): Promise<void> {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    setErr(null);
    try {
      const res = await agentRoutinesApi.list();
      if (loadRequestRef.current !== requestId) return;
      if (res.error) {
        setErr(routineFailureMessage(res.error, "load"));
        return;
      }
      setRoutines(res.data?.items ?? []);
    } catch (error) {
      if (loadRequestRef.current === requestId) {
        setErr(routineFailureMessage(error, "load"));
      }
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function runNow(routine: AgentRoutine): Promise<void> {
    if (!canMutate || routine.has_active_run) return;
    const request = mutation.run(async () => {
      setRunBusy(routine.id);
      setMutationStatus(`Starting a background draft for ${routine.name}…`);
      return agentRoutinesApi.run(routine.id);
    });
    if (!request) {
      await mutation.wait().catch(() => undefined);
      return;
    }
    try {
      const res = await request;
      if (res.error) {
        toast.error(routineFailureMessage(res.error, "run"));
        void load();
        return;
      }
      // 202 — drafting continues server-side.
      toast.success(
        routine.require_approval
          ? "Background draft started. If drafting succeeds, the routine will also open an approval request."
          : "Background draft started. This routine does not create an approval request.",
      );
      setExpandedRuns(routine.id);
      handleRunningChange(routine.id, true);
      setRunsRefresh((count) => count + 1);
    } catch (error) {
      toast.error(routineFailureMessage(error, "run"));
    } finally {
      setRunBusy(null);
      setMutationStatus(null);
    }
  }

  async function toggleEnabled(routine: AgentRoutine): Promise<void> {
    if (!canMutate || routine.has_active_run) return;
    const nextEnabled = !routine.enabled;
    const request = mutation.run(async () => {
      setToggleBusy(routine.id);
      setMutationStatus(
        `${nextEnabled ? "Resuming" : "Pausing"} the interval for ${routine.name}…`,
      );
      return agentRoutinesApi.update(routine.id, { enabled: nextEnabled });
    });
    if (!request) {
      await mutation.wait().catch(() => undefined);
      return;
    }
    try {
      const res = await request;
      if (res.error) {
        toast.error(routineFailureMessage(res.error, "update"));
        void load();
        return;
      }
      toast.success(
        nextEnabled
          ? "Automatic interval resumed"
          : "Automatic interval paused",
      );
      void load();
    } catch (error) {
      toast.error(routineFailureMessage(error, "update"));
    } finally {
      setToggleBusy(null);
      setMutationStatus(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!canMutate) return;
    const target = pendingDelete;
    if (!target) return;
    const request = mutation.run(async () => {
      setMutationStatus(`Deleting ${target.name}…`);
      return agentRoutinesApi.remove(target.id);
    });
    if (!request) {
      await mutation.wait().catch(() => undefined);
      return;
    }
    try {
      const res = await request;
      if (res.error) {
        toast.error(routineFailureMessage(res.error, "delete"));
        void load();
        return;
      }
      toast.success("Routine deleted");
      setPendingDelete(null);
      void load();
    } catch (error) {
      toast.error(routineFailureMessage(error, "delete"));
    } finally {
      setMutationStatus(null);
    }
  }

  return (
    <section className="card pw-ai-routines" aria-labelledby={headingId}>
      <header className="pw-ai-routines__header">
        <div className="pw-ai-routines__heading">
          <span className="pw-ai-routines__eyebrow">Background drafting</span>
          <h3 id={headingId} className="section-title pw-ai-routines__title">
            Routines
          </h3>
          <p className="pw-ai-routines__intro">
            Store a reusable brief, run it on demand, or make it eligible after
            an elapsed interval. A successful run creates a campaign or sequence
            draft only; a routine never queues or sends it.
          </p>
        </div>
        <button
          type="button"
          className={`btn btn-primary btn-sm pw-ai-routines__create${!canMutate ? " pw-discoverable-unavailable" : ""}`}
          disabled={mutation.active}
          aria-disabled={!canMutate || undefined}
          aria-describedby={!canMutate ? permissionGuidanceId : undefined}
          onClick={() => {
            if (!canMutate) return;
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          + New routine
        </button>
      </header>

      <div className="pw-ai-routines__truth-grid">
        <div className="pw-ai-routines__truth-card">
          <strong>Draft boundary</strong>
          <span>
            A routine creates an approval request only when that option is on.
            With it off, the draft still stays inert in its draft workspace.
          </span>
        </div>
        <div className="pw-ai-routines__truth-card">
          <strong>Interval scheduling</strong>
          <span>
            Daily, weekly, and monthly mean 24 hours, 7 days, and 30 days after
            the most recent run started—not a fixed local date or time. With no
            prior run, an enabled interval routine is eligible immediately;
            scheduler scans can start eligible runs later.
          </span>
        </div>
      </div>

      {!canMutate ? (
        <div
          id={permissionGuidanceId}
          className="pw-ai-routines__viewer"
          role="status"
        >
          <strong>Read-only viewer</strong>
          <span>
            You can inspect routines, run history, reasoning, and draft links.
            Creating, editing, deleting, pausing or resuming interval schedules,
            and Run now are unavailable for this role.
          </span>
        </div>
      ) : null}

      <RoutinesContent
        routines={routines}
        loading={loading}
        error={err}
        canMutate={canMutate}
        mutationActive={mutation.active}
        runBusy={runBusy}
        toggleBusy={toggleBusy}
        expandedRuns={expandedRuns}
        runsRefresh={runsRefresh}
        actionGuidanceId={actionGuidanceId}
        permissionGuidanceId={permissionGuidanceId}
        onRetry={() => void load()}
        onRun={(routine) => void runNow(routine)}
        onToggle={(routine) => void toggleEnabled(routine)}
        onEdit={(routine) => {
          if (!canMutate || routine.has_active_run) return;
          setEditing(routine);
          setEditorOpen(true);
        }}
        onDelete={(routine) => {
          if (canMutate && !routine.has_active_run) setPendingDelete(routine);
        }}
        onToggleRuns={(id) =>
          setExpandedRuns((current) => (current === id ? null : id))
        }
        onRunningChange={handleRunningChange}
      />

      <div id={actionGuidanceId} className="pw-action-status">
        Run now starts one background drafting attempt. Pause interval stops
        automatic eligibility but does not block a permitted manual run. While a
        run is active, the routine stays locked against another start, edits,
        schedule changes, and deletion. Approval requests follow each
        routine&apos;s displayed setting.
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {mutationStatus}
      </span>

      <RoutineEditorModal
        open={editorOpen}
        routine={editing}
        canMutate={canMutate}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          setEditorOpen(false);
          void load();
        }}
      />

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete routine?"
        description={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? Its run history goes with it. Existing drafts and any approval requests already created are unaffected.`
            : ""
        }
        confirmLabel="Delete routine"
        danger
        busy={mutation.active}
        confirmDisabled={!canMutate}
        onConfirm={() => confirmDelete()}
        onClose={() =>
          mutation.promiseRef.current ? undefined : setPendingDelete(null)
        }
      />
    </section>
  );
}

/* ---------- runs drilldown ------------------------------------------- */

type RunMonitorState = "checking" | "watching" | "settled" | "paused" | "error";

const RUN_POLL_MS = 3_000;
const RUN_MAX_POLLS = 20;

function RoutineRuns({
  routineId,
  refreshToken,
  onRunningChange,
}: {
  routineId: string;
  /** Bump to refetch (e.g. right after Run now). */
  refreshToken: number;
  onRunningChange: (id: string, active: boolean) => void;
}): ReactElement {
  const [runs, setRuns] = useState<AgentRoutineRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-run trust drilldown: the run id whose reasoning/preview is open.
  const [openTrust, setOpenTrust] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [monitorState, setMonitorState] = useState<RunMonitorState>("checking");

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    // [GAP-2#14] Run now answers 202 {status:"running"} and the draft
    // finishes asynchronously, so a one-shot fetch leaves the row stuck
    // on "drafting…" until the operator re-toggles. Poll while any run is
    // still in flight, bounded so a wedged run can't spin forever.
    setMonitorState("checking");
    let polls = 0;
    const fetchRuns = async (): Promise<void> => {
      try {
        const res = await agentRoutinesApi.listRuns(routineId);
        if (cancelled) return;
        if (res.error) {
          setErr(routineFailureMessage(res.error, "runs"));
          setMonitorState("error");
          return;
        }
        setErr(null);
        const items = res.data?.items ?? [];
        setRuns(items);
        const anyRunning = items.some((run) => run.status === "running");
        onRunningChange(routineId, anyRunning);
        if (anyRunning && polls < RUN_MAX_POLLS) {
          setMonitorState("watching");
          polls += 1;
          timer = window.setTimeout(() => void fetchRuns(), RUN_POLL_MS);
        } else if (anyRunning) {
          setMonitorState("paused");
        } else {
          setMonitorState("settled");
        }
      } catch (error) {
        if (!cancelled) {
          setErr(routineFailureMessage(error, "runs"));
          setMonitorState("error");
        }
      }
    };
    void fetchRuns();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [onRunningChange, routineId, refreshToken, retryToken]);

  if (err) {
    return (
      <div className="notice pw-ai-routine-runs__notice" role="alert">
        <span>Couldn&apos;t load runs: {err}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setRetryToken((token) => token + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  if (runs === null) {
    return (
      <div className="muted pw-ai-routine-runs__loading" role="status">
        Loading runs…
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="pw-ai-routine-runs__empty">
        <span className="muted">
          No runs recorded. Use Run now if permitted, or wait until an enabled
          interval routine becomes eligible.
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setRetryToken((token) => token + 1)}
        >
          Refresh runs
        </button>
      </div>
    );
  }

  return (
    <div className="pw-ai-routine-runs">
      <div
        id={`routine-run-guidance-${routineId}`}
        className="pw-action-status"
      >
        Why &amp; preview reveals the run brief, reasoning, and draft snapshot.
        View approval appears only when the routine was configured to request
        approval and that request was created successfully. Opening a draft or
        approval does not send it.
      </div>
      <div
        className={`pw-ai-routine-runs__monitor pw-ai-routine-runs__monitor--${monitorState}`}
      >
        <span role="status" aria-live="polite">
          {monitorState === "checking"
            ? "Refreshing run history…"
            : monitorState === "watching"
              ? "A background draft still reports as drafting. Checking automatically for about one minute; leaving this view does not cancel it."
              : monitorState === "paused"
                ? "The background draft still reports as drafting. Automatic checks paused after about one minute; the server-side run may still finish."
                : "Run history is up to date for this refresh."}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setRetryToken((token) => token + 1)}
          disabled={monitorState === "checking"}
        >
          Refresh runs
        </button>
      </div>
      <div className="pw-ai-routine-runs__list" role="list">
        {runs.map((run) => {
          const link = runOutputLink(run);
          const tone = runStatusTone(run.status);
          const statusLabel = runStatusLabel(run.status);
          const safeFailure = routineRunFailureMessage(run);
          const trustable = agentRunHasTrust(run);
          const trustOpen = openTrust === run.id;
          return (
            <div key={run.id} className="pw-ai-routine-run" role="listitem">
              <div className="pw-ai-routine-run__summary">
                <div className="pw-ai-routine-run__status">
                  <span
                    className={tone ? `badge ${tone}` : "badge"}
                    aria-label={`Run status: ${statusLabel}`}
                  >
                    {statusLabel}
                  </span>
                  <span className="muted tabular">
                    Started {fmtDateTime(run.started_at)}
                  </span>
                </div>
                <div className="pw-ai-routine-run__outcome">
                  {safeFailure ? (
                    <span className="pw-ai-routine-run__failure">
                      {safeFailure}
                    </span>
                  ) : null}
                  {link ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        navigateDesktopSectionResource(link.section, link.id);
                      }}
                      aria-label={link.label}
                    >
                      {link.label}
                    </button>
                  ) : run.output_ref ? (
                    <span className="muted">
                      A draft reference exists, but this app can&apos;t open its
                      output type.
                    </span>
                  ) : run.status === "running" ? (
                    <span className="muted">Drafting in the background…</span>
                  ) : !safeFailure ? (
                    <span className="muted">No draft output was recorded.</span>
                  ) : null}
                </div>
              </div>
              <div
                className="pw-ai-routine-run__actions"
                role="group"
                aria-label={`Review actions for run started ${fmtDateTime(run.started_at)}`}
              >
                {trustable ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() =>
                      setOpenTrust((cur) => (cur === run.id ? null : run.id))
                    }
                    aria-expanded={trustOpen}
                    aria-controls={`routine-run-trust-${run.id}`}
                    aria-describedby={`routine-run-guidance-${routineId}`}
                  >
                    {trustOpen ? "Hide reasoning" : "Why & preview"}
                  </button>
                ) : null}
                {run.approval_id ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      navigateDesktopSectionResource(
                        "approvals",
                        run.approval_id ?? "",
                      );
                    }}
                    aria-describedby={`routine-run-guidance-${routineId}`}
                  >
                    View approval
                  </button>
                ) : null}
              </div>
              {trustOpen ? (
                <div
                  id={`routine-run-trust-${run.id}`}
                  className="pw-ai-routine-run__trust"
                >
                  <AgentTrustPanel run={run} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- create / edit modal --------------------------------------- */

interface EditorProps {
  open: boolean;
  /** null = create. Kind is immutable on edit (no PATCH field). */
  routine: AgentRoutine | null;
  canMutate: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function RoutineTargetFields({
  disabled,
  onRetrySegments,
  onSegmentChange,
  segmentFailure,
  segmentMissing,
  segmentOptions,
  segmentTransport,
  targetSegmentId,
}: {
  disabled: boolean;
  onRetrySegments: () => void;
  onSegmentChange: (id: string) => void;
  segmentFailure: RemoteFailure | null;
  segmentMissing: boolean;
  segmentOptions: TargetOptions["segments"];
  segmentTransport: TargetOptions["segmentTransport"];
  targetSegmentId: string;
}): ReactElement {
  return (
    <div className="pw-ai-routine-editor__target">
      <div className="field">
        <label className="field-label" htmlFor="routine-target-segment">
          Target segment (optional)
        </label>
        <select
          id="routine-target-segment"
          className="input"
          value={targetSegmentId}
          disabled={disabled || segmentTransport !== "ready"}
          aria-describedby="routine-target-segment-status"
          onChange={(event) => onSegmentChange(event.target.value)}
        >
          <option value="">
            {segmentTransport === "loading"
              ? "Loading canonical segments…"
              : "— none —"}
          </option>
          {segmentMissing ? (
            <option value={targetSegmentId}>
              (current: {targetSegmentId} —{" "}
              {segmentTransport === "ready"
                ? "not in the canonical segment catalog"
                : "catalog not verified"}
              )
            </option>
          ) : null}
          {segmentOptions.map((segment) => (
            <option key={segment.id} value={segment.id}>
              {segment.name}
            </option>
          ))}
        </select>
        <div id="routine-target-segment-status" className="pw-action-status">
          {segmentTransport === "loading" ? (
            <span role="status" aria-live="polite">
              Verifying canonical audience definitions…
            </span>
          ) : segmentTransport === "error" && segmentFailure ? (
            <span className="notice" role="alert">
              <span>
                <strong>Couldn&apos;t verify canonical segments.</strong>{" "}
                {segmentFailure.message}
              </span>
              <span className="spacer" />
              {targetSegmentId ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onSegmentChange("")}
                  disabled={disabled}
                >
                  Clear target
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={onRetrySegments}
                disabled={disabled}
              >
                Retry segments
              </button>
            </span>
          ) : segmentOptions.length === 0 ? (
            <span>
              No canonical segments exist yet. Create one under Audience →
              Segments, or leave this optional target empty.
            </span>
          ) : (
            <span>
              {segmentOptions.length.toLocaleString()} canonical segment
              {segmentOptions.length === 1 ? "" : "s"} available.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

interface RoutineEditorFormFieldsProps {
  routine: AgentRoutine | null;
  disabled: boolean;
  name: string;
  prompt: string;
  kind: AgentRoutineKind;
  schedule: AgentRoutineSchedule;
  legacyTargetListId: string | null;
  clearLegacyTargetList: boolean;
  targetSegmentId: string;
  requireApproval: boolean;
  enabled: boolean;
  submitErr: string | null;
  segmentFailure: RemoteFailure | null;
  segmentMissing: boolean;
  segmentOptions: TargetOptions["segments"];
  segmentTransport: TargetOptions["segmentTransport"];
  nameRef: RefObject<HTMLInputElement | null>;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  onNameChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onKindChange: (value: AgentRoutineKind) => void;
  onScheduleChange: (value: AgentRoutineSchedule) => void;
  onToggleLegacyTargetList: () => void;
  onRetrySegments: () => void;
  onSegmentChange: (value: string) => void;
  onRequireApprovalChange: (value: boolean) => void;
  onEnabledChange: (value: boolean) => void;
}

function RoutineEditorFormFields({
  routine,
  disabled,
  name,
  prompt,
  kind,
  schedule,
  legacyTargetListId,
  clearLegacyTargetList,
  targetSegmentId,
  requireApproval,
  enabled,
  submitErr,
  segmentFailure,
  segmentMissing,
  segmentOptions,
  segmentTransport,
  nameRef,
  promptRef,
  onNameChange,
  onPromptChange,
  onKindChange,
  onScheduleChange,
  onToggleLegacyTargetList,
  onRetrySegments,
  onSegmentChange,
  onRequireApprovalChange,
  onEnabledChange,
}: RoutineEditorFormFieldsProps): ReactElement {
  const nameLength = Array.from(name.trim()).length;
  const promptLength = Array.from(prompt.trim()).length;
  const nameOverLimit = nameLength > ROUTINE_NAME_MAX;
  const promptOverLimit = promptLength > ROUTINE_PROMPT_MAX;
  const nameInvalid = nameOverLimit || (!!submitErr && !name.trim());
  const promptInvalid = promptOverLimit || (!!submitErr && !prompt.trim());
  // HTML maxLength counts UTF-16 code units while the Go contract counts
  // Unicode runes. Two code units per allowed rune keeps valid emoji input
  // possible; the rune-aware validation/count below enforces the real limit.
  const nameInputMax = ROUTINE_NAME_MAX * 2;
  const promptInputMax = ROUTINE_PROMPT_MAX * 2;

  return (
    <>
      <div className="field pw-ai-routine-editor__field">
        <label className="field-label" htmlFor="routine-name">
          Name
        </label>
        <input
          ref={nameRef}
          id="routine-name"
          type="text"
          className="input"
          placeholder="e.g. Weekly newsletter draft"
          value={name}
          maxLength={nameInputMax}
          onChange={(event) => onNameChange(event.target.value)}
          disabled={disabled}
          aria-describedby={
            nameInvalid && submitErr
              ? "routine-name-count routine-submit-error"
              : "routine-name-count"
          }
          aria-invalid={nameInvalid ? "true" : undefined}
        />
        <span
          id="routine-name-count"
          className={`pw-ai-routine-editor__count${
            nameOverLimit ? " pw-ai-routine-editor__count--over" : ""
          }`}
        >
          {nameLength.toLocaleString()} / {ROUTINE_NAME_MAX.toLocaleString()}
        </span>
      </div>

      <div className="field pw-ai-routine-editor__field">
        <label className="field-label" htmlFor="routine-prompt">
          Prompt / brief
        </label>
        <textarea
          ref={promptRef}
          id="routine-prompt"
          className="input"
          rows={5}
          placeholder="What should the agent draft each run? Audience, topic, structure, tone…"
          value={prompt}
          maxLength={promptInputMax}
          onChange={(event) => onPromptChange(event.target.value)}
          disabled={disabled}
          aria-describedby={
            promptInvalid && submitErr
              ? "routine-prompt-count routine-submit-error"
              : "routine-prompt-count"
          }
          aria-invalid={promptInvalid ? "true" : undefined}
        />
        <span
          id="routine-prompt-count"
          className={`pw-ai-routine-editor__count${
            promptOverLimit ? " pw-ai-routine-editor__count--over" : ""
          }`}
        >
          {promptLength.toLocaleString()} /{" "}
          {ROUTINE_PROMPT_MAX.toLocaleString()}
        </span>
      </div>

      <div className="pw-ai-routine-editor__grid">
        <div className="field">
          <label className="field-label" htmlFor="routine-kind">
            Draft type
          </label>
          <select
            id="routine-kind"
            className="input"
            value={kind}
            disabled={disabled || routine !== null}
            onChange={(event) =>
              onKindChange(event.target.value as AgentRoutineKind)
            }
            aria-describedby={routine ? "routine-kind-reason" : undefined}
          >
            {ROUTINE_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {routine ? (
            <div id="routine-kind-reason" className="pw-action-status">
              Draft type can&apos;t change after creation. Create a new routine
              to use another type.
            </div>
          ) : null}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="routine-schedule">
            Run interval
          </label>
          <select
            id="routine-schedule"
            className="input"
            value={schedule}
            disabled={disabled}
            onChange={(event) =>
              onScheduleChange(event.target.value as AgentRoutineSchedule)
            }
            aria-describedby="routine-schedule-guidance"
          >
            {ROUTINE_SCHEDULES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div id="routine-schedule-guidance" className="pw-action-status">
            Automatic values are elapsed intervals after the most recent run
            started—not fixed calendar or workspace-timezone appointments. If
            there is no prior run, an enabled interval routine is eligible on
            the next scheduler scan.
          </div>
        </div>
      </div>

      {legacyTargetListId ? (
        <div className="notice pw-ai-routine-editor__legacy" role="note">
          <span>
            <strong>Legacy list target is inactive.</strong> An older version
            stored an incompatible list reference. It is ignored by every run
            and has never selected the draft audience.
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={disabled}
            onClick={onToggleLegacyTargetList}
          >
            {clearLegacyTargetList
              ? "Keep legacy reference"
              : "Remove legacy reference on save"}
          </button>
          {clearLegacyTargetList ? (
            <span className="muted">
              The inert reference will be removed only when this edit is saved.
            </span>
          ) : null}
        </div>
      ) : null}

      <RoutineTargetFields
        disabled={disabled}
        onRetrySegments={onRetrySegments}
        onSegmentChange={onSegmentChange}
        segmentFailure={segmentFailure}
        segmentMissing={segmentMissing}
        segmentOptions={segmentOptions}
        segmentTransport={segmentTransport}
        targetSegmentId={targetSegmentId}
      />

      <div className="pw-ai-routine-editor__toggles">
        <div className="pw-ai-routine-editor__toggle">
          <input
            id="routine-require-approval"
            type="checkbox"
            checked={requireApproval}
            disabled={disabled}
            onChange={(event) => onRequireApprovalChange(event.target.checked)}
          />
          <label
            className="pw-ai-routine-editor__toggle-copy"
            htmlFor="routine-require-approval"
          >
            Create an approval request for each draft
            <span className="muted">
              When on, a successful run also opens a pending Approvals item.
              When off, no approval request is created; the output remains a
              draft in Campaigns or Sequences.
            </span>
          </label>
        </div>
        <div className="pw-ai-routine-editor__toggle">
          <input
            id="routine-enabled"
            type="checkbox"
            checked={enabled}
            disabled={disabled || schedule === "manual"}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <label
            className="pw-ai-routine-editor__toggle-copy"
            htmlFor="routine-enabled"
          >
            Allow automatic interval runs
            <span className="muted">
              {schedule === "manual"
                ? "Manual is Run now only. Choose an interval to configure automatic eligibility."
                : "This affects automatic eligibility only. Permitted Run now remains available when the interval is paused."}
            </span>
          </label>
        </div>
      </div>
    </>
  );
}

function RoutineEditorModal({
  open,
  routine,
  canMutate,
  onClose,
  onSaved,
}: EditorProps): ReactElement {
  const [name, setName] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [kind, setKind] = useState<AgentRoutineKind>("draft_campaign");
  const [schedule, setSchedule] = useState<AgentRoutineSchedule>("manual");
  const [legacyTargetListId, setLegacyTargetListId] = useState<string | null>(
    null,
  );
  const [clearLegacyTargetList, setClearLegacyTargetList] =
    useState<boolean>(false);
  const [targetSegmentId, setTargetSegmentId] = useState<string>("");
  // Defaults ON so new routines request review by default. Turning it off is
  // explicit and still produces an inert draft; it does not authorize sending.
  const [requireApproval, setRequireApproval] = useState<boolean>(true);
  const [enabled, setEnabled] = useState<boolean>(true);

  const [targets, setTargets] = useState<TargetOptions | null>(null);
  const [targetsRevision, setTargetsRevision] = useState(0);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [baselineFingerprint, setBaselineFingerprint] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const saveOperation = useSingleFlightOperation({
    ownerId: "agent-routine-save",
    label: "Agent routine save",
    detail: "Wait for the routine to finish saving before leaving.",
  });
  const submitting = saveOperation.active;

  // Hydrate on every open.
  useEffect(() => {
    if (!open) return;
    setSubmitErr(null);
    setDiscardOpen(false);
    if (routine) {
      setName(routine.name);
      setPrompt(routine.prompt);
      setKind(routine.kind);
      setSchedule(routine.schedule);
      setLegacyTargetListId(routine.target_list_id?.trim() || null);
      setClearLegacyTargetList(false);
      setTargetSegmentId(routine.target_segment_id ?? "");
      setRequireApproval(routine.require_approval);
      setEnabled(routine.enabled);
      setBaselineFingerprint(
        routineDraftFingerprint({
          name: routine.name,
          prompt: routine.prompt,
          kind: routine.kind,
          schedule: routine.schedule,
          targetSegmentId: routine.target_segment_id ?? "",
          clearLegacyTargetList: false,
          requireApproval: routine.require_approval,
          enabled: routine.enabled,
        }),
      );
    } else {
      setName("");
      setPrompt("");
      setKind("draft_campaign");
      setSchedule("manual");
      setLegacyTargetListId(null);
      setClearLegacyTargetList(false);
      setTargetSegmentId("");
      setRequireApproval(true);
      setEnabled(true);
      setBaselineFingerprint(
        routineDraftFingerprint({
          name: "",
          prompt: "",
          kind: "draft_campaign",
          schedule: "manual",
          targetSegmentId: "",
          clearLegacyTargetList: false,
          requireApproval: true,
          enabled: true,
        }),
      );
    }
  }, [open, routine]);

  // Option refresh is intentionally separate from draft hydration: retrying a
  // failed catalog must never wipe edits already made in this modal.
  useEffect(() => {
    if (!open) return;
    setTargets({
      segments: [],
      segmentTransport: "loading",
      segmentFailure: null,
    });
    let cancelled = false;
    void fetchTargetOptions()
      .then((targetOptions) => {
        if (!cancelled) setTargets(targetOptions);
      })
      .catch(() => {
        if (!cancelled) {
          setTargets({
            segments: [],
            segmentTransport: "error",
            segmentFailure: remoteFailureFromError({ kind: "network" }),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, routine?.id, targetsRevision]);

  async function submit(): Promise<void> {
    if (!canMutate) {
      setSubmitErr("Viewer access is read-only. This routine wasn't saved.");
      return;
    }
    const err = validateRoutineDraft(name, prompt);
    if (err) {
      setSubmitErr(err);
      if (!name.trim() || Array.from(name.trim()).length > ROUTINE_NAME_MAX) {
        nameRef.current?.focus();
      } else {
        promptRef.current?.focus();
      }
      return;
    }
    setSubmitErr(null);
    const common = {
      name: name.trim(),
      prompt: prompt.trim(),
      schedule,
      target_segment_id: targetIdOrNull(targetSegmentId),
      require_approval: requireApproval,
      enabled,
    };
    const request = saveOperation.run(() =>
      routine
        ? agentRoutinesApi.update(
            routine.id,
            clearLegacyTargetList && legacyTargetListId
              ? { ...common, target_list_id: "" }
              : common,
          )
        : agentRoutinesApi.create({ ...common, kind }),
    );
    if (!request) {
      await saveOperation.wait().catch(() => undefined);
      return;
    }
    try {
      const res = await request;
      if (res.error) {
        setSubmitErr(routineFailureMessage(res.error, "save"));
        return;
      }
      toast.success(routine ? "Routine updated" : "Routine created");
      onSaved();
    } catch (error) {
      setSubmitErr(routineFailureMessage(error, "save"));
    }
  }

  // Preserve the stored segment while its catalog loads/fails; only call it
  // missing once a verified canonical catalog proves it is absent.
  const segmentOptions = targets?.segments ?? [];
  const segmentTransport = targets?.segmentTransport ?? "loading";
  const segmentFailure = targets?.segmentFailure ?? null;
  const segmentMissing =
    targetSegmentId !== "" &&
    (segmentTransport !== "ready" ||
      !segmentOptions.some((s) => s.id === targetSegmentId));
  const currentFingerprint = routineDraftFingerprint({
    name,
    prompt,
    kind,
    schedule,
    targetSegmentId,
    clearLegacyTargetList,
    requireApproval,
    enabled,
  });
  const dirty = open && currentFingerprint !== baselineFingerprint;
  const editorDisabled = submitting || !canMutate;
  const requestClose = (): void => {
    if (submitting) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };
  const discardChanges = (): void => {
    setDiscardOpen(false);
    onClose();
  };

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        closeOnBackdrop={!submitting}
        closeOnEscape={!submitting}
        closeDisabled={submitting}
        title={routine ? "Edit routine" : "New routine"}
        description="A successful run creates a draft only. This routine creates an approval request only when the option below is on; it never sends."
        size="lg"
      >
        <div className="pw-ai-routine-editor">
          {!canMutate ? (
            <div className="pw-ai-routines__viewer" role="status">
              <strong>Read-only viewer</strong>
              <span>
                Your role changed while this editor was open. Review is still
                available, but saving is disabled.
              </span>
            </div>
          ) : null}

          <RoutineEditorFormFields
            routine={routine}
            disabled={editorDisabled}
            name={name}
            prompt={prompt}
            kind={kind}
            schedule={schedule}
            legacyTargetListId={legacyTargetListId}
            clearLegacyTargetList={clearLegacyTargetList}
            targetSegmentId={targetSegmentId}
            requireApproval={requireApproval}
            enabled={enabled}
            submitErr={submitErr}
            segmentFailure={segmentFailure}
            segmentMissing={segmentMissing}
            segmentOptions={segmentOptions}
            segmentTransport={segmentTransport}
            nameRef={nameRef}
            promptRef={promptRef}
            onNameChange={(value) => {
              setName(value);
              setSubmitErr(null);
            }}
            onPromptChange={(value) => {
              setPrompt(value);
              setSubmitErr(null);
            }}
            onKindChange={setKind}
            onScheduleChange={setSchedule}
            onToggleLegacyTargetList={() =>
              setClearLegacyTargetList((current) => !current)
            }
            onRetrySegments={() =>
              setTargetsRevision((revision) => revision + 1)
            }
            onSegmentChange={setTargetSegmentId}
            onRequireApprovalChange={setRequireApproval}
            onEnabledChange={setEnabled}
          />

          {submitErr ? (
            <div id="routine-submit-error" className="field-error" role="alert">
              {submitErr}
            </div>
          ) : null}

          <div className="pw-ai-routine-editor__save-state" role="status">
            {dirty ? "Unsaved changes" : "No unsaved changes"}
          </div>

          <ModalFooter>
            <button
              type="button"
              className="btn"
              onClick={requestClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={editorDisabled}
              aria-busy={submitting ? "true" : undefined}
            >
              {submitting
                ? "Saving…"
                : routine
                  ? "Save changes"
                  : "Create routine"}
            </button>
          </ModalFooter>
        </div>
      </Modal>

      <ConfirmModal
        open={open && discardOpen}
        title="Discard unsaved changes?"
        description={`Closing now discards the unsaved changes to ${routine ? `"${routine.name}"` : "this new routine"}. Existing routines, drafts, and approvals are unaffected.`}
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        danger
        onConfirm={discardChanges}
        onClose={() => setDiscardOpen(false)}
      />
    </>
  );
}
