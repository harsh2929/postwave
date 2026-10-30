/**
 * SendTimeHeatmap — reusable 7×24 grid showing when opens land across
 * day-of-week (rows) × hour-of-day (columns). Powers both the
 * audience-wide heatmap at the top of the SendTime page and the
 * per-subscriber heatmap that appears after a lookup.
 *
 * Grid layout matches the backend's `SegmentPattern.Grid` / `OpenPattern.Grid`
 * shape: `grid[dow][hour]`, where `dow` is 0..6 with Sunday=0 (matches the
 * Go server's day-of-week convention) and `hour` is 0..23 UTC.
 *
 * The primary peak is highlighted with a teal ring. When a secondary peak
 * exists (bimodal audience — e.g. commute + lunch readers), it gets a
 * dashed ring so the operator can see both windows at a glance.
 *
 * Integrated helpers (each with its own pinned test suite):
 *   - ./tz         — UTC ⇄ local timezone toggle (persisted preference).
 *     The "median recipient TZ" mode the helper supports is NOT offered
 *     here: it needs per-recipient timezone data the backend doesn't
 *     ship yet, so the UI only exposes UTC/Local.
 *   - ./a11y       — screen-reader summary via a wrapper aria-label so
 *     the colour-only grid has a textual peak announcement.
 *   - ./responsive — container-width breakpoint that collapses the grid
 *     to a vertical "Top send times" list when too narrow.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import {
  DOW_LONG_LABELS,
  buildHeatmapSummary,
  fmtHourLong,
  topCells,
} from "./a11y";
import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "../charts/AccessibleChartData";
import { MOBILE_TOP_N, shouldUseMobileLayout } from "./responsive";
import {
  type HeatmapTzMode,
  loadStoredMode,
  localOffsetMinutes,
  persistMode,
  projectedMinute,
  resolveBrowserTz,
  shiftCell,
  shiftGrid,
  shortTzLabel,
} from "./tz";

interface Peak {
  dow: number;
  hour: number;
}

interface Props extends RequiredChartSupportProps {
  /** 7×24 grid. Values can be raw counts (per-subscriber) or normalised
   *  fractions (audience-wide); we normalise to the visible max either way. */
  grid: number[][];
  /** Primary peak coordinates (UTC, like the grid). */
  primary: Peak;
  /** Secondary peak (when bimodal). Omit to hide. */
  secondary?: Peak;
  /** Compact = smaller cell + day labels (used inside the subscriber lookup card). */
  compact?: boolean;
  /** Title rendered above the grid. */
  title?: string;
  /** Subtitle / right-aligned hint above the grid. */
  hint?: string;
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtHour(h: number, minute = 0): string {
  const hour = h === 0 || h === 12 ? 12 : h % 12;
  const suffix = h < 12 ? "a" : "p";
  return minute === 0
    ? `${hour}${suffix}`
    : `${hour}:${String(minute).padStart(2, "0")}${suffix}`;
}

