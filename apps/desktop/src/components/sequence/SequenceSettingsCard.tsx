/**
 * SequenceSettingsCard — sequence-level goal / exit criteria + stuck
 * threshold. Sits under the trigger card on the canvas.
 *
 * Persistence lives one level up in StepCanvas (same pattern as the
 * trigger): this card edits a local draft and emits a single PATCH
 * payload via onSave so the canvas can thread the If-Match version.
 *
 * Honest-UI notes rendered verbatim next to the controls:
 *   - conversion goals are stored but not yet evaluated (no conversion
 *     event source feeds sequences);
 *   - exit_on_goal can't stop engine-side sends yet — goal-met
 *     participants merely show as completed_goal in the participants
 *     view;
 *   - stuck_after_days 0 = off, 1..365 enables the stuck report.
 */
import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { type SequenceGoal } from "../../lib/api-client";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { SEQUENCE_RUNTIME_AVAILABLE } from "../../lib/sequence-operational-availability";
import {
  EXIT_ON_GOAL_CAVEAT,
  GOAL_KIND_OPTIONS,
  type GoalKind,
  STUCK_AFTER_DAYS_MAX,
  goalKindCaveat,
  parseStuckAfterDays,
} from "./sequence-settings";

interface Props {
  goal: SequenceGoal | null;
  stuckAfterDays: number;
  /** Editor + admin only; viewer renders the controls disabled. */
  canMutate: boolean;
  saving: boolean;
  /** Goal/stuck controls are planning metadata until execution is qualified. */
  runtimeAvailable?: boolean;
  onSave: (patch: {
    goal: SequenceGoal | null;
    stuck_after_days: number;
  }) => void;
}

/** "" in the select means "no goal configured". */
type GoalKindDraft = GoalKind | "";

