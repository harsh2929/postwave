/**
 * lib/sendTimeLabels.ts — how a send-time cell is NAMED and PRINTED.
 *
 * Split from `sendTimeAnalysis.ts` when that module crossed its 450-line
 * ceiling. The seam is real rather than arbitrary: everything left behind
 * answers "what does this cell measure", and everything here answers "what do
 * we call it and in whose timezone". The first set moves when the API's SQL
 * moves; this set moves when the copy or the locale rules do.
 *
 * The timezone rule is the reason this is a module and not a component helper.
 * The API speaks UTC hour-of-week and a human reads local time, and every place
 * the two are confused produces a plausible-looking wrong answer. Taking the
 * offset as an explicit PARAMETER — rather than reading the ambient device
 * timezone inside the conversion — is what makes it testable, and what makes
 * the half-hour zones (+05:30) and three-quarter-hour zones (+05:45) come out
 * right instead of being rounded away.
 *
 * Import-free apart from types, so the rules run in the node vitest
 * environment (house rule 5).
 */
import {
  BUCKETS_PER_WEEK,
  HOURS_PER_DAY,
  type SendTimeBucket,
  type SendTimeMetric,
} from "./sendTimeAnalysis";

/** Postgres `EXTRACT(DOW)` and Go's `time.Weekday` agree: Sunday is 0. */
export const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const WEEKDAY_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export const SEND_TIME_METRIC_LABEL: Record<SendTimeMetric, string> = {
  score: "Overall",
  openRate: "Opens",
  clickRate: "Clicks",
  signal: "Audience",
};

export interface LocalProjection {
  /** 0 (Sunday) .. 6 (Saturday), in the device's timezone. */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * Project a UTC (day-of-week, hour) cell into the device's local week.
 *
 * `offsetMinutes` is minutes EAST of UTC — i.e. `-new Date().getTimezoneOffset()`.
 * Passing it in rather than reading the ambient timezone is what makes this
 * testable at all, and it also handles the half-hour and three-quarter-hour
 * zones (+05:30, +05:45) that an hour-granular conversion silently mangles.
 */
export function projectHourToLocal(
  dayOfWeek: number,
  hourUTC: number,
  offsetMinutes: number,
): LocalProjection {
  const weekMinutes = BUCKETS_PER_WEEK * 60;
  const base = (dayOfWeek * HOURS_PER_DAY + hourUTC) * 60 + offsetMinutes;
  const wrapped = ((base % weekMinutes) + weekMinutes) % weekMinutes;
  const weekday = Math.floor(wrapped / (HOURS_PER_DAY * 60));
  const rest = wrapped % (HOURS_PER_DAY * 60);
  return {
    weekday,
    hour: Math.floor(rest / 60),
    minute: rest % 60,
  };
}

/** Minutes east of UTC for a given instant, in the device's own timezone. */
export function deviceOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** "14:00" — the UTC bucket, always printed on the hour because it is one. */
export function utcHourLabel(hourUTC: number): string {
  return `${pad2(hourUTC)}:00`;
}

/** "Tue 14:00 UTC". */
export function utcWindowLabel(bucket: SendTimeBucket): string {
  return `${WEEKDAY_SHORT[bucket.dayOfWeek] ?? "?"} ${utcHourLabel(bucket.hourUTC)} UTC`;
}

/** "Tuesday 19:30" in the device's timezone. */
export function localWindowLabel(
  bucket: SendTimeBucket,
  offsetMinutes: number,
): string {
  const local = projectHourToLocal(bucket.dayOfWeek, bucket.hourUTC, offsetMinutes);
  const day = WEEKDAY_LONG[local.weekday] ?? "?";
  return `${day} ${pad2(local.hour)}:${pad2(local.minute)}`;
}

/** "34.2%" — or the em-dash when the rate was never measured. */
export function formatRate(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** The metric's own display form. Rates are percentages; signal is a count. */
export function formatMetric(
  value: number | null,
  metric: SendTimeMetric,
): string {
  if (value === null) return "—";
  if (metric === "signal") return String(Math.round(value));
  if (metric === "score") return value.toFixed(3);
  return formatRate(value);
}

/**
 * One sentence naming what the metric is, in the terms of the query behind it.
 * Kept beside the rules rather than in the component because each one is a
 * claim about the SQL, and it should move when the SQL does.
 */
export const SEND_TIME_METRIC_EXPLANATION: Record<SendTimeMetric, string> = {
  score: "Opens plus twice clicks, nudged by how many subscribers are modelled to read at this hour. The server's own ranking.",
  openRate: "Opens divided by what was delivered into this hour (falling back to what was sent).",
  clickRate: "Clicks divided by what was delivered into this hour (falling back to what was sent).",
  signal: "How many subscribers have this hour as their modelled best hour. Independent of whether you have ever sent then.",
};
