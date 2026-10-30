/**
 * Pure helpers backing the SendTimeHeatmap screen-reader summary
 * (gap feature: sto-heatmap-a11y).
 *
 * These live in their own .ts module (not the .tsx component) so the
 * vitest node environment can import them without parsing JSX —
 * matches the same pattern as ./tz for the timezone toggle helpers.
 *
 * What we expose
 * --------------
 *  - `topCells(grid, n)`  →  the top-N (dow, hour) buckets by value,
 *                            with zero-valued cells filtered out so a
 *                            cold-start grid doesn't announce
 *                            "Sunday 12 AM with 0 opens" as a peak.
 *  - `fmtHourLong(h)`     →  expanded "9 AM" / "1 PM" hour label that
 *                            screen readers pronounce naturally (the
 *                            compact `12a`/`9p` visual form gets read
 *                            as "twelve-a" / "nine-p" on most engines).
 *  - `DOW_LONG_LABELS`    →  full weekday names matching the backend's
 *                            Sunday-=-0 convention.
 *  - `buildHeatmapSummary(...)`  →  one-line "Peak Tuesday at 9 AM UTC"
 *                            summary, used for the wrapper aria-label
 *                            on the heatmap grid.
 */

export const DOW_LONG_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface TopCell {
  dow: number;
  hour: number;
  value: number;
}

/** Expanded "9 AM" / "1 PM" style hour label for screen-reader output.
 *  The compact `12a`/`9p` form is great visually but jarring when
 *  spoken by a screen reader (most pronounce it as "twelve-a"). */
export function fmtHourLong(h: number, minute = 0): string {
  if (!Number.isFinite(h) || h < 0 || h > 23) return "unknown hour";
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
    return "unknown hour";
  }
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  const minuteLabel = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  return `${hh}${minuteLabel} ${ampm}`;
}

/** Pick the top-N (dow, hour) buckets by value. Used to build a textual
 *  summary for screen-reader users who can't perceive the colour ramp.
 *  Zero-valued cells are excluded so empty grids don't produce a
 *  meaningless "top hour: Sunday 12 AM with 0 opens" announcement.
 *
 *  Ties: stable order — earlier (dow, hour) wins. That keeps the
 *  announcement deterministic across renders so SR users don't hear a
 *  different "top hour" each time the grid re-renders with identical
 *  data. */
export function topCells(g: number[][], n: number): TopCell[] {
  const out: TopCell[] = [];
  if (!Array.isArray(g)) return out;
  for (let d = 0; d < g.length; d++) {
    const row = g[d];
    if (!Array.isArray(row)) continue;
    for (let h = 0; h < row.length; h++) {
      const v = row[h];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
      out.push({ dow: d, hour: h, value: v });
    }
  }
  // Sort by value desc; preserve insertion order for ties so the
  // announcement is deterministic (Array.prototype.sort is stable in
  // modern engines, which is what the WebView ships).
  out.sort((a, b) => b.value - a.value);
  return out.slice(0, Math.max(0, n));
}

/** Build the wrapper aria-label for a heatmap given its top-N cells.
 *  Lifted out so the React component and tests share the exact same
 *  formatter — drift here would let visual changes silently regress
 *  what SR users hear. */
export function buildHeatmapSummary(
  top: TopCell[],
  tzLabel: string,
  minute = 0,
): string {
  if (top.length === 0) {
    return "Engagement heatmap by day of week and hour of day. No engagement recorded yet.";
  }
  const lead = top[0];
  const dow = DOW_LONG_LABELS[lead.dow] ?? "unknown day";
  return `Engagement heatmap by day of week and hour of day. Peak ${dow} at ${fmtHourLong(lead.hour, minute)} ${tzLabel}.`;
}
