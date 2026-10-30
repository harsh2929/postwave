/**
 * BarChart — grouped vertical bars (opens vs clicks per campaign).
 *
 * Pure SVG, theme-aware, responsive width via ResizeObserver.
 * Two series side-by-side per category. Tooltip on hover.
 */

import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { CHART_PALETTE } from "./palette";
import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface BarSeries {
  label: string;
  values: number[];
  /** CSS color string. Defaults: accent / accent-tint per series index. */
  color?: string;
}

export interface BarChartProps extends RequiredChartSupportProps {
  categories: string[];
  series: BarSeries[];
  height?: number;
  title: string;
  summary?: string;
  valueLabel: string;
}

interface BarHover {
  ci: number;
  si: number;
  x: number;
  y: number;
  v: number | null;
}

const DEFAULT_HEIGHT = 240;
const PAD_T = 12;
const PAD_R = 8;
const PAD_B = 28;
const PAD_L = 32;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

export function BarChart(props: BarChartProps): ReactElement {
  const {
    categories,
    series,
    height = DEFAULT_HEIGHT,
    title,
    valueLabel,
  } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const patternPrefix = useId().replace(/:/g, "");
  const [w, setW] = useState<number>(0);
  const [hover, setHover] = useState<BarHover | null>(null);

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

  const max = useMemo(() => {
    let m = 0;
    for (const s of series) {
      for (const value of s.values) {
        if (Number.isFinite(value) && value >= 0 && value > m) m = value;
      }
    }
    return m;
  }, [series]);
  const invalidValueCount = series.reduce(
    (count, item) =>
      count +
      item.values.filter((value) => !Number.isFinite(value) || value < 0)
        .length,
    0,
  );

  const summary =
    props.summary ??
    `${series.length} series across ${categories.length} categories. Highest ${valueLabel.toLowerCase()}: ${max.toLocaleString()}${invalidValueCount > 0 ? `; ${invalidValueCount} unavailable values remain gaps` : ""}.`;
  const dataColumns = series.map((item, index) => ({
    key: String(index),
    label: item.label,
  }));
  const dataRows = categories.map((category, categoryIndex) => ({
    key: `${categoryIndex}-${category}`,
    label: category,
    values: Object.fromEntries(
      series.map((item, seriesIndex) => [
        String(seriesIndex),
        Number.isFinite(item.values[categoryIndex]) &&
        (item.values[categoryIndex] ?? -1) >= 0
          ? (item.values[categoryIndex] as number).toLocaleString()
          : "No data",
      ]),
    ),
    exportValues: Object.fromEntries(
      series.map((item, seriesIndex) => [
        String(seriesIndex),
        Number.isFinite(item.values[categoryIndex]) &&
        (item.values[categoryIndex] ?? -1) >= 0
          ? (item.values[categoryIndex] as number)
          : "",
      ]),
    ),
  }));

  if (categories.length === 0 || series.length === 0) {
    return (
      <div className="pw-data-visual">
        <div ref={wrapRef} className="pw-chart-empty" role="status">
          No data available for {title}.
        </div>
        <ChartDataDisclosure
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
  const groupW = innerW / categories.length;
  const seriesCount = Math.max(1, series.length);
  const barW = Math.max(2, (groupW * 0.7) / seriesCount);
  const groupPad = (groupW - barW * seriesCount) / 2;
  const span = max || 1;

  /* All-zero guard ported from MultiLineChart: when max === 0 the loop
   * below computes max - t*1 → labels like 0/0/-1/-1. Clamp the y-axis
   * to 0..1 so we render just "1" and "0" gridlines instead. */
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

  const palette = CHART_PALETTE;
  const inspectBar = (flatIndex: number): void => {
    const bounded = Math.max(
      0,
      Math.min(categories.length * seriesCount - 1, flatIndex),
    );
    const ci = Math.floor(bounded / seriesCount);
    const si = bounded % seriesCount;
    const candidate = series[si]?.values[ci];
    const value =
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
        ? candidate
        : null;
    const x = PAD_L + groupW * ci + groupPad + barW * si + barW / 2;
    const y =
      value == null ? PAD_T + innerH : PAD_T + innerH - (value / span) * innerH;
    setHover({ ci, si, x, y, v: value });
  };

  const handleChartKey = (key: string): void => {
    const current = hover ? hover.ci * seriesCount + hover.si : 0;
    if (key === "ArrowRight" || key === "ArrowDown") inspectBar(current + 1);
    else if (key === "ArrowLeft" || key === "ArrowUp") inspectBar(current - 1);
    else if (key === "Home") inspectBar(0);
    else if (key === "End") inspectBar(categories.length * seriesCount - 1);
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
          style={{ display: "block" }}
          role="img"
          aria-label={`${title}. ${summary} Use Arrow keys to inspect each bar.`}
          tabIndex={0}
          onFocus={() => inspectBar(0)}
          onBlur={() => setHover(null)}
          onKeyDown={(event) => {
            if (
              [
                "ArrowRight",
                "ArrowDown",
                "ArrowLeft",
                "ArrowUp",
                "Home",
                "End",
              ].includes(event.key)
            ) {
              event.preventDefault();
              handleChartKey(event.key);
            }
          }}
        >
          <defs>
            {series.map((item, index) => {
              const color = item.color ?? palette[index] ?? "var(--pw-accent)";
              return (
                <pattern
                  key={item.label}
                  id={`${patternPrefix}-bar-${index}`}
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                >
                  <rect width="6" height="6" fill={color} />
                  {index > 0 ? (
                    <path
                      d={index % 2 === 0 ? "M0 6 L6 0" : "M0 0 L6 6"}
                      stroke="var(--pw-bg)"
                      strokeWidth="1"
                      opacity="0.7"
                    />
                  ) : null}
                </pattern>
              );
            })}
          </defs>
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

          {categories.map((cat, ci) => {
            const gx = PAD_L + groupW * ci + groupPad;
            return (
              <g key={ci}>
                {series.map((s, si) => {
                  const candidate = s.values[ci];
                  const v =
                    typeof candidate === "number" &&
                    Number.isFinite(candidate) &&
                    candidate >= 0
                      ? candidate
                      : null;
                  if (v == null) return null;
                  const h = (v / span) * innerH;
                  const x = gx + barW * si;
                  const y = PAD_T + innerH - h;
                  return (
                    <rect
                      key={si}
                      x={x}
                      y={y}
                      width={barW - 1}
                      height={Math.max(0, h)}
                      fill={`url(#${patternPrefix}-bar-${si})`}
                      rx={2}
                      onMouseEnter={() =>
                        setHover({ ci, si, x: x + barW / 2, y, v })
                      }
                      onMouseLeave={() => setHover(null)}
                      style={{ cursor: "pointer" }}
                    />
                  );
                })}
                <text
                  x={PAD_L + groupW * ci + groupW / 2}
                  y={PAD_T + innerH + 14}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--pw-fg-subtle)"
                >
                  {truncate(cat, 12)}
                </text>
              </g>
            );
          })}
        </svg>

        <BarLegend series={series} palette={palette} />
        <BarInspection
          hover={hover}
          categories={categories}
          series={series}
          valueLabel={valueLabel}
        />
      </div>
      <ChartDataDisclosure
        props={props}
        title={title}
        summary={summary}
        columns={dataColumns}
        rows={dataRows}
      />
    </div>
  );
}

function BarLegend({
  series,
  palette,
}: {
  series: BarSeries[];
  palette: readonly string[];
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
      {series.map((item, index) => (
        <div
          key={item.label}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: item.color ?? palette[index] ?? "var(--pw-accent)",
              display: "inline-block",
            }}
          />
          {item.label}
        </div>
      ))}
    </div>
  );
}

