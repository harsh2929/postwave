/**
 * AuditTimeline — horizontal timeline of audit events.
 *
 * audit-2026 session-replay-deeplink (UX, P1). One of the four view
 * modes on the Audit page.
 *
 * We deliberately avoid pulling D3 into the desktop bundle for a single
 * scatter — the layout is a one-pass linear scale + a flexbox row of
 * absolutely-positioned dots. This keeps the bundle small and renders
 * 1000+ events without measurable jank.
 *
 * Each dot's colour encodes severity (re-using AuditSeverity classifier
 * so colour rules match the list view). Hovering surfaces a tooltip
 * with action + actor; clicking opens the slideover via the same
 * onSelect callback the list uses.
 */

import { type ReactElement, useMemo, useRef, useState } from "react";

import type { AuditRow } from "../../lib/api-client";
import { severityLabel, type AuditSeverity } from "./AuditSeverity";
import { projectTimeline, type TimelineEvent } from "./auditViewModeHelpers";

export { projectTimeline };
export type { TimelineEvent };

interface Props {
  rows: AuditRow[];
  onSelect?: (row: AuditRow) => void;
}

const SEVERITY_COLOUR: Record<AuditSeverity, string> = {
  destructive: "var(--pw-danger)",
  auth: "var(--pw-warning)",
  export: "var(--pw-info)",
  ops: "var(--pw-fg-muted)",
};

function fmtTick(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AuditTimeline({ rows, onSelect }: Props): ReactElement {
  const { minMs, maxMs, events } = useMemo(() => projectTimeline(rows), [rows]);
  const [hover, setHover] = useState<TimelineEvent | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  if (events.length === 0) {
    return (
      <div
        className="list-empty"
        data-testid="audit-timeline-empty"
        style={{ padding: 24 }}
      >
        <div className="empty-state">
          <div className="empty-state-icon">·</div>
          <h3>No events to plot</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            Widen the date range or adjust filters to populate the timeline.
          </p>
        </div>
      </div>
    );
  }

  // 5 axis ticks evenly spaced.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    Math.round(minMs + f * (maxMs - minMs)),
  );

  return (
    <div data-testid="audit-timeline" style={{ padding: "16px 8px 28px 8px" }}>
      <div
        ref={timelineRef}
        role="group"
        aria-label={`Audit event timeline with ${events.length} events. Use Left and Right Arrow keys to inspect events; press Enter to open one.`}
        style={{
          position: "relative",
          height: 80,
          border: "1px solid var(--pw-border)",
          borderRadius: 6,
          background: "var(--pw-bg-elev)",
        }}
      >
        {/* The base line. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: 1,
            background: "var(--pw-border)",
          }}
        />
        {events.map((e, i) => (
          <button
            key={`${e.row.id}-${i}`}
            type="button"
            data-testid="audit-timeline-dot"
            data-timeline-index={i}
            tabIndex={activeIndex === i ? 0 : -1}
            onClick={() => onSelect?.(e.row)}
            onMouseEnter={() => setHover(e)}
            onMouseLeave={() => setHover((h) => (h === e ? null : h))}
            onFocus={() => {
              setActiveIndex(i);
              setHover(e);
            }}
            onBlur={() =>
              setHover((current) => (current === e ? null : current))
            }
            onKeyDown={(event) => {
              let next: number | null = null;
              if (event.key === "ArrowLeft") next = i - 1;
              if (event.key === "ArrowRight") next = i + 1;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = events.length - 1;
              if (next == null || next < 0 || next >= events.length) return;
              event.preventDefault();
              setActiveIndex(next);
              timelineRef.current
                ?.querySelector<HTMLButtonElement>(
                  `[data-timeline-index="${next}"]`,
                )
                ?.focus();
            }}
            style={{
              position: "absolute",
              left: `calc(${(e.pos * 100).toFixed(3)}% - 14px)`,
              top: "calc(50% - 14px)",
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
            aria-label={`${severityLabel(e.severity)} event: ${e.row.action}, by ${e.row.actorLabel ?? e.row.actorType}, at ${e.row.at}`}
          >
            <span
              aria-hidden="true"
              style={{
                display: "block",
                width: e.severity === "destructive" ? 10 : 9,
                height: e.severity === "export" ? 7 : 9,
                margin: "auto",
                borderRadius:
                  e.severity === "ops" || e.severity === "export" ? "50%" : 1,
                border:
                  e.severity === "export"
                    ? `2px solid ${SEVERITY_COLOUR[e.severity]}`
                    : "none",
                background:
                  e.severity === "export"
                    ? "transparent"
                    : SEVERITY_COLOUR[e.severity],
                transform:
                  e.severity === "destructive" ? "rotate(45deg)" : undefined,
              }}
            />
          </button>
        ))}
      </div>
      <div className="muted small" style={{ marginTop: 8 }}>
        ◆ Destructive · ■ Authentication · ○ Export · ● Operations
      </div>
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--pw-fg-muted)",
          marginTop: 4,
        }}
      >
        {ticks.map((t) => (
          <span key={t} className="tabular">
            {fmtTick(t)}
          </span>
        ))}
      </div>
      {hover ? (
        <div
          className="muted"
          style={{ fontSize: 12, marginTop: 8 }}
          data-testid="audit-timeline-hover"
        >
          <strong>{hover.row.action}</strong>{" "}
          <span className="muted">
            ({severityLabel(hover.severity)}) ·{" "}
            {hover.row.actorLabel ?? hover.row.actorType}
            {" · "}
            {fmtTick(new Date(hover.row.at).getTime())}
          </span>
        </div>
      ) : null}
    </div>
  );
}
