/**
 * ResourceBreakdown — one row per resource type in the dry-run preview
 * panel. Renders "Subscribers: 1,500 will be imported (3 already exist,
 * will be skipped)" with optional per-row notes for partial-fidelity
 * resources (a/b split → fallback, etc).
 *
 * Pure presentation. The wizard owns data fetching.
 */

import { type ReactElement } from "react";

interface Props {
  /** Canonical resource bucket name (subscribers, segments, …). */
  resource: string;
  /** Display label shown in the row header. */
  label: string;
  /** How many rows of this resource will be imported. */
  planned: number;
  /** How many will be skipped (already exist on the destination). */
  skipped?: number;
  /** Free-form per-row reasons for partial fidelity. */
  reasons?: string[];
  /** "Will be archived" / "Will be created" verb override. */
  verb?: string;
}

export function ResourceBreakdown({
  resource,
  label,
  planned,
  skipped,
  reasons,
  verb,
}: Props): ReactElement {
  const action = verb ?? "will be imported";
  return (
    <div
      className="wizard-resource-breakdown"
      data-resource={resource}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 12px",
        border: "1px solid var(--pw-border)",
        borderRadius: "var(--pw-radius-md)",
        background: "var(--pw-bg-elev)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{label}</strong>
        <span className="tabular" style={{ fontSize: 13 }}>
          {planned.toLocaleString()} {action}
          {skipped && skipped > 0
            ? ` (${skipped.toLocaleString()} already exist, will be skipped)`
            : ""}
        </span>
      </div>
      {reasons && reasons.length > 0 ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: 16,
            color: "var(--pw-fg-muted)",
            fontSize: 12,
            listStyle: "disc",
          }}
        >
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
