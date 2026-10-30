import { type CSSProperties, type ReactElement, useId } from "react";

import type { TenantGoal, TenantGoalProgress } from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

import {
  clampFraction,
  formatGoalPct,
  formatGoalValue,
  formatPeriodRange,
  goalDisplayName,
  goalMetricLabel,
  paceBadge,
} from "./goals-helpers";
import "./dashboard-insight-cards.css";

interface GoalProgressViewProps {
  rows: TenantGoalProgress[] | null;
  asOf: string | null;
  loadFailure: "initial" | "refresh" | null;
  refreshing: boolean;
  canAdmin: boolean;
  onRetry: () => void;
  onNew: () => void;
  onEdit: (goal: TenantGoal) => void;
  onDelete: (goal: TenantGoal) => void;
}

/**
 * Goal presentation boundary. Fetch/mutation ownership stays in GoalsCard;
 * this component only renders the acknowledged server state and actions.
 */
export function GoalProgressView({
  rows,
  asOf,
  loadFailure,
  refreshing,
  canAdmin,
  onRetry,
  onNew,
  onEdit,
  onDelete,
}: GoalProgressViewProps): ReactElement {
  const titleId = useId();
  const loading = rows === null && loadFailure !== "initial";
  const sourceTime = loading
    ? "Data timestamp pending"
    : asOf
      ? `Data as of ${fmtDateTime(asOf)}`
      : "Source timestamp unavailable";

  return (
    <section
      className="card dashboard-insight-card dashboard-goals-card"
      aria-labelledby={titleId}
      aria-busy={loading || refreshing || undefined}
    >
      <header className="dashboard-insight-card__header">
        <div className="dashboard-insight-card__heading">
          <span className="dashboard-insight-card__eyebrow">
            Workspace goals
          </span>
          <h2 id={titleId} className="dashboard-insight-card__title">
            Goals &amp; pacing
          </h2>
          <p className="dashboard-insight-card__subtitle">
            Server-computed progress against each goal&apos;s current period.
          </p>
        </div>
        <div className="dashboard-insight-card__header-actions">
          {canAdmin ? (
            <button
              type="button"
              className="btn dashboard-insight-card__action"
              onClick={onNew}
            >
              New goal
            </button>
          ) : (
            <div
              className="dashboard-insight-card__access"
              aria-label="Goal management is read only"
            >
              <span className="badge">Read only</span>
              <span>Workspace admins manage goals</span>
            </div>
          )}
        </div>
      </header>

      <div
        className="dashboard-insight-card__provenance"
        aria-label="Goal data provenance"
      >
        <span>Moosewave goals progress API</span>
        <span>Current workspace</span>
        <span>{sourceTime}</span>
        {refreshing ? (
          <span role="status" aria-live="polite">
            Refreshing latest progress…
          </span>
        ) : null}
      </div>

      {loadFailure === "initial" ? (
        <div
          className="dashboard-insight-state dashboard-insight-state--error"
          role="alert"
        >
          <div className="dashboard-insight-state__copy">
            <h3>Goals unavailable</h3>
            <p>
              We couldn&apos;t load goals. Check your connection and try again.
            </p>
          </div>
          <button
            type="button"
            className="btn dashboard-insight-state__action"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      ) : rows === null ? (
        <div
          className="dashboard-insight-state dashboard-insight-state--loading"
          role="status"
          aria-label="Loading goal progress"
        >
          <span className="visually-hidden">Loading goal progress…</span>
          {[0, 1].map((key) => (
            <div
              key={key}
              className="dashboard-goal-skeleton"
              aria-hidden="true"
            >
              <div className="skel dashboard-goal-skeleton__title" />
              <div className="skel dashboard-goal-skeleton__meta" />
              <div className="skel dashboard-goal-skeleton__bar" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {loadFailure === "refresh" ? (
            <div
              className="dashboard-insight-state dashboard-insight-state--warning"
              role="alert"
            >
              <div className="dashboard-insight-state__copy">
                <h3>Latest progress couldn&apos;t be refreshed</h3>
                <p>
                  Showing the last confirmed goal data. Check your connection
                  and try again.
                </p>
              </div>
              <button
                type="button"
                className="btn dashboard-insight-state__action"
                onClick={onRetry}
              >
                Retry
              </button>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="dashboard-insight-state" role="status">
              <div className="dashboard-insight-state__copy">
                <h3>No goals yet</h3>
                <p>
                  Set a target — subscribers, open rate, revenue or list growth
                  — and this card tracks your pace against it each period.
                </p>
              </div>
              {canAdmin ? (
                <button
                  type="button"
                  className="btn btn-primary dashboard-insight-state__action"
                  onClick={onNew}
                >
                  Set your first goal
                </button>
              ) : (
                <p className="dashboard-insight-state__reason">
                  A workspace admin can create goals.
                </p>
              )}
            </div>
          ) : (
            <GoalProgressRows
              rows={rows}
              asOf={asOf}
              canAdmin={canAdmin}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          )}
        </>
      )}
    </section>
  );
}

function GoalProgressRows({
  rows,
  asOf,
  canAdmin,
  onEdit,
  onDelete,
}: {
  rows: TenantGoalProgress[];
  asOf: string | null;
  canAdmin: boolean;
  onEdit: (goal: TenantGoal) => void;
  onDelete: (goal: TenantGoal) => void;
}): ReactElement {
  return (
    <div className="dashboard-insight-card__body">
      <ul className="dashboard-goal-list" aria-label="Goal progress">
        {rows.map((progress) => (
          <GoalRow
            key={progress.goal.id}
            row={progress}
            canAdmin={canAdmin}
            onEdit={() => onEdit(progress.goal)}
            onDelete={() => onDelete(progress.goal)}
          />
        ))}
      </ul>
      <AccessibleChartData
        title="Goal progress and pacing"
        summary={`${rows.length} active goals with server-computed current value, target, completion percentage, pace and period.`}
        rowHeaderLabel="Goal"
        columns={[
          { key: "metric", label: "Metric" },
          { key: "current", label: "Current value" },
          { key: "target", label: "Target value" },
          { key: "progress", label: "Progress (%)" },
          { key: "pace", label: "Pace" },
          { key: "period", label: "Period" },
        ]}
        rows={rows.map((row) => ({
          key: row.goal.id,
          label: goalDisplayName(row.goal),
          values: {
            metric: goalMetricLabel(row.goal.metric),
            current: formatGoalValue(row.goal.metric, row.current),
            target: formatGoalValue(row.goal.metric, row.target),
            progress: formatGoalPct(row.pct),
            pace: paceBadge(row.pace).label,
            period: formatPeriodRange(row.period_start, row.period_end),
          },
          exportValues: {
            metric: row.goal.metric,
            current: row.current,
            target: row.target,
            progress: row.pct * 100,
            pace: row.pace,
            period: `${row.period_start} – ${row.period_end}`,
          },
        }))}
        provenance={dux025Provenance("goalsProgress", {
          scope: `Current workspace · ${rows.length} active goal periods`,
          asOf,
        })}
        exportFileName="goal-progress-and-pacing.csv"
        exportPrivacy="confidential"
      />
    </div>
  );
}

function GoalRow({
  row,
  canAdmin,
  onEdit,
  onDelete,
}: {
  row: TenantGoalProgress;
  canAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): ReactElement {
  const goal = row.goal;
  const name = goalDisplayName(goal);
  const badge = paceBadge(row.pace);
  const width = clampFraction(row.pct);
  const progressStyle = {
    "--dashboard-goal-progress": `${width * 100}%`,
  } as CSSProperties;

  return (
    <li className="dashboard-goal-row">
      <div className="dashboard-goal-row__header">
        <div className="dashboard-goal-row__identity">
          <div className="dashboard-goal-row__name-line">
            <span className="dashboard-goal-row__name">{name}</span>
            <span className={`${badge.className} dashboard-goal-row__pace`}>
              {badge.label}
            </span>
          </div>
          <span className="dashboard-goal-row__period tabular">
            Current period ·{" "}
            {formatPeriodRange(row.period_start, row.period_end)}
          </span>
        </div>
        {canAdmin ? (
          <div
            className="dashboard-goal-row__actions"
            aria-label={`Actions for ${name}`}
          >
            <button
              type="button"
              className="btn"
              onClick={onEdit}
              aria-label={`Edit goal ${name}`}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn dashboard-goal-row__delete"
              onClick={onDelete}
              aria-label={`Delete goal ${name}`}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
      <div className="dashboard-goal-row__progress-group">
        <div
          className="dashboard-goal-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(width * 100)}
          aria-valuetext={`${formatGoalValue(goal.metric, row.current)} of ${formatGoalValue(goal.metric, row.target)} · ${formatGoalPct(row.pct)} · ${badge.label}`}
          aria-label={`${name} progress`}
          style={progressStyle}
        >
          <span className="dashboard-goal-progress__fill" />
        </div>
        <div className="dashboard-goal-row__values tabular">
          <strong>{formatGoalValue(goal.metric, row.current)}</strong>
          <span>of {formatGoalValue(goal.metric, row.target)}</span>
          <span>{formatGoalPct(row.pct)}</span>
        </div>
      </div>
    </li>
  );
}
