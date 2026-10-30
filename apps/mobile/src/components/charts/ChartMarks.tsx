/**
 * ChartMarks — the SVG marks a line chart draws inside its plot.
 *
 * Split out of `TimeSeriesChart` for the same reason `ChartParts` was: the
 * chart file is close to the repo's per-file source budget
 * (`scripts/check-source-budgets.mjs`) and adding accessible traversal to it
 * left no headroom. The division of labour is now:
 *
 *   ChartParts  — React Native chrome around the plot (title, legend, readout,
 *                 hint, data table). No SVG.
 *   ChartMarks  — what is painted INSIDE the plot. SVG only, no chrome.
 *
 * Both are presentation-only: the arithmetic lives in `lib/chartScale` and the
 * colours in `lib/chartPalette`, which was validated for colour-vision
 * separation. Never pass a raw hex to either.
 */
import { Circle, G, Line, Path } from "react-native-svg";

import { areaPath, linePath, pathSegments } from "@/lib/chartScale";

import type { ChartSeriesLike } from "./ChartParts";

export function SeriesMarks({
  series,
  color,
  extent,
  plotWidth,
  plotHeight,
  area,
}: {
  series: ChartSeriesLike;
  color: string;
  extent: { min: number; max: number };
  plotWidth: number;
  plotHeight: number;
  area: boolean;
}) {
  const segments = pathSegments(series.values, extent, plotWidth, plotHeight);
  return (
    <G>
      {area
        ? segments.map((segment) => (
            <Path
              key={`area-${segment.startIndex}`}
              d={areaPath(segment.points, plotHeight)}
              fill={color}
              fillOpacity={0.12}
            />
          ))
        : null}
      {segments.map((segment) => (
        <Path
          key={`line-${segment.startIndex}`}
          d={linePath(segment.points)}
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
      {/* A run of one has no line to see; a marker keeps a single measured day
          from rendering as an empty chart. */}
      {segments
        .filter((segment) => segment.points.length === 1)
        .map((segment) => (
          <Circle
            key={`dot-${segment.startIndex}`}
            cx={segment.points[0]?.x ?? 0}
            cy={segment.points[0]?.y ?? 0}
            r={4}
            fill={color}
          />
        ))}
    </G>
  );
}

export function Crosshair({
  x,
  plotHeight,
  stroke,
  ring,
  markers,
}: {
  x: number;
  plotHeight: number;
  stroke: string;
  ring: string;
  markers: readonly { id: string; color: string; y: number }[];
}) {
  return (
    <G>
      <Line
        x1={x}
        y1={0}
        x2={x}
        y2={plotHeight}
        stroke={stroke}
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      {markers.map((marker) => (
        <Circle
          key={marker.id}
          cx={x}
          cy={marker.y}
          r={4.5}
          fill={marker.color}
          // 2px surface ring keeps a marker legible where it lands on a
          // gridline or overlaps another series.
          stroke={ring}
          strokeWidth={2}
        />
      ))}
    </G>
  );
}
