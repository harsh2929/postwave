/**
 * lib/sendTimeSegmentHeatmap.ts — GET /api/v1/send-time-opt/heatmap?segment_id=
 *
 * WHAT THIS ADDS TO THE SEND-TIME SCREEN. The screen's main grid answers "when
 * does this WORKSPACE read", from `/send-time-opt/best-time-analysis`. That is
 * the right default and it is the only question a tenant-wide endpoint can
 * answer. It is also the wrong question the moment the send in hand goes to one
 * audience: a weekday-morning B2B list and a weekend-evening consumer list
 * average into a shape that describes neither. This module is the scoped
 * answer — pick a segment, see ITS week.
 *
 * WHY IT IS A SEPARATE PARSER AND NOT A SECOND `SendTimeAnalysis`. The two
 * endpoints measure different things and must not be made to look alike:
 *
 *   - best-time-analysis returns per-cell sent/delivered/opened/clicked, so a
 *     cell can be UNMEASURED (nothing was ever sent into it). lib/
 *     sendTimeAnalysis carries that third state and paints it as an outline.
 *   - this endpoint returns a NORMALISED 0..1 average of the per-subscriber
 *     open-pattern grids (dow_pattern.go:322-355). Every one of the 168 cells
 *     is covered by the same model, so a 0 here is a real measurement — "no
 *     modelled engagement in that hour" — not an absence. Only a MALFORMED row
 *     is unknown, and only that gets the outline.
 *
 * Coercing this into `SendTimeAnalysis` would mean inventing sent/delivered
 * counts the server never sent, so the grid stays its own type.
 *
 * THE `omitempty` TRAP THIS EXISTS TO SURVIVE. `SegmentPattern.SecondaryDOW`
 * and `.SecondaryHour` are tagged `omitempty` (dow_pattern.go:216-217) while
 * `has_secondary_window` is not. A genuine secondary window at Sunday 00:00
 * therefore arrives as `{"has_secondary_window": true}` with BOTH coordinates
 * missing. `has_secondary_window` is the authority; the missing coordinates
 * default to 0 rather than deleting the window.
 *
 * Node-run: no react-native import reaches this file.
 */
import { plural } from "./format";
import { DAYS_PER_WEEK, HOURS_PER_DAY } from "./sendTimeAnalysis";
import {
  projectHourToLocal,
  utcHourLabel,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
} from "./sendTimeLabels";

export const SEGMENT_HEATMAP_CELLS = DAYS_PER_WEEK * HOURS_PER_DAY;

/** One cell of the week: a normalised share, or null when the row was malformed. */
export type SegmentHeatmapCell = number | null;

export interface SegmentSendTimeWindow {
  dayOfWeek: number;
  hourUTC: number;
}

export interface SegmentSendTimePattern {
  segmentId: string;
  /**
   * `subscribers_with_data` — how many subscribers in the segment cleared the
   * server's per-subscriber minimum and were averaged in. NOT the segment size.
   */
  subscribersWithData: number;
  /** 168 cells, indexed `dayOfWeek * 24 + hourUTC`. */
  grid: SegmentHeatmapCell[];
  best: SegmentSendTimeWindow;
  /** Only when `has_secondary_window` — see the omitempty note in the header. */
  secondary: SegmentSendTimeWindow | null;
  computedAt: string | null;
}

