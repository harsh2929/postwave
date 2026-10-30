/**
 * ResourceProgressBar — one row in the live progress view, showing
 * percent + "234 of 1500 subscribers" with a horizontal bar.
 *
 * Pure: parent supplies counts. Hidden when total is 0 so we never show
 * a phantom "automations" row for sources without automations support.
 */

import { type ReactElement } from "react";

interface Props {
  /** Display label, e.g. "Subscribers". */
  resource: string;
  completed: number;
  total: number;
  /** Free-form phase line, e.g. "Importing page 5 of 30". */
  step?: string;
  /** Optional value copy when done/total would be misleading. */
  valueLabel?: string;
}

export function ResourceProgressBar({
  resource,
  completed,
  total,
  step,
  valueLabel,
}: Props): ReactElement | null {
  if (total <= 0 && completed <= 0) return null;
  const inconsistent = completed > total;
  const pct =
    total > 0 && !inconsistent
      ? Math.min(100, Math.max(0, Math.round((completed / total) * 100)))
      : null;
  const done = pct === 100;
  const countLabel = inconsistent
    ? `${completed.toLocaleString()} reported of ${total.toLocaleString()} · counts require review`
    : [
        completed.toLocaleString(),
        total > 0 ? ` of ${total.toLocaleString()}` : "",
        pct !== null ? ` · ${pct}%` : " · percentage pending",
      ].join("");
  return (
    <div
      className="resource-progress-bar"
      data-resource={resource}
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          fontSize: 12,
        }}
      >
        <span>
          <strong>{resource}</strong>
          {step ? (
            <span style={{ color: "var(--pw-fg-muted)" }}> · {step}</span>
          ) : null}
        </span>
        <span className="tabular" style={{ color: "var(--pw-fg-muted)" }}>
          {valueLabel ?? countLabel}
        </span>
      </div>
      <div
        className="wizard-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={
          inconsistent
            ? `${completed.toLocaleString()} completed exceeds the reported total of ${total.toLocaleString()}; verified percentage unavailable`
            : undefined
        }
        aria-label={`${resource} progress`}
        style={{
          height: 6,
          background: "var(--pw-border)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          className="wizard-progress-fill"
          style={{
            height: "100%",
            width: `${pct ?? 0}%`,
            background: done ? "var(--pw-success)" : "var(--pw-accent)",
            transition: "width 200ms ease-out",
          }}
        />
      </div>
    </div>
  );
}