export function SendTimeHeatmap({
  grid,
  primary,
  secondary,
  compact = false,
  title,
  hint,
  provenance,
  exportFileName,
  exportPrivacy,
  allowExport,
}: Props): ReactElement {
  /* ---------- timezone toggle (./tz) ----------------------------- */
  // Stored preference may be "median" from a future-facing writer; we
  // clamp to UTC because median-recipient-TZ has no data source yet.
  const [tzMode, setTzMode] = useState<HeatmapTzMode>(
    () => loadStoredMode() ?? "utc",
  );
  const mode: "utc" | "local" = tzMode === "local" ? "local" : "utc";
  const pickMode = (next: "utc" | "local"): void => {
    setTzMode(next);
    persistMode(next);
  };
  const offset = mode === "local" ? localOffsetMinutes() : 0;
  const displayMinute = mode === "local" ? projectedMinute(offset) : 0;
  const tzLabel = shortTzLabel(mode, resolveBrowserTz(), offset);

  /* Defensive: `grid` is sometimes undefined or a non-array shape when
   * the parent passes a partial pattern. shiftGrid coerces to a
   * guaranteed 7×24 array (even at zero offset) so the iteration below
   * never throws "not iterable". */
  const displayGrid = useMemo(() => shiftGrid(grid, offset), [grid, offset]);
  const displayPrimary = useMemo(
    () => shiftCell(primary.dow, primary.hour, offset),
    [primary.dow, primary.hour, offset],
  );
  const displaySecondary = useMemo(
    () =>
      secondary ? shiftCell(secondary.dow, secondary.hour, offset) : undefined,
    [secondary, offset],
  );

  const max = useMemo(() => {
    let m = 0;
    for (const row of displayGrid) {
      for (const v of row) {
        if (typeof v === "number" && Number.isFinite(v) && v > m) m = v;
      }
    }
    return m || 1;
  }, [displayGrid]);

  /* ---------- screen-reader summary (./a11y) ---------------------- */
  const srSummary = useMemo(
    () => buildHeatmapSummary(topCells(displayGrid, 3), tzLabel, displayMinute),
    [displayGrid, displayMinute, tzLabel],
  );

  /* ---------- responsive collapse (./responsive) ------------------ */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mobile = shouldUseMobileLayout(containerWidth);
  const mobileTop = useMemo(
    () => (mobile ? topCells(displayGrid, MOBILE_TOP_N) : []),
    [mobile, displayGrid],
  );

  const cellH = compact ? 14 : 18;
  // Build a label rack for every 3rd hour so the strip stays readable.
  const hourLabels: Array<{ idx: number; label: string }> = [];
  for (let h = 0; h < 24; h += 3) {
    hourLabels.push({ idx: h, label: fmtHour(h, displayMinute) });
  }

  return (
    <div
      ref={wrapRef}
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {title ? (
          <div
            className="section-title"
            style={{ marginBottom: 0, fontSize: 13 }}
          >
            {title}
          </div>
        ) : (
          <span />
        )}
        <div
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          {hint ? (
            <span className="muted" style={{ fontSize: 11 }}>
              {hint}
            </span>
          ) : null}
          <span
            className="muted tabular"
            style={{ fontSize: 11 }}
            title={
              mode === "local"
                ? "Times use this device's exact current UTC offset. Historical daylight-saving changes are not re-bucketed."
                : "Times shown in UTC (the backend's native grid)."
            }
          >
            {tzLabel}
          </span>
          <span
            role="group"
            aria-label="Heatmap timezone"
            style={{ display: "inline-flex", gap: 2 }}
          >
            {(["utc", "local"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`chip${mode === m ? " is-active" : ""}`}
                aria-pressed={mode === m}
                onClick={() => pickMode(m)}
                aria-label={
                  m === "utc"
                    ? "Show hours in UTC"
                    : "Show hours in this device's timezone"
                }
              >
                {m === "utc" ? "UTC" : "Local"}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 11 }}>
        ◎ Primary peak
        {displaySecondary ? " · ◌ Secondary peak (dashed)" : ""}
        {mode === "local"
          ? " · Current device offset; historical DST is not re-bucketed"
          : ""}
      </div>
      <p className="visually-hidden">{srSummary}</p>

      {mobile ? (
        /* Narrow container: 24 columns degrade to invisible slivers, so
         * swap to a vertical "Top send times" list (./responsive). */
        <div
          aria-hidden="true"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <div className="muted" style={{ fontSize: 11 }}>
            Top send times
          </div>
          {mobileTop.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              No engagement recorded yet.
            </div>
          ) : (
            mobileTop.map((c, i) => (
              <div
                key={`${c.dow}-${c.hour}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <span className="tabular muted" style={{ width: 14 }}>
                  {i + 1}.
                </span>
                <span style={{ minWidth: 130 }}>
                  {DOW_LONG_LABELS[c.dow] ?? "—"} ·{" "}
                  {fmtHourLong(c.hour, displayMinute)}
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    flex: 1,
                    maxWidth: 120,
                    height: 6,
                    borderRadius: 3,
                    background: `color-mix(in srgb, var(--pw-accent) ${((c.value / max) * 80 + 4).toFixed(1)}%, transparent)`,
                  }}
                />
                <span className="tabular muted">
                  {c.value.toLocaleString(undefined, {
                    maximumFractionDigits: c.value >= 1 ? 0 : 3,
                  })}
                </span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div
          aria-hidden="true"
          style={{
            display: "grid",
            gridTemplateColumns: `${compact ? 28 : 36}px repeat(24, 1fr)`,
            gap: 2,
            alignItems: "center",
          }}
        >
          {/* Header row: hour labels (every 3 hours) */}
          <div />
          {Array.from({ length: 24 }, (_, h) => {
            const label = hourLabels.find((l) => l.idx === h)?.label ?? "";
            return (
              <div
                key={`hh-${h}`}
                style={{
                  fontSize: 9,
                  color: "var(--pw-fg-subtle)",
                  textAlign: "center",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {label}
              </div>
            );
          })}

          {/* 7 day rows */}
          {DOW_LABELS.map((dowLabel, dow) => (
            <DayRow
              key={dow}
              dowLabel={dowLabel}
              dow={dow}
              cells={displayGrid[dow] ?? Array(24).fill(0)}
              cellH={cellH}
              max={max}
              primary={displayPrimary}
              tzLabel={tzLabel}
              minute={displayMinute}
              {...(displaySecondary ? { secondary: displaySecondary } : {})}
            />
          ))}
        </div>
      )}
      <AccessibleChartData
        title={title ?? "Engagement by day and hour"}
        summary={srSummary}
        rowHeaderLabel="Day"
        columns={Array.from({ length: 24 }, (_, hour) => ({
          key: String(hour),
          label: `${fmtHourLong(hour, displayMinute)} ${tzLabel}`,
        }))}
        rows={displayGrid.map((row, dow) => ({
          key: String(dow),
          label: DOW_LONG_LABELS[dow] ?? `Day ${dow + 1}`,
          values: Object.fromEntries(
            row.map((value, hour) => [
              String(hour),
              value.toLocaleString(undefined, {
                maximumFractionDigits: value >= 1 ? 0 : 3,
              }),
            ]),
          ),
          exportValues: Object.fromEntries(
            row.map((value, hour) => [String(hour), value]),
          ),
        }))}
        provenance={provenance}
        exportFileName={exportFileName}
        exportPrivacy={exportPrivacy}
        {...(allowExport != null ? { allowExport } : {})}
      />
    </div>
  );
}

interface DayRowProps {
  dowLabel: string;
  dow: number;
  cells: number[];
  cellH: number;
  max: number;
  primary: Peak;
  secondary?: Peak;
  tzLabel: string;
  minute: number;
}

function DayRow({
  dowLabel,
  dow,
  cells,
  cellH,
  max,
  primary,
  secondary,
  tzLabel,
  minute,
}: DayRowProps): ReactElement {
  return (
    <>
      <div
        style={{
          fontSize: 11,
          color: "var(--pw-fg-muted)",
          textAlign: "right",
          paddingRight: 4,
        }}
      >
        {dowLabel}
      </div>
      {cells.map((v, h) => {
        const ratio = max > 0 ? v / max : 0;
        const isPrimary = primary.dow === dow && primary.hour === h;
        const isSecondary =
          !!secondary && secondary.dow === dow && secondary.hour === h;
        const fill = `color-mix(in srgb, var(--pw-accent) ${(ratio * 80 + 4).toFixed(1)}%, transparent)`;
        return (
          <div
            key={h}
            className={`stx-heatmap-cell${isPrimary ? " is-primary" : ""}${isSecondary ? " is-secondary" : ""}`}
            title={`${dowLabel} ${fmtHour(h, minute)} ${tzLabel} · ${v.toFixed(v >= 1 ? 0 : 3)}`}
            style={{
              height: cellH,
              borderRadius: 3,
              background: v > 0 ? fill : "var(--pw-bg-elev-2)",
              boxShadow: isPrimary
                ? "inset 0 0 0 2px var(--pw-accent)"
                : isSecondary
                  ? "inset 0 0 0 1.5px var(--pw-accent)"
                  : undefined,
              outline: isSecondary ? "1px dashed var(--pw-accent)" : undefined,
              outlineOffset: isSecondary ? -2 : undefined,
            }}
          />
        );
      })}
    </>
  );
}
