/**
 * StatStrip — compact horizontal KPI row.
 *
 * Use for mid-density tabs where a full .stat-grid would feel heavy.
 * Each tile shows label + value (em-dash when un-initialized) +
 * optional delta + optional sparkline. Click handler fires a drilldown
 * if the metric supports it.
 */

import type { ReactElement, ReactNode } from "react";

import { InlineHelp } from "./InlineHelp";

export interface StatCell {
  label: string;
  value: ReactNode; // already-formatted; pass "—" for empty
  delta?: { direction: "up" | "down" | "flat"; text: string } | null;
  spark?: ReactNode; // arbitrary <svg> — typically a <Sparkline />
  hint?: string; // tooltip text via <InlineHelp>
  onClick?: () => void;
  ariaLabel?: string;
}

interface Props {
  cells: StatCell[];
}

export function StatStrip({ cells }: Props): ReactElement | null {
  if (!cells || cells.length === 0) return null;
  return (
    <div className="stat-strip-v2" role="group" aria-label="Key statistics">
      {cells.map((c, i) => {
        const interactive = !!c.onClick;
        const content = (
          <>
            <div className="stat-strip-v2-label">{c.label}</div>
            <div className="stat-strip-v2-value">
              {c.value}
              {c.delta ? (
                <span
                  className={`stat-strip-v2-delta ${c.delta.direction}`}
                  aria-label={`Change: ${c.delta.text}`}
                >
                  {c.delta.text}
                </span>
              ) : null}
            </div>
            {c.spark ? (
              <div className="stat-strip-v2-spark">{c.spark}</div>
            ) : null}
          </>
        );
        return (
          <div
            key={i}
            className={`stat-strip-v2-cell${interactive ? " is-interactive" : ""}${c.hint ? " has-help" : ""}`}
          >
            {interactive ? (
              <button
                type="button"
                className="stat-strip-v2-cell-action"
                onClick={c.onClick}
                aria-label={c.ariaLabel ?? c.label}
              >
                {content}
              </button>
            ) : (
              content
            )}
            {c.hint ? (
              <span className="stat-strip-v2-help">
                <InlineHelp
                  text={c.hint}
                  ariaLabel={`About ${c.label}: ${c.hint}`}
                />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
