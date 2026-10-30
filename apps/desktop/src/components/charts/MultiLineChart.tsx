/**
 * MultiLineChart — SVG multi-series time-series chart.
 *
 * Same visual language as LineChart but supports N series sharing an
 * x-axis. Used by Analytics for engagement velocity (opens + clicks +
 * replies on one canvas).
 *
 * Series are joined by their date keys onto a sorted union x-axis. Missing
 * samples remain disclosed gaps rather than being shifted onto another date.
 * The y-axis auto-scales to the global max across visible series.
 */

import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CHART_PALETTE } from "./palette";
import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface MultiLinePoint {
  date: string;
  count: number;
}

export interface MultiLineSeries {
  label: string;
  values: MultiLinePoint[];
  /** Optional color override; falls back to palette. */
  color?: string;
}

export interface MultiLineChartProps extends RequiredChartSupportProps {
  series: MultiLineSeries[];
  height?: number;
  xTickStride?: number;
  formatDate?: (d: Date) => string;
  title: string;
  summary?: string;
  valueLabel: string;
}

interface MultiLinePath {
  color: string;
  pts: Array<{ x: number; y: number; c: number } | null>;
  d: string;
  label: string;
  isHidden: boolean;
  index: number;
}

const DEFAULT_H = 220;
const PAD_T = 12;
const PAD_R = 12;
const PAD_B = 28;
const PAD_L = 40;

const PALETTE = CHART_PALETTE;

