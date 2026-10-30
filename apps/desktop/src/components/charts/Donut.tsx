/**
 * Donut — small ring chart with a centered total + side legend.
 *
 * Used for breakdowns where a small set of categories sum to a whole:
 * bounce types (hard/soft/spam_trap), mail-client family, etc.
 *
 * Pure SVG, theme-aware. Slices cycle through the categorical chart
 * palette (--pw-data-*) so each segment reads as a distinct hue rather
 * than a gradation of the accent.
 */

import { type ReactElement, useState } from "react";

import { CHART_PALETTE } from "./palette";
import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface DonutSlice {
  label: string;
  value: number;
  /** Optional override color (CSS color string). */
  color?: string;
}

export interface DonutProps extends RequiredChartSupportProps {
  slices: DonutSlice[];
  /** Outer diameter, px. */
  size?: number;
  /** Stroke width / ring thickness, px. */
  thickness?: number;
  /** Label shown beneath the centered total. */
  centerLabel?: string;
  /** Number formatter for the center total. */
  formatTotal?: (n: number) => string;
  /** Whether to render the legend next to the ring. Default true. */
  showLegend?: boolean;
  title: string;
  valueLabel: string;
  summary?: string;
}

const DEFAULT_PALETTE = CHART_PALETTE;

function defaultFmt(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return String(n);
}

