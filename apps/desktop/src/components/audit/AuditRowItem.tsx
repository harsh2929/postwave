/**
 * AuditRowItem — one row in the audit log list, extracted from
 * Audit.tsx. Refined Audit PR 1.
 *
 * Visual rules:
 *   - Left-edge action-family tint helps operators scan repeated classes of
 *     events. It is deliberately presented as a heuristic, not as an
 *     authoritative server risk or security verdict.
 *   - Actor label is clickable: opens that actor's view (parent
 *     hooks into the click via onFilterActor to set the form state).
 *   - Resource ID is clickable too — drills the filter to "events
 *     for this resource id" without leaving the page.
 *
 * Pure presentation; parent owns selection + the filter setters.
 */

import type { ReactElement, MouseEvent } from "react";

import type { AuditRow } from "../../lib/api-client";

interface Props {
  row: AuditRow;
  onClick: (opener: HTMLButtonElement) => void;
  onFilterActor?: (actor: string) => void;
  onFilterResourceId?: (id: string) => void;
}

/** Truncate a resource id to the first 8 chars with an ellipsis —
 *  but only when an ellipsis is meaningful. Showing "a1b2…" for a
 *  4-char id implies a truncation that didn't happen. */
function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function fmtDate(s: string | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AuditRowItem({
  row: r,
  onClick,
  onFilterActor,
  onFilterResourceId,
}: Props): ReactElement {
  const resourceLabel = r.resourceType
    ? `${r.resourceType}${r.resourceId ? ` · ${truncateId(r.resourceId)}` : ""}`
    : (r.resourceId ?? "—");
  const actorText = r.actorLabel ?? r.actorType ?? "—";
  const openLabel = [
    `Open audit event ${r.action || "details"}.`,
    r.redactedFields && r.redactedFields.length > 0
      ? `Contains redacted fields: ${r.redactedFields.join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Inline click handlers stop propagation so the row-level click
  // doesn't also open the slideover when the operator clicks an
  // actor or resource chip.
  const onActorClick = (e: MouseEvent): void => {
    if (!onFilterActor || !r.actorLabel) return;
    e.stopPropagation();
    onFilterActor(r.actorLabel);
  };
  const onResourceClick = (e: MouseEvent): void => {
    if (!onFilterResourceId || !r.resourceId) return;
    e.stopPropagation();
    onFilterResourceId(r.resourceId);
  };

  return (
    <div className="list-row audit-row" role="row">
      <div
        className="muted tabular audit-row-time"
        role="cell"
        data-label="Time"
      >
        {fmtDate(r.at)}
      </div>
      <div className="audit-row-action" role="cell" data-label="Action">
        <button
          type="button"
          className="audit-row-open mono"
          onClick={(event) => onClick(event.currentTarget)}
          aria-label={openLabel}
        >
          <span className="audit-row-action-label">{r.action || "—"}</span>
          {r.redactedFields && r.redactedFields.length > 0 ? (
            <span
              className="audit-redaction-pill"
              aria-label={`Contains redacted fields: ${r.redactedFields.join(", ")}`}
              style={{
                marginLeft: 8,
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 3,
                background: "var(--pw-bg-elev-2)",
                color: "var(--pw-fg-muted)",
                border: "1px solid var(--pw-border)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Redacted · {r.redactedFields.length}
            </span>
          ) : null}
        </button>
      </div>
      <div className="audit-row-resource" role="cell" data-label="Resource">
        {r.resourceId && onFilterResourceId ? (
          <button
            type="button"
            className="audit-row-link"
            onClick={onResourceClick}
            aria-label={`Filter to events touching ${r.resourceId}`}
          >
            <span>{resourceLabel}</span>
            <span className="audit-row-filter-verb">Filter</span>
          </button>
        ) : (
          <span>{resourceLabel}</span>
        )}
      </div>
      <div className="audit-row-actor" role="cell" data-label="Actor">
        {r.actorLabel && onFilterActor ? (
          <button
            type="button"
            className="audit-row-link"
            onClick={onActorClick}
            aria-label={`Filter to events by ${r.actorLabel}`}
          >
            <span>{actorText}</span>
            <span className="audit-row-filter-verb">Filter</span>
          </button>
        ) : (
          <span>{actorText}</span>
        )}
        {/* Suppress the type suffix when actorText already IS the type
            (no separate label), or when the type duplicates the label
            verbatim ("humanhuman" glitch from earlier QA). */}
        {r.actorLabel &&
        r.actorType &&
        r.actorType.toLowerCase() !== r.actorLabel.toLowerCase() ? (
          <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
            {r.actorType}
          </span>
        ) : null}
      </div>
      <div
        className="muted mono audit-row-ip"
        role="cell"
        data-label="IP address"
      >
        {r.ip ?? "—"}
      </div>
    </div>
  );
}
