/**
 * LineChart — hand-rolled SVG line + area chart for the Analytics page.
 *
 * Pure React + SVG, no external chart library, theme-aware via CSS vars.
 * Width is responsive (ResizeObserver on the container); height is fixed
 * by the caller. Tooltip is an absolutely-positioned div over the SVG.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface LinePoint {
  /** ISO date (YYYY-MM-DD) or any Date.parse-able string. */
  date: string;
  count: number;
}

export interface LineChartProps extends RequiredChartSupportProps {
  data: LinePoint[];
  /** Height in px (width is responsive). */
  height?: number;
  /** "MMM d" if not supplied. */
  formatDate?: (d: Date) => string;
  /** Tick stride along x; defaults from props or 7. */
  xTickStride?: number;
  title: string;
  summary?: string;
  valueLabel: string;
  formatValue?: (value: number) => string;
}

const DEFAULT_HEIGHT = 200;
const PAD_T = 12;
const PAD_R = 12;
const PAD_B = 24;
const PAD_L = 40;

function defaultFmt(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function lineDateLabel(
  raw: string,
  date: Date,
  formatDate: (value: Date) => string,
): string {
  return Number.isFinite(date.getTime()) ? formatDate(date) : raw;
}

export function LineChart(props: LineChartProps): ReactElement {
  const {
    data,
    height = DEFAULT_HEIGHT,
    formatDate = defaultFmt,
    title,
    valueLabel,
    formatValue = (value: number) => value.toLocaleString(),
  } = props;
  const xTickStride = props.xTickStride ?? 7;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState<number>(0);
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
  } | null>(null);

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

  const parsed = useMemo(() => {
    return data.map((p) => ({
      rawDate: p.date,
      date: new Date(p.date),
      // A missing/non-finite sample is a gap. Treating it as zero would
      // fabricate a drop and corrupt the chart, table, and CSV equally.
      count: Number.isFinite(p.count) ? p.count : null,
    }));
  }, [data]);
  const finiteCounts = parsed
    .map((point) => point.count)
    .filter((count): count is number => count != null);

  const dims = useMemo(() => {
    const innerW = Math.max(0, w - PAD_L - PAD_R);
    const innerH = Math.max(0, height - PAD_T - PAD_B);
    const dataMax = finiteCounts.reduce(
      (current, count) => Math.max(current, count),
      Number.NEGATIVE_INFINITY,
    );
    const dataMin = finiteCounts.reduce(
      (current, count) => Math.min(current, count),
      Number.POSITIVE_INFINITY,
    );
    // Zero remains the visual baseline for cumulative/count series, while
    // signed series (for example net revenue after refunds) get the complete
    // negative domain instead of being plotted below the SVG viewport.
    const max = Math.max(0, dataMax);
    const min = Math.min(0, dataMin);
    const span = max - min || 1;
    const stepX = parsed.length > 1 ? innerW / (parsed.length - 1) : 0;
    const zeroY = PAD_T + innerH - ((0 - min) / span) * innerH;
    return {
      innerW,
      innerH,
      dataMax,
      dataMin,
      max,
      min,
      span,
      stepX,
      zeroY,
    };
  }, [w, height, parsed, finiteCounts]);

  const firstCount = finiteCounts[0];
  const lastCount = finiteCounts.at(-1);
  const missingCount = parsed.length - finiteCounts.length;
  const summary =
    props.summary ??
    `${parsed.length} points${missingCount > 0 ? `, ${missingCount} unavailable` : ""}. ${firstCount == null ? "No valid values." : `Starts at ${formatValue(firstCount)}, ends at ${formatValue(lastCount ?? firstCount)}, peaks at ${formatValue(dims.dataMax)}, and bottoms at ${formatValue(dims.dataMin)}.`}`;
  const dataRows = parsed.map((point, index) => ({
    key: String(index),
    label: lineDateLabel(point.rawDate, point.date, formatDate),
    values: {
      value: point.count == null ? "No data" : formatValue(point.count),
    },
    exportValues: { value: point.count ?? "" },
  }));

  if (parsed.length === 0) {
    return (
      <div className="pw-data-visual">
        <div ref={wrapRef} className="pw-chart-empty" role="status">
          No data available for {title}.
        </div>
        <LineChartDataDisclosure
          props={props}
          title={title}
          summary={summary}
          valueLabel={valueLabel}
          rows={dataRows}
        />
      </div>
    );
  }

  if (finiteCounts.length === 0) {
    return (
      <div className="pw-data-visual">
        <div ref={wrapRef} className="pw-chart-empty" role="status">
          {title} contains no valid numeric values.
        </div>
        <LineChartDataDisclosure
          props={props}
          title={title}
          summary={summary}
          valueLabel={valueLabel}
          rows={dataRows}
        />
      </div>
    );
  }

  if (w === 0) {
    return <div ref={wrapRef} style={{ width: "100%", height }} />;
  }

  const { innerW, innerH, max, min, span, stepX, zeroY } = dims;

  const pts = parsed.map((p, i) => {
    const x = PAD_L + stepX * i;
    const y =
      p.count == null
        ? PAD_T + innerH / 2
        : PAD_T + innerH - ((p.count - min) / span) * innerH;
    return { x, y, p, i, valid: p.count != null };
  });

  let startsSegment = true;
  const linePath = pts
    .map((point) => {
      if (!point.valid) {
        startsSegment = true;
        return "";
      }
      const command = startsSegment ? "M" : "L";
      startsSegment = false;
      return `${command}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  const areaPath =
    missingCount === 0
      ? `${linePath} L${(PAD_L + innerW).toFixed(1)},${zeroY.toFixed(1)} L${PAD_L.toFixed(1)},${zeroY.toFixed(1)} Z`
      : "";

  // Four evenly spaced guides plus an explicit zero guide for mixed-sign
  // series. This makes the refund boundary visible instead of asking color or
  // tooltip interaction to communicate whether a point is negative.
  const gridYs: { y: number; label: string; zero: boolean }[] = [];
  if (max === 0 && min === 0) {
    gridYs.push({ y: PAD_T, label: formatValue(1), zero: false });
    gridYs.push({
      y: PAD_T + innerH,
      label: formatValue(0),
      zero: true,
    });
  } else {
    const values = Array.from({ length: 4 }, (_, index) => {
      const t = index / 3;
      return max - t * span;
    });
    if (min < 0 && max > 0) values.push(0);
    const uniqueValues = values
      .filter(
        (value, index, candidates) =>
          candidates.findIndex(
            (candidate) =>
              Math.abs(candidate - value) <= Number.EPSILON * Math.max(1, span),
          ) === index,
      )
      .sort((a, b) => b - a);
    for (const value of uniqueValues) {
      const y = PAD_T + innerH - ((value - min) / span) * innerH;
      const precision = span >= 100 ? 0 : span >= 10 ? 1 : 2;
      const labelValue = Number(value.toFixed(precision));
      gridYs.push({
        y,
        label: formatValue(labelValue),
        zero: Math.abs(value) <= Number.EPSILON * Math.max(1, span),
      });
    }
  }

  const tickIdxs: number[] = [];
  for (let i = 0; i < parsed.length; i += xTickStride) tickIdxs.push(i);
  if (tickIdxs[tickIdxs.length - 1] !== parsed.length - 1) {
    tickIdxs.push(parsed.length - 1);
  }

  const hoverPt = hover ? pts[hover.i] : null;
  const inspectPoint = (index: number): void => {
    const bounded = Math.max(0, Math.min(pts.length - 1, index));
    const point = pts[bounded];
    if (point) setHover({ i: bounded, x: point.x, y: point.y });
  };

  return (
    <div className="pw-data-visual">
      <div
        ref={wrapRef}
        style={{ position: "relative", width: "100%", height }}
      >
        <svg
          width={w}
          height={height}
          style={{ display: "block", color: "var(--pw-fg-subtle)" }}
          role="img"
          aria-label={`${title}. ${summary} Use Left and Right Arrow keys to inspect points.`}
          tabIndex={0}
          onFocus={() => inspectPoint(0)}
          onBlur={() => setHover(null)}
          onKeyDown={(event) => {
            const current = hover?.i ?? 0;
            let next: number | null = null;
            if (event.key === "ArrowLeft") next = current - 1;
            if (event.key === "ArrowRight") next = current + 1;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = pts.length - 1;
            if (next != null) {
              event.preventDefault();
              inspectPoint(next);
            }
          }}
        >
          {/* grid */}
          {gridYs.map((g, idx) => (
            <g key={idx}>
              <line
                x1={PAD_L}
                x2={PAD_L + innerW}
                y1={g.y}
                y2={g.y}
                stroke={
                  g.zero && min < 0 ? "var(--pw-fg-muted)" : "var(--pw-border)"
                }
                strokeWidth={g.zero && min < 0 ? 1.5 : 1}
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

          {/* area */}
          {areaPath ? (
            <path d={areaPath} fill="var(--pw-accent)" fillOpacity={0.12} />
          ) : null}
          {/* line */}
          <path
            d={linePath}
            fill="none"
            stroke="var(--pw-accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* x ticks */}
          {tickIdxs.map((i) => {
            const pt = pts[i];
            if (!pt) return null;
            return (
              <text
                key={i}
                x={pt.x}
                y={PAD_T + innerH + 14}
                textAnchor="middle"
                fontSize={11}
                fill="var(--pw-fg-subtle)"
              >
                {lineDateLabel(pt.p.rawDate, pt.p.date, formatDate)}
              </text>
            );
          })}

          {/* hit-testing dots */}
          {pts.map((pt) =>
            pt.p.count == null ? null : (
              <circle
                key={pt.i}
                cx={pt.x}
                cy={pt.y}
                r={hover?.i === pt.i ? 3.5 : 2.5}
                fill="var(--pw-accent)"
                stroke="var(--pw-bg-elev)"
                strokeWidth={1.5}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover({ i: pt.i, x: pt.x, y: pt.y })}
                onMouseLeave={() => setHover(null)}
              >
                <title>{`${lineDateLabel(pt.p.rawDate, pt.p.date, formatDate)}: ${formatValue(pt.p.count)}`}</title>
              </circle>
            ),
          )}
        </svg>

        {hoverPt ? (
          <div
            style={{
              position: "absolute",
              left: hoverPt.x,
              top: hoverPt.y - 8,
              transform: "translate(-50%, -100%)",
              background: "var(--pw-bg-elev-2)",
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 11,
              color: "var(--pw-fg)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
              boxShadow:
                "0 4px 12px color-mix(in srgb, var(--pw-shadow-color) 40%, transparent)",
            }}
          >
            <div style={{ color: "var(--pw-fg-muted)" }}>
              {lineDateLabel(hoverPt.p.rawDate, hoverPt.p.date, formatDate)}
            </div>
            <div>
              {hoverPt.p.count == null
                ? "No data"
                : formatValue(hoverPt.p.count)}
            </div>
          </div>
        ) : null}
        <span className="visually-hidden" role="status" aria-live="polite">
          {hoverPt
            ? `${lineDateLabel(hoverPt.p.rawDate, hoverPt.p.date, formatDate)}: ${hoverPt.p.count == null ? "No data" : `${formatValue(hoverPt.p.count)} ${valueLabel}`}`
            : ""}
        </span>
      </div>
      <LineChartDataDisclosure
        props={props}
        title={title}
        summary={summary}
        valueLabel={valueLabel}
        rows={dataRows}
      />
    </div>
  );
}

function LineChartDataDisclosure({
  props,
  title,
  summary,
  valueLabel,
  rows,
}: {
  props: LineChartProps;
  title: string;
  summary: string;
  valueLabel: string;
  rows: Array<{
    key: string;
    label: string;
    values: { value: string };
    exportValues: { value: string | number };
  }>;
}): ReactElement {
  return (
    <AccessibleChartData
      title={title}
      summary={summary}
      rowHeaderLabel="Date"
      columns={[{ key: "value", label: valueLabel }]}
      rows={rows}
      provenance={props.provenance}
      exportFileName={props.exportFileName}
      exportPrivacy={props.exportPrivacy}
      {...(props.allowExport != null ? { allowExport: props.allowExport } : {})}
    />
  );
}