function BarInspection({
  hover,
  categories,
  series,
  valueLabel,
}: {
  hover: BarHover | null;
  categories: string[];
  series: BarSeries[];
  valueLabel: string;
}): ReactElement {
  const message = hover
    ? `${categories[hover.ci] ?? "Category"}, ${series[hover.si]?.label ?? "Series"}: ${hover.v == null ? "No data" : `${hover.v.toLocaleString()} ${valueLabel}`}`
    : "";
  return (
    <>
      {hover ? (
        <div
          style={{
            position: "absolute",
            left: hover.x,
            top: hover.y - 8,
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
            {categories[hover.ci]} · {series[hover.si]?.label}
          </div>
          <div>{hover.v == null ? "No data" : hover.v.toLocaleString()}</div>
        </div>
      ) : null}
      <span className="visually-hidden" role="status" aria-live="polite">
        {message}
      </span>
    </>
  );
}

function ChartDataDisclosure({
  props,
  title,
  summary,
  columns,
  rows,
}: {
  props: BarChartProps;
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
      rowHeaderLabel="Category"
      columns={columns}
      rows={rows}
      provenance={props.provenance}
      exportFileName={props.exportFileName}
      exportPrivacy={props.exportPrivacy}
      {...(props.allowExport != null ? { allowExport: props.allowExport } : {})}
    />
  );
}