function defaultFmt(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateLabel(
  value: string,
  formatDate: (date: Date) => string,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return formatDate(date);
}

export function MultiLineChart(props: MultiLineChartProps): ReactElement {
  const {
    series,
    height = DEFAULT_H,
    xTickStride = 5,
    formatDate = defaultFmt,
    title,
    valueLabel,
  } = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState<number>(0);
  const [hoverI, setHoverI] = useState<number | null>(null);
  /* QA-nit (Analytics): legend items act as toggles. Click a series name
   * to hide/show it; double-click to solo. State is keyed by series.label
   * so adding/removing series is forgiving. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      setW(Math.max(0, Math.floor(cw)));
    });
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const indexedSeries = useMemo(
    () =>
      series.map((item, index) => ({
        item,
        index,
        valuesByDate: new Map(
          item.values.map((point) => [point.date, point.count] as const),
        ),
      })),
    [series],
  );
  const baseDates = useMemo(
    () =>
      [
        ...new Set(
          series.flatMap((item) => item.values.map((point) => point.date)),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    [series],
  );
  const visibleSeries = indexedSeries.filter(
    ({ item }) => !hidden.has(item.label),
  );

  const max = useMemo(() => {
    let m = 0;
    for (const s of series) {
      if (hidden.has(s.label)) continue;
      for (const p of s.values) {
        if (Number.isFinite(p.count) && p.count > m) m = p.count;
      }
    }
    return m;
  }, [series, hidden]);

  const visibilitySummary = `${visibleSeries.length} of ${series.length} series visible across ${baseDates.length} dates. Highest visible ${valueLabel.toLowerCase()}: ${max.toLocaleString()}. Missing samples remain gaps.`;
  const summary = props.summary
    ? `${props.summary} ${visibilitySummary}`
    : visibilitySummary;
  const dataColumns = visibleSeries.map(({ item, index }) => ({
    key: String(index),
    label: item.label,
  }));
  const dataRows = baseDates.map((date, dateIndex) => ({
    key: `${dateIndex}-${date}`,
    label: formatDateLabel(date, formatDate),
    values: Object.fromEntries(
      visibleSeries.map(({ index, valuesByDate }) => {
        const value = valuesByDate.get(date);
        return [
          String(index),
          typeof value === "number" && Number.isFinite(value)
            ? value.toLocaleString()
            : "No data",
        ];
      }),
    ),
    exportValues: Object.fromEntries(
      visibleSeries.map(({ index, valuesByDate }) => {
        const value = valuesByDate.get(date);
        return [
          String(index),
          typeof value === "number" && Number.isFinite(value) ? value : "",
        ];
      }),
    ),
  }));

  if (baseDates.length < 2) {
    return (
      <div className="pw-data-visual">
        <div ref={wrapRef} className="pw-chart-empty" role="status">
          {baseDates.length === 0
            ? `No data available for ${title}.`
            : `${title} has one date; at least two dates are needed to draw a trend.`}
        </div>
        <MultiLineDataDisclosure
          props={props}
          title={title}
          summary={summary}
          columns={dataColumns}
          rows={dataRows}
        />
      </div>
    );
  }

  if (w === 0) {
    return <div ref={wrapRef} style={{ width: "100%", height }} />;
  }

  const innerW = Math.max(0, w - PAD_L - PAD_R);
  const innerH = Math.max(0, height - PAD_T - PAD_B);
  const stepX = innerW / (baseDates.length - 1);
  const span = max || 1;

  /* QA-nit: when every series is zero (max === 0), the previous loop
   * computed max - t*1 → produced labels like 0/0/-1/-1. Clamp the
   * y-axis to 0..1 in the all-zero case so we render just "1" and "0"
   * gridlines instead of repeated zeros + negative ticks. */
  const gridYs: { y: number; label: string }[] = [];
  if (max === 0) {
    gridYs.push({ y: PAD_T, label: "1" });
    gridYs.push({ y: PAD_T + innerH, label: "0" });
  } else {
    for (let g = 0; g < 4; g++) {
      const t = g / 3;
      const v = Math.round(max - t * span);
      gridYs.push({ y: PAD_T + t * innerH, label: String(v) });
    }
  }

  const tickIdxs: number[] = [];
  for (let i = 0; i < baseDates.length; i += xTickStride) tickIdxs.push(i);
  if (tickIdxs[tickIdxs.length - 1] !== baseDates.length - 1) {
    tickIdxs.push(baseDates.length - 1);
  }

  const seriesPaths = indexedSeries.map(({ item, index, valuesByDate }) => {
    const color = item.color ?? PALETTE[index % PALETTE.length];
    const isHidden = hidden.has(item.label);
    const pts = baseDates.map((date, dateIndex) => {
      const value = valuesByDate.get(date);
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const x = PAD_L + stepX * dateIndex;
      const y = PAD_T + innerH - (value / span) * innerH;
      return { x, y, c: value };
    });
    let startsSegment = true;
    const d = pts
      .map((point) => {
        if (!point) {
          startsSegment = true;
          return "";
        }
        const command = startsSegment ? "M" : "L";
        startsSegment = false;
        return `${command}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
    return { color, pts, d, label: item.label, isHidden, index };
  });
  const visiblePaths = seriesPaths.filter((path) => !path.isHidden);

  const cursorX = hoverI != null ? PAD_L + stepX * hoverI : null;
  const inspectDate = (index: number): void => {
    setHoverI(Math.max(0, Math.min(baseDates.length - 1, index)));
  };

  return (
    <div className="pw-data-visual">
      <div
        ref={wrapRef}
        style={{ position: "relative", width: "100%", height }}
        onMouseLeave={() => setHoverI(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left - PAD_L;
          const i = Math.round(x / stepX);
          if (i >= 0 && i < baseDates.length) setHoverI(i);
        }}
      >
        <svg
          width={w}
          height={height}
          style={{ display: "block" }}
          role="img"
          aria-label={`${title}. ${summary} Use Left and Right Arrow keys to inspect dates.`}
          tabIndex={0}
          onFocus={() => inspectDate(0)}
          onKeyDown={(event) => {
            const current = hoverI ?? 0;
            let next: number | null = null;
            if (event.key === "ArrowLeft") next = current - 1;
            if (event.key === "ArrowRight") next = current + 1;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = baseDates.length - 1;
            if (next != null) {
              event.preventDefault();
              inspectDate(next);
            }
          }}
        >
          {gridYs.map((g, i) => (
            <g key={i}>
              <line
                x1={PAD_L}
                x2={PAD_L + innerW}
                y1={g.y}
                y2={g.y}
                stroke="var(--pw-border)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={PAD_L - 6}
                y={g.y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                fill="var(--pw-fg-subtle)"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {g.label}
              </text>
            </g>
          ))}

          {seriesPaths.map((sp) =>
            sp.isHidden ? null : (
              <path
                key={sp.index}
                d={sp.d}
                fill="none"
                stroke={sp.color}
                strokeWidth={1.8}
                strokeDasharray={
                  sp.index === 0 ? undefined : `${sp.index + 3} ${sp.index + 2}`
                }
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ),
          )}

          {tickIdxs.map((i) => {
            const d = baseDates[i];
            if (!d) return null;
            return (
              <text
                key={i}
                x={PAD_L + stepX * i}
                y={PAD_T + innerH + 14}
                textAnchor="middle"
                fontSize={11}
                fill="var(--pw-fg-subtle)"
              >
                {formatDateLabel(d, formatDate)}
              </text>
            );
          })}

          {cursorX != null ? (
            <line
              x1={cursorX}
              x2={cursorX}
              y1={PAD_T}
              y2={PAD_T + innerH}
              stroke="var(--pw-fg-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
              opacity={0.6}
            />
          ) : null}
        </svg>

        <MultiLineLegend
          paths={seriesPaths}
          series={series}
          setHidden={setHidden}
        />
        <MultiLineInspection
          hoverIndex={hoverI}
          cursorX={cursorX}
          width={w}
          dates={baseDates}
          formatDate={formatDate}
          visiblePaths={visiblePaths}
        />
      </div>
      <MultiLineDataDisclosure
        props={props}
        title={title}
        summary={summary}
        columns={dataColumns}
        rows={dataRows}
      />
    </div>
  );
}

function MultiLineLegend({
  paths,
  series,
  setHidden,
}: {
  paths: MultiLinePath[];
  series: MultiLineSeries[];
  setHidden: Dispatch<SetStateAction<Set<string>>>;
}): ReactElement {
  return (
    <div
      className="pw-chart-legend"
      style={{
        position: "absolute",
        top: 0,
        right: 4,
        display: "flex",
        gap: 12,
        fontSize: 11,
        color: "var(--pw-fg-muted)",
      }}
    >
      {paths.map((path) => (
        <button
          key={path.index}
          type="button"
          onClick={() => {
            setHidden((previous) => {
              const next = new Set(previous);
              if (next.has(path.label)) next.delete(path.label);
              else next.add(path.label);
              return next;
            });
          }}
          onDoubleClick={() => {
            setHidden((previous) => {
              const others = series
                .map((item) => item.label)
                .filter((label) => label !== path.label);
              const allOthersHidden = others.every((label) =>
                previous.has(label),
              );
              return new Set(allOthersHidden ? [] : others);
            });
          }}
          aria-label={
            path.isHidden
              ? `Click to show "${path.label}". Double-click a series to solo it.`
              : `Click to hide "${path.label}". Double-click to solo.`
          }
          aria-pressed={!path.isHidden}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "0 2px",
            border: "none",
            background: "none",
            color: "inherit",
            fontSize: "inherit",
            cursor: "pointer",
            opacity: path.isHidden ? 0.4 : 1,
            textDecoration: path.isHidden ? "line-through" : "none",
          }}
        >
          <svg width="18" height="6" aria-hidden="true">
            <line
              x1="0"
              x2="18"
              y1="3"
              y2="3"
              stroke={path.color}
              strokeWidth="2"
              strokeDasharray={
                path.index === 0
                  ? undefined
                  : `${path.index + 3} ${path.index + 2}`
              }
            />
          </svg>
          {path.label}
        </button>
      ))}
    </div>
  );
}

function MultiLineInspection({
  hoverIndex,
  cursorX,
  width,
  dates,
  formatDate,
  visiblePaths,
}: {
  hoverIndex: number | null;
  cursorX: number | null;
  width: number;
  dates: string[];
  formatDate: (date: Date) => string;
  visiblePaths: MultiLinePath[];
}): ReactElement {
  const date = hoverIndex == null ? undefined : dates[hoverIndex];
  const dateLabel = date ? formatDateLabel(date, formatDate) : "";
  const values =
    hoverIndex == null
      ? []
      : visiblePaths.map((path) => ({
          path,
          value: path.pts[hoverIndex]?.c,
        }));
  return (
    <>
      {hoverIndex != null ? (
        <div
          style={{
            position: "absolute",
            left: Math.min(width - 180, Math.max(8, (cursorX ?? 0) + 8)),
            top: PAD_T,
            minWidth: 140,
            padding: "6px 10px",
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            background: "var(--pw-bg-elev-2)",
            boxShadow:
              "0 4px 12px color-mix(in srgb, var(--pw-shadow-color) 40%, transparent)",
            color: "var(--pw-fg)",
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <div
            style={{
              marginBottom: 4,
              color: "var(--pw-fg-muted)",
              fontSize: 11,
            }}
          >
            {dateLabel}
          </div>
          {values.map(({ path, value }) => (
            <div
              key={path.index}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
              }}
            >
              <span style={{ color: "var(--pw-fg-muted)" }}>{path.label}</span>
              <span>
                {typeof value === "number" ? value.toLocaleString() : "No data"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <span className="visually-hidden" role="status" aria-live="polite">
        {date
          ? `${dateLabel}. ${values
              .map(
                ({ path, value }) =>
                  `${path.label}: ${typeof value === "number" ? value.toLocaleString() : "No data"}`,
              )
              .join("; ")}.`
          : ""}
      </span>
    </>
  );
}

function MultiLineDataDisclosure({
  props,
  title,
  summary,
  columns,
  rows,
}: {
  props: MultiLineChartProps;
  title: string;
  summary: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<{
    key: string;
    label: string;
    values: Record<string, string>;
    exportValues: Record<string, string | number>;
  }>;
}): ReactElement {
  return (
    <AccessibleChartData
      title={title}
      summary={summary}
      rowHeaderLabel="Date"
      columns={columns}
      rows={rows}
      provenance={props.provenance}
      exportFileName={props.exportFileName}
      exportPrivacy={props.exportPrivacy}
      {...(props.allowExport != null ? { allowExport: props.allowExport } : {})}
    />
  );
}
