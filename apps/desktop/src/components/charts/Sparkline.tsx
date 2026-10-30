/**
 * Sparkline — tiny inline trend line used inside KPI cards.
 *
 * Visually compact (no axes), with keyboard point inspection and an optional
 * exact table/provenance/export disclosure for decision-bearing callers.
 * Tiny supplemental callers omit the disclosure and keep the original
 * lightweight footprint. Reads `--pw-accent` so it theme-flips.
 */

import { type ReactElement, useState } from "react";

import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface SparklineDataDisclosure extends RequiredChartSupportProps {
  title: string;
  summary?: string;
  rowHeaderLabel?: string;
}

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  /** Stroke color CSS var/value; defaults to --pw-accent. */
  color?: string;
  /** Whether to paint a subtle area fill below the line. */
  fill?: boolean;
  /** Direction hint — when "down", we render in danger color. */
  trend?: "up" | "down" | "flat";
  ariaLabel?: string;
  /** Optional point labels (dates/categories) for keyboard inspection. */
  labels?: readonly string[];
  valueLabel?: string;
  formatValue?: (value: number) => string;
  className?: string;
  responsive?: boolean;
  /**
   * Whether this supplemental chart is an independent keyboard inspection
   * stop. Dense tables should set this false and expose the same values in
   * their row/table semantics instead of adding hundreds of tab stops.
   */
  interactive?: boolean;
  /** Render every finite sample as a marker, useful when gaps isolate points. */
  showAllPoints?: boolean;
  /** Fixed comparison scale, e.g. [0, 100] for reputation percentages. */
  domain?: readonly [number, number];
  /**
   * Opt-in exact table/provenance/export for decision-bearing sparklines.
   * Tiny supplemental uses stay lightweight when this is omitted.
   */
  dataDisclosure?: SparklineDataDisclosure;
}

const DEFAULT_W = 96;
const DEFAULT_H = 28;

function resolveDirection(
  trend: SparklineProps["trend"],
  firstValue: number,
  lastValue: number,
): NonNullable<SparklineProps["trend"]> {
  if (trend) return trend;
  if (lastValue > firstValue) return "up";
  if (lastValue < firstValue) return "down";
  return "flat";
}

function describeDirection(
  direction: NonNullable<SparklineProps["trend"]>,
): string {
  if (direction === "flat") return "Flat";
  return direction === "up" ? "Rising" : "Falling";
}