export function Donut(props: DonutProps): ReactElement {
  const {
    slices,
    size = 140,
    thickness = 18,
    centerLabel,
    formatTotal = defaultFmt,
    showLegend = true,
    title,
    valueLabel,
  } = props;

  const [hover, setHover] = useState<number | null>(null);

  const normalizedSlices = slices.map((slice) => ({
    slice,
    value:
      Number.isFinite(slice.value) && slice.value >= 0 ? slice.value : null,
  }));
  const invalidValueCount = normalizedSlices.filter(
    ({ value }) => value == null,
  ).length;
  const total = normalizedSlices.reduce(
    (acc, { value }) => acc + (value != null && value > 0 ? value : 0),
    0,
  );
  const r = size / 2 - thickness / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  if (total === 0) {
    return (
      <div className="pw-data-visual">
        <div
          className="pw-chart-empty"
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            color: "var(--pw-fg-subtle)",
          }}
        >
          <svg width={size} height={size} aria-hidden>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="var(--pw-border)"
              strokeWidth={thickness}
              strokeDasharray="4 6"
            />
          </svg>
          <div style={{ fontSize: 12 }}>No data available for {title}.</div>
        </div>
        <AccessibleChartData
          title={title}
          summary="No positive category values are available."
          columns={[
            { key: "value", label: valueLabel },
            { key: "share", label: "Share" },
          ]}
          rows={normalizedSlices.map(({ slice, value }, index) => ({
            key: `${index}-${slice.label}`,
            label: slice.label,
            values: {
              value: value == null ? "No data" : formatTotal(value),
              share: value == null ? "No data" : "0.0%",
            },
            exportValues: {
              value: value ?? "",
              share: value == null ? "" : "0.0%",
            },
          }))}
          provenance={props.provenance}
          exportFileName={props.exportFileName}
          exportPrivacy={props.exportPrivacy}
          {...(props.allowExport != null
            ? { allowExport: props.allowExport }
            : {})}
        />
      </div>
    );
  }

  let accOffset = 0;
  const renderedSlices = normalizedSlices.map(({ slice: s, value }, i) => {
    const v = value ?? 0;
    const frac = v / total;
    const dash = frac * circ;
    const gap = circ - dash;
    const offset = -accOffset;
    accOffset += dash;
    const color = s.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
    return { i, s, value, dash, gap, offset, color, frac };
  });

  const highlighted = hover != null ? renderedSlices[hover] : null;
  const summary =
    props.summary ??
    `${renderedSlices.length} categories with a total of ${formatTotal(total)}${invalidValueCount > 0 ? `; ${invalidValueCount} unavailable values remain gaps` : ""}.`;
  const markers = ["●", "◆", "■", "▲", "⬟"];

  return (
    <div className="pw-data-visual">
      <div
        className="pw-donut-layout"
        style={{ display: "flex", alignItems: "center", gap: 18 }}
      >
        <div style={{ position: "relative", width: size, height: size }}>
          <svg
            width={size}
            height={size}
            style={{ display: "block", transform: "rotate(-90deg)" }}
            aria-label={`${title}. ${summary}`}
            role="img"
          >
            {/* track */}
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="var(--pw-bg-elev-2)"
              strokeWidth={thickness}
            />
            {renderedSlices.map((rs) => (
              <circle
                key={rs.i}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={rs.color}
                strokeWidth={
                  hover != null && hover === rs.i ? thickness + 2 : thickness
                }
                strokeDasharray={`${rs.dash} ${rs.gap}`}
                strokeDashoffset={rs.offset}
                style={{
                  transition: "stroke-width 120ms ease-out",
                  cursor: "pointer",
                }}
                onMouseEnter={() => setHover(rs.i)}
                onMouseLeave={() => setHover(null)}
              >
                <title>{`${rs.s.label}: ${rs.value == null ? "No data" : formatTotal(rs.value)}, ${(rs.frac * 100).toFixed(0)}%`}</title>
              </circle>
            ))}
          </svg>
          <div
            className="pw-donut-center"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: "var(--pw-fg)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {highlighted
                ? highlighted.value == null
                  ? "—"
                  : formatTotal(highlighted.value)
                : formatTotal(total)}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--pw-fg-subtle)",
                marginTop: 2,
              }}
            >
              {highlighted ? highlighted.s.label : (centerLabel ?? "Total")}
            </div>
          </div>
        </div>
        {showLegend ? (
          <div
            className="pw-donut-legend"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 12,
              minWidth: 120,
            }}
          >
            {renderedSlices.map((rs) => (
              <button
                key={rs.i}
                type="button"
                aria-label={`Inspect ${rs.s.label}: ${rs.value == null ? "No data" : formatTotal(rs.value)}, ${(rs.frac * 100).toFixed(0)}%`}
                aria-pressed={hover === rs.i}
                onMouseEnter={() => setHover(rs.i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(rs.i)}
                onClick={() =>
                  setHover((current) => (current === rs.i ? null : rs.i))
                }
                style={{
                  display: "grid",
                  gridTemplateColumns: "10px 1fr auto",
                  gap: 8,
                  alignItems: "center",
                  cursor: "pointer",
                  opacity: hover != null && hover !== rs.i ? 0.45 : 1,
                  transition: "opacity 120ms ease-out",
                  padding: 2,
                  border: 0,
                  background: "transparent",
                  font: "inherit",
                  color: "inherit",
                  textAlign: "left",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    color: rs.color,
                    fontSize: 11,
                  }}
                >
                  {markers[rs.i % markers.length]}
                </span>
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--pw-fg)",
                  }}
                >
                  {rs.s.label}
                </span>
                <span
                  className="tabular"
                  style={{ color: "var(--pw-fg-muted)" }}
                >
                  {(rs.frac * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <AccessibleChartData
        title={title}
        summary={summary}
        columns={[
          { key: "value", label: valueLabel },
          { key: "share", label: "Share" },
        ]}
        rows={renderedSlices.map((slice) => ({
          key: `${slice.i}-${slice.s.label}`,
          label: slice.s.label,
          values: {
            value: slice.value == null ? "No data" : formatTotal(slice.value),
            share:
              slice.value == null
                ? "No data"
                : `${(slice.frac * 100).toFixed(1)}%`,
          },
          exportValues: {
            value: slice.value ?? "",
            share:
              slice.value == null ? "" : `${(slice.frac * 100).toFixed(1)}%`,
          },
        }))}
        provenance={props.provenance}
        exportFileName={props.exportFileName}
        exportPrivacy={props.exportPrivacy}
        {...(props.allowExport != null
          ? { allowExport: props.allowExport }
          : {})}
      />
    </div>
  );
}