export function SequenceSettingsCard({
  goal,
  stuckAfterDays,
  canMutate,
  saving,
  runtimeAvailable = SEQUENCE_RUNTIME_AVAILABLE,
  onSave,
}: Props): ReactElement {
  const [goalKind, setGoalKind] = useState<GoalKindDraft>(goal?.kind ?? "");
  const [exitOnGoal, setExitOnGoal] = useState(goal?.exit_on_goal ?? false);
  const [stuckDays, setStuckDays] = useState(
    stuckAfterDays > 0 ? String(stuckAfterDays) : "0",
  );
  const [err, setErr] = useState<string | null>(null);
  const saveDescriptionId = useId();
  const saveRequestedRef = useRef(false);

  // Re-seed when the canvas reloads the row (initial GET / post-save).
  useEffect(() => {
    setGoalKind(goal?.kind ?? "");
    setExitOnGoal(goal?.exit_on_goal ?? false);
    setStuckDays(stuckAfterDays > 0 ? String(stuckAfterDays) : "0");
    setErr(null);
  }, [goal, stuckAfterDays]);

  const stuckParsed = parseStuckAfterDays(stuckDays);
  const storedStuckDays = stuckAfterDays > 0 ? String(stuckAfterDays) : "0";
  const dirty =
    goalKind !== (goal?.kind ?? "") ||
    (goalKind !== "" && exitOnGoal !== (goal?.exit_on_goal ?? false)) ||
    stuckDays !== storedStuckDays;

  useEffect(() => {
    if (!dirty && !saving) return;
    return registerLifecycleGuard({
      id: "sequence-settings-draft",
      label: "Sequence goal settings",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving
            ? {
                level: "blocking",
                detail: "Sequence settings are still being saved.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "Sequence goal settings have unsaved local changes.",
              },
      discard: () => {
        setGoalKind(goal?.kind ?? "");
        setExitOnGoal(goal?.exit_on_goal ?? false);
        setStuckDays(stuckAfterDays > 0 ? String(stuckAfterDays) : "0");
        setErr(null);
      },
    });
  }, [dirty, goal, saving, stuckAfterDays]);

  const save = (): void => {
    if (!canMutate || saving || saveRequestedRef.current || !dirty) return;
    const parsed = parseStuckAfterDays(stuckDays);
    if (!parsed.ok) {
      setErr(parsed.message);
      return;
    }
    setErr(null);
    saveRequestedRef.current = true;
    try {
      onSave({
        goal:
          goalKind === "" ? null : { kind: goalKind, exit_on_goal: exitOnGoal },
        stuck_after_days: parsed.value,
      });
    } catch {
      setErr("Sequence settings couldn't be saved. Try again.");
    } finally {
      queueMicrotask(() => {
        saveRequestedRef.current = false;
      });
    }
  };

  const saveUnavailableReason = !canMutate
    ? "Viewer role can't change sequence settings."
    : saving
      ? "Sequence settings are already being saved."
      : !stuckParsed.ok
        ? stuckParsed.message
        : !dirty
          ? "No changes to save."
          : null;

  return (
    <div
      className="seq-trigger-card"
      role="region"
      aria-label="Sequence goal and stuck settings"
    >
      <div className="seq-trigger-card-icon" aria-hidden="true">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Target / bullseye — "what does success look like". */}
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1" />
        </svg>
      </div>
      <div className="seq-trigger-card-body">
        <div className="seq-trigger-card-eyebrow">Goal &amp; exit criteria</div>

        {!runtimeAvailable ? (
          <div className="seq-trigger-warning" role="status">
            Planning metadata only — this build does not evaluate goals, exit
            participants, or generate stuck-participant reports.
          </div>
        ) : null}

        <div className="field" style={{ marginTop: 6 }}>
          <label className="field-label" htmlFor="seq-goal-kind">
            Goal
          </label>
          <select
            id="seq-goal-kind"
            className="input"
            value={goalKind}
            disabled={!canMutate || saving}
            onChange={(e) => {
              setErr(null);
              setGoalKind(e.target.value as GoalKindDraft);
            }}
          >
            <option value="">No goal</option>
            {GOAL_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {goalKind !== "" ? (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {goalKindCaveat(goalKind)}
            </div>
          ) : null}
        </div>

        {goalKind !== "" ? (
          <div className="field">
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: canMutate ? "pointer" : "default",
              }}
            >
              <input
                type="checkbox"
                checked={exitOnGoal}
                disabled={!canMutate || saving}
                onChange={(e) => {
                  setErr(null);
                  setExitOnGoal(e.target.checked);
                }}
              />
              Exit the sequence when the goal is met
            </label>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {EXIT_ON_GOAL_CAVEAT}
            </div>
          </div>
        ) : null}

        <div className="field">
          <label className="field-label" htmlFor="seq-stuck-days">
            Mark participants stuck after
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="seq-stuck-days"
              type="number"
              className="input"
              min={0}
              max={STUCK_AFTER_DAYS_MAX}
              step={1}
              style={{ width: 100 }}
              value={stuckDays}
              disabled={!canMutate || saving}
              onChange={(e) => {
                setErr(null);
                setStuckDays(e.target.value);
              }}
            />
            <span className="muted" style={{ fontSize: 12 }}>
              days idle (0 = off, max {STUCK_AFTER_DAYS_MAX})
            </span>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {runtimeAvailable
              ? "Powers the Stuck tab in the subscribers drawer for participants whose last sequence activity exceeds this threshold."
              : "Stored with the draft for future runtime planning; it does not currently monitor participants."}
          </div>
        </div>

        {/* Live parse error (keeps showing while Save is disabled) or
            the last save-time error, whichever is relevant. */}
        {!stuckParsed.ok ? (
          <div className="field-error">{stuckParsed.message}</div>
        ) : err ? (
          <div className="field-error">{err}</div>
        ) : null}
      </div>
      <div className="seq-trigger-card-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={save}
          aria-disabled={saveUnavailableReason !== null || undefined}
          aria-describedby={saveDescriptionId}
          aria-busy={saving || undefined}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        <span id={saveDescriptionId} className="visually-hidden">
          {saveUnavailableReason ?? "Save goal and stuck-threshold settings."}
        </span>
      </div>
    </div>
  );
}
