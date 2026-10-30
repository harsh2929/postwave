/**
 * AuditCalendar — month grid of audit events.
 *
 * audit-2026 session-replay-deeplink (UX, P1). Fourth view mode for
 * the Audit page. Each day cell shows an event-count badge + a tiny
 * severity bar (red/orange/blue/grey segments proportional to action
 * mix). Click a date → fires onSelectDay so the parent can scope the
 * list filter to that 24-hour window.
 *
 * No external deps — built-in Date arithmetic for the month grid.
 */

import {
  type KeyboardEvent,
  type ReactElement,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AuditRow } from "../../lib/api-client";
import { type AuditSeverity } from "./AuditSeverity";
import { buildCalendar, type CalendarDay } from "./auditViewModeHelpers";

export { buildCalendar };
export type { CalendarDay };

export function calendarKeyboardTarget(
  index: number,
  key: string,
  length: number,
): number | null {
  let next: number | null = null;
  if (key === "ArrowLeft") next = index - 1;
  if (key === "ArrowRight") next = index + 1;
  if (key === "ArrowUp") next = index - 7;
  if (key === "ArrowDown") next = index + 7;
  if (key === "Home") next = index - (index % 7);
  if (key === "End") next = index + (6 - (index % 7));
  return next != null && next >= 0 && next < length ? next : null;
}

interface Props {
  rows: AuditRow[];
  onSelectDay?: (dateIso: string, count: number) => void;
}

const SEVERITY_BAR: Record<AuditSeverity, string> = {
  destructive: "var(--pw-danger)",
  auth: "var(--pw-warning)",
  export: "var(--pw-info)",
  ops: "var(--pw-fg-muted)",
};

const WEEK_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function AuditCalendar({ rows, onSelectDay }: Props): ReactElement {
  const [anchor, setAnchor] = useState<Date>(() => {
    const d = new Date();
    d.setUTCDate(1);
    return d;
  });
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const monthHeadingId = useId();
  const instructionsId = useId();
  const { days, monthLabel } = useMemo(
    () => buildCalendar(rows, anchor),
    [rows, anchor],
  );

  const stepMonth = (delta: number): void => {
    const next = new Date(anchor);
    next.setUTCMonth(anchor.getUTCMonth() + delta);
    setAnchor(next);
  };

  const fallbackFocusDate =
    days.find((day) => day.inMonth)?.date ?? days[0]?.date;
  const activeFocusDate = days.some((day) => day.date === focusedDate)
    ? focusedDate
    : fallbackFocusDate;

  const moveGridFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const target = calendarKeyboardTarget(index, event.key, days.length);
    if (target == null) return;
    event.preventDefault();
    const targetDay = days[target];
    if (!targetDay) return;
    setFocusedDate(targetDay.date);
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-calendar-index="${target}"]`)
      ?.focus();
  };

  return (
    <section
      data-testid="audit-calendar"
      aria-labelledby={monthHeadingId}
      aria-describedby={instructionsId}
      style={{ padding: 8 }}
    >
      <p id={instructionsId} className="visually-hidden">
        Use arrow keys to inspect adjacent UTC days, Home and End to move within
        a week, and Enter or Space to open a day in the audit list.
      </p>
      <div
        className="row"
        style={{
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div className="row" style={{ gap: 4 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => stepMonth(-1)}
            aria-label="Previous month"
          >
            {"<"}
          </button>
          <strong id={monthHeadingId} aria-live="polite">
            {monthLabel}
          </strong>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => stepMonth(1)}
            aria-label="Next month"
          >
            {">"}
          </button>
        </div>
        <span className="muted small">UTC days</span>
      </div>
      <div
        className="muted small"
        aria-label="Severity abbreviations"
        style={{ marginBottom: 8 }}
      >
        D destructive · A authentication · E export · O operations
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-labelledby={monthHeadingId}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 4,
        }}
      >
        {WEEK_LABELS.map((w) => (
          <div
            key={w}
            role="columnheader"
            className="muted small"
            style={{ textAlign: "center", fontWeight: 500 }}
          >
            {w}
          </div>
        ))}
        {days.map((day, dayIndex) => {
          const total = day.count;
          const totalForBar = Math.max(1, total);
          const severitySummary = (
            ["destructive", "auth", "export", "ops"] as AuditSeverity[]
          )
            .filter((severity) => day.mix[severity] > 0)
            .map((severity) => `${severity} ${day.mix[severity]}`)
            .join(", ");
          return (
            <button
              key={day.date}
              type="button"
              role="gridcell"
              data-testid="audit-calendar-cell"
              data-day={day.date}
              data-calendar-index={dayIndex}
              tabIndex={day.date === activeFocusDate ? 0 : -1}
              aria-label={`${day.date}, ${total} event${total === 1 ? "" : "s"}${severitySummary ? `: ${severitySummary}` : ""}`}
              onClick={() => onSelectDay?.(day.date, total)}
              onFocus={() => setFocusedDate(day.date)}
              onKeyDown={(event) => moveGridFocus(event, dayIndex)}
              style={{
                position: "relative",
                padding: "8px 6px",
                border: "1px solid var(--pw-border)",
                borderRadius: 4,
                background: day.inMonth
                  ? "var(--pw-bg-elev)"
                  : "var(--pw-bg-elev-2)",
                color: day.inMonth ? "inherit" : "var(--pw-fg-muted)",
                cursor: total > 0 ? "pointer" : "default",
                textAlign: "left",
                minHeight: 56,
              }}
            >
              <div
                className="row"
                style={{
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <span className="tabular">{Number(day.date.slice(-2))}</span>
                {total > 0 ? (
                  <span
                    className="audit-day-badge"
                    style={{
                      fontSize: 11,
                      background: "var(--pw-accent)",
                      color: "white",
                      padding: "1px 6px",
                      borderRadius: 8,
                    }}
                  >
                    {total > 999 ? "999+" : total}
                  </span>
                ) : null}
              </div>
              {total > 0 ? (
                <div
                  className="row"
                  style={{
                    marginTop: 8,
                    height: 4,
                    borderRadius: 2,
                    overflow: "hidden",
                    background: "var(--pw-border)",
                  }}
                >
                  {(
                    ["destructive", "auth", "export", "ops"] as AuditSeverity[]
                  ).map((sev) => {
                    const f = day.mix[sev] / totalForBar;
                    if (f <= 0) return null;
                    return (
                      <div
                        key={sev}
                        style={{
                          flex: f,
                          background: SEVERITY_BAR[sev],
                        }}
                        title={`${sev}: ${day.mix[sev]}`}
                      />
                    );
                  })}
                </div>
              ) : null}
              {total > 0 ? (
                <div
                  className="tabular"
                  style={{
                    marginTop: 5,
                    fontSize: 9,
                    color: "var(--pw-fg-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  D {day.mix.destructive} · A {day.mix.auth} · E{" "}
                  {day.mix.export} · O {day.mix.ops}
                </div>
              ) : (
                <div className="muted" style={{ marginTop: 5, fontSize: 9 }}>
                  No events
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