export function Sparkline(props: SparklineProps): ReactElement {
  const {
    values,
    width = DEFAULT_W,
    height = DEFAULT_H,
    fill = true,
    trend,
    ariaLabel,
    labels,
    valueLabel = "Value",
    formatValue = (value) => value.toLocaleString(),
    className,
    responsive = false,
    interactive = true,
    showAllPoints = false,
    domain,
    dataDisclosure,
  } = props;
  const [inspectIndex, setInspectIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (values.length === 0) {
    return (
      <>
        <svg
          width={responsive ? "100%" : width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className={className}
          style={{ display: "block", opacity: 0.4 }}
          role="img"
          aria-label={ariaLabel ?? "Trend unavailable: no data points"}
        >
          <line
            x1={0}
            x2={width}
            y1={height / 2}
            y2={height / 2}
            stroke="var(--pw-border)"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        </svg>
        <ExactSparklineData
          values={values}
          labels={labels}
          valueLabel={valueLabel}
          formatValue={formatValue}
          disclosure={dataDisclosure}
        />
      </>
    );
  }

  // Preserve missing/invalid samples as gaps. Rendering them as zero would
  // invent a drop that does not exist and can lead to the wrong decision.
  const safe = values.map((value) => (Number.isFinite(value) ? value : null));
  const finite = safe.filter((value): value is number => value != null);

  if (finite.length === 0) {
    return (
      <>
        <svg
          width={responsive ? "100%" : width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className={className}
          style={{ display: "block", opacity: 0.4 }}
          role="img"
          aria-label={
            ariaLabel ?? "Trend unavailable: all data points are invalid"
          }
        >
          <line
            x1={0}
            x2={width}
            y1={height / 2}
            y2={height / 2}
            stroke="var(--pw-border)"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        </svg>
        <ExactSparklineData
          values={values}
          labels={labels}
          valueLabel={valueLabel}
          formatValue={formatValue}
          disclosure={dataDisclosure}
        />
      </>
    );
  }

  const max = Math.max(...finite);
  const min = Math.min(...finite);
  const domainIsValid =
    domain != null &&
    Number.isFinite(domain[0]) &&
    Number.isFinite(domain[1]) &&
    domain[1] > domain[0];
  const scaleMin = domainIsValid ? domain[0] : min;
  const scaleMax = domainIsValid ? domain[1] : max;
  const span = scaleMax - scaleMin || 1;

  const stepX = safe.length > 1 ? width / (safe.length - 1) : 0;
  const pad = 2;
  const innerH = height - pad * 2;

  const pts = safe.map((value, index) => {
    const x = safe.length === 1 ? width / 2 : stepX * index;
    if (value == null) return null;
    const bounded = Math.max(scaleMin, Math.min(scaleMax, value));
    const y = pad + innerH - ((bounded - scaleMin) / span) * innerH;
    return [x, y] as const;
  });

  let startsSegment = true;
  const linePath = pts
    .map((point) => {
      if (!point) {
        startsSegment = true;
        return "";
      }
      const command = startsSegment ? "M" : "L";
      startsSegment = false;
      return `${command}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  const hasGaps = finite.length !== safe.length;
  const areaPath = hasGaps
    ? ""
    : `${linePath} L${width},${height} L0,${height} Z`;
  const activeIndex = Math.min(inspectIndex, safe.length - 1);
  const activePoint = pts[activeIndex];
  const activeLabel = labels?.[activeIndex] ?? `Point ${activeIndex + 1}`;
  const activeSample = safe[activeIndex];
  const activeValue =
    activeSample == null ? "No data" : formatValue(activeSample);
  const firstValue = finite[0] ?? 0;
  const lastValue = finite.at(-1) ?? firstValue;
  const direction = resolveDirection(trend, firstValue, lastValue);

  const color =
    props.color ??
    (direction === "down" ? "var(--pw-danger)" : "var(--pw-accent)");
  const numericSummary = `${describeDirection(direction)} trend with ${safe.length} points${hasGaps ? `, ${safe.length - finite.length} unavailable` : ""}; starts at ${formatValue(firstValue)}, ends at ${formatValue(lastValue)}, minimum ${formatValue(min)}, maximum ${formatValue(max)}.`;
  const summary = ariaLabel
    ? `${ariaLabel}. ${numericSummary}`
    : numericSummary;

  const inspect = (key: string): void => {
    if (key === "ArrowLeft" || key === "ArrowDown") {
      setInspectIndex((index) => Math.max(0, index - 1));
    } else if (key === "ArrowRight" || key === "ArrowUp") {
      setInspectIndex((index) => Math.min(safe.length - 1, index + 1));
    } else if (key === "Home") {
      setInspectIndex(0);
    } else if (key === "End") {
      setInspectIndex(safe.length - 1);
    }
  };

  return (
    <>
      <span
        className={`pw-sparkline-inspector${className ? ` ${className}` : ""}`}
        style={{
          width: responsive ? "100%" : width,
          height,
          display: "inline-block",
          position: "relative",
        }}
      >
        <svg
          width={responsive ? "100%" : width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ display: "block" }}
          role="img"
          tabIndex={interactive ? 0 : undefined}
          aria-label={
            interactive
              ? `${summary} Use Left and Right Arrow keys to inspect points. ${activeLabel}: ${activeValue} ${valueLabel}.`
              : summary
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width <= 0) return;
            const ratio = Math.max(
              0,
              Math.min(1, (event.clientX - rect.left) / rect.width),
            );
            setInspectIndex(Math.round(ratio * (safe.length - 1)));
          }}
          onKeyDown={(event) => {
            if (!interactive) return;
            if (
              [
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
              ].includes(event.key)
            ) {
              event.preventDefault();
              inspect(event.key);
            }
          }}
        >
          <title>{summary}</title>
          <desc>
            {direction} trend.
            {safe.length} {interactive ? "inspectable" : "recorded"} points.
          </desc>
          {fill && areaPath ? (
            <path d={areaPath} fill={color} fillOpacity={0.16} />
          ) : null}
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray={
              direction === "down"
                ? "4 2"
                : direction === "flat"
                  ? "1 2"
                  : undefined
            }
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {showAllPoints
            ? pts.map((point, index) =>
                point ? (
                  <circle
                    key={labels?.[index] ?? index}
                    cx={point[0]}
                    cy={point[1]}
                    r={1.25}
                    fill={color}
                    aria-hidden="true"
                  />
                ) : null,
              )
            : null}
          {activePoint ? (
            <circle
              cx={activePoint[0]}
              cy={activePoint[1]}
              r={focused || hovered ? 2.5 : 1.75}
              fill={color}
              stroke="var(--pw-bg-elev)"
              strokeWidth={1}
            />
          ) : null}
        </svg>
        {focused || hovered ? (
          <span
            className="pw-sparkline-tooltip"
            style={{
              left: activePoint?.[0] ?? width / 2,
              top: activePoint ? Math.max(0, activePoint[1] - 4) : 0,
            }}
          >
            {activeLabel}: {activeValue}
          </span>
        ) : null}
        <span className="visually-hidden" role="status" aria-live="polite">
          {focused ? `${activeLabel}: ${activeValue} ${valueLabel}` : ""}
        </span>
      </span>
      <ExactSparklineData
        values={values}
        labels={labels}
        valueLabel={valueLabel}
        formatValue={formatValue}
        disclosure={dataDisclosure}
      />
    </>
  );
}

function ExactSparklineData({
  values,
  labels,
  valueLabel,
  formatValue,
  disclosure,
}: {
  values: readonly number[];
  labels?: readonly string[];
  valueLabel: string;
  formatValue: (value: number) => string;
  disclosure?: SparklineDataDisclosure;
}): ReactElement | null {
  if (!disclosure) return null;
  const finiteCount = values.filter(Number.isFinite).length;
  return (
    <AccessibleChartData
      title={disclosure.title}
      summary={
        disclosure.summary ??
        `${values.length} ordered points; ${finiteCount} contain finite ${valueLabel.toLocaleLowerCase()} values.`
      }
      rowHeaderLabel={disclosure.rowHeaderLabel ?? "Point"}
      columns={[{ key: "value", label: valueLabel }]}
      rows={values.map((value, index) => ({
        key: `${index}-${labels?.[index] ?? "point"}`,
        label: labels?.[index] ?? `Point ${index + 1}`,
        values: {
          value: Number.isFinite(value) ? formatValue(value) : "Unavailable",
        },
        exportValues: { value: Number.isFinite(value) ? value : null },
      }))}
      provenance={disclosure.provenance}
      exportFileName={disclosure.exportFileName}
      exportPrivacy={disclosure.exportPrivacy}
      allowExport={disclosure.allowExport}
    />
  );
}