/** The server's refusal, kept whole so the sentence can be rendered verbatim. */
export interface SegmentHeatmapRefusal {
  code: string;
  /** The server's own wording, or null when it sent none. */
  message: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A finite integer clamped into `0..max`, or 0 when the wire said nothing. */
function coord(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

export function parseSegmentSendTimePattern(
  raw: unknown,
): SegmentSendTimePattern | null {
  const body = record(raw);
  const rows = body["grid"];
  // No grid at all is not an empty week — it is an unreadable answer, and
  // drawing 168 blank cells for it would look exactly like a quiet segment.
  if (!Array.isArray(rows)) return null;

  const grid: SegmentHeatmapCell[] = [];
  for (let day = 0; day < DAYS_PER_WEEK; day += 1) {
    const row = rows[day];
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      const cell = Array.isArray(row) ? row[hour] : undefined;
      grid.push(
        typeof cell === "number" && Number.isFinite(cell) && cell >= 0
          ? cell
          : null,
      );
    }
  }

  const hasSecondary = body["has_secondary_window"] === true;
  return {
    segmentId: typeof body["segment_id"] === "string" ? body["segment_id"] : "",
    subscribersWithData:
      typeof body["subscribers_with_data"] === "number" &&
      Number.isFinite(body["subscribers_with_data"])
        ? Math.max(0, Math.trunc(body["subscribers_with_data"]))
        : 0,
    grid,
    best: {
      dayOfWeek: coord(body["best_dow"], DAYS_PER_WEEK - 1),
      hourUTC: coord(body["best_hour"], HOURS_PER_DAY - 1),
    },
    // The omitempty trap: coordinates absent means 0, never "no window".
    secondary: hasSecondary
      ? {
          dayOfWeek: coord(body["secondary_dow"], DAYS_PER_WEEK - 1),
          hourUTC: coord(body["secondary_hour"], HOURS_PER_DAY - 1),
        }
      : null,
    computedAt:
      typeof body["computed_at"] === "string" && body["computed_at"]
        ? body["computed_at"]
        : null,
  };
}

/**
 * The 404 this endpoint answers with when the segment is too quiet to model.
 *
 * The body is `{"error":"insufficient_data","message":"need >= 30 subscribers
 * with open history; have 4"}` (dow_pattern.go:446-452) — note `error` is a
 * bare STRING here, not the usual `{error:{code,message}}` frame, so nothing
 * downstream recovers a `code` from it and this parser has to.
 *
 * It is a legitimate answer about the segment, not a fault, so the caller
 * renders the server's sentence rather than an error state.
 */
export function segmentHeatmapRefusal(
  status: number,
  payload: unknown,
): SegmentHeatmapRefusal | null {
  if (status !== 404) return null;
  const body = record(payload);
  const code = body["error"];
  if (typeof code !== "string" || !code) return null;
  const message = body["message"];
  return {
    code,
    message: typeof message === "string" && message ? message : null,
  };
}

/** The brightest measured cell — what the colour ramp is scaled against. */
export function segmentGridPeak(pattern: SegmentSendTimePattern): number {
  let peak = 0;
  for (const cell of pattern.grid) {
    if (cell !== null && cell > peak) peak = cell;
  }
  return peak;
}

export function segmentCellAt(
  pattern: SegmentSendTimePattern,
  dayOfWeek: number,
  hourUTC: number,
): SegmentHeatmapCell {
  const cell = pattern.grid[dayOfWeek * HOURS_PER_DAY + hourUTC];
  return cell === undefined ? null : cell;
}

/**
 * The strongest measured hour in one day, or null when the whole row was
 * unreadable. Feeds the per-row spoken label — the grid itself is one
 * accessible element per DAY, exactly like the tenant heatmap.
 */
export function segmentDayPeak(
  pattern: SegmentSendTimePattern,
  dayOfWeek: number,
): { hourUTC: number; value: number } | null {
  let best: { hourUTC: number; value: number } | null = null;
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const value = segmentCellAt(pattern, dayOfWeek, hour);
    if (value === null) continue;
    if (!best || value > best.value) best = { hourUTC: hour, value };
  }
  return best;
}

/**
 * "Averaged over 412 subscribers with open history." — the denominator, said
 * plainly, because the grid is a MODEL and its trustworthiness is the sample
 * behind it. No number here is invented: it is the server's own
 * `subscribers_with_data`.
 */
export function segmentSampleSentence(
  pattern: SegmentSendTimePattern,
): string {
  return `Averaged over ${plural(
    pattern.subscribersWithData,
    "subscriber",
  )} with open history.`;
}

/** "Tue 14:00 UTC" — the coordinate exactly as the server reported it. */
export function segmentWindowUtcLabel(window: SegmentSendTimeWindow): string {
  return `${WEEKDAY_SHORT[window.dayOfWeek] ?? "?"} ${utcHourLabel(
    window.hourUTC,
  )} UTC`;
}

/**
 * "Tuesday 19:30" on the device.
 *
 * Same projection the tenant grid's cell detail uses, so a window read here and
 * a window read there cannot disagree — including in the half-hour zones, where
 * an hour-granular conversion silently moves the answer.
 */
export function segmentWindowLocalLabel(
  window: SegmentSendTimeWindow,
  offsetMinutes: number,
): string {
  const local = projectHourToLocal(
    window.dayOfWeek,
    window.hourUTC,
    offsetMinutes,
  );
  const day = WEEKDAY_LONG[local.weekday] ?? "?";
  const pad = (v: number): string => (v < 10 ? `0${v}` : String(v));
  return `${day} ${pad(local.hour)}:${pad(local.minute)}`;
}
