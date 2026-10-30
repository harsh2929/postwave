/**
 * Per-subscriber best-send-time decoding (MAP#49).
 *
 * `GET /api/v1/subscribers/{id}/best-send-time` returns
 * `{ email, best_hour_utc, computed_at, sample_size }` — and `best_hour_utc`
 * is NOT an hour of the day. It is an HOUR OF WEEK in 0..167, computed by
 * apps/api/internal/send_time_opt/send_time_opt.go:89:
 *
 *     func HourOfWeek(t time.Time) int { t = t.UTC(); return int(t.Weekday())*24 + t.Hour() }
 *
 * Go's `time.Weekday` puts Sunday at 0, so 0 = Sunday 00:00 UTC and 167 =
 * Saturday 23:00 UTC. This matters more than it looks: the SEGMENT endpoint
 * (`GET /api/v1/send-time-opt`, already wrapped by src/api/sendTime.ts) returns
 * a STRING `"HH:00"` hour-of-DAY instead, because segment aggregation collapses
 * the week dimension. The two endpoints share a field name and share nothing
 * else, which is exactly why this decoder is separate from
 * `parseBestHourUTC`.
 *
 * Two more contract facts worth writing down, both verified in the handler:
 *
 *  - `sample_size` is ZERO on this endpoint. `Repo.GetByID` selects only
 *    (email, best_send_hour, best_send_hour_at) and never populates it; only
 *    `Repo.Compute` does. Rendering it would print "0 signals" for a
 *    well-modelled subscriber, so this module deliberately drops it.
 *  - `computed_at` is Go's zero time when `best_send_hour_at` is NULL, which
 *    marshals as "0001-01-01T00:00:00Z". `computedAt()` treats anything before
 *    1970 as absent rather than printing the year 1.
 *
 * Import-free so the rules are testable in the node vitest environment.
 */

export const HOURS_PER_WEEK = 168;

/** Go's `time.Weekday` ordering — Sunday is 0. */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface BestSendHour {
  /** 0..167, as sent. */
  hourOfWeek: number;
  /** 0 (Sunday) .. 6 (Saturday), UTC. */
  weekdayUTC: number;
  /** 0..23, UTC. */
  hourUTC: number;
  /** e.g. "Tuesday 14:00 UTC". */
  utcLabel: string;
}

/**
 * Decode the wire integer, or null when it is absent / out of range.
 *
 * The handler already 404s on a negative value (`insufficient_data`), so a
 * negative here means a gateway that did not, and it must NOT be rendered as
 * "Sunday 00:00".
 */
export function decodeBestHourOfWeek(value: unknown): BestSendHour | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value >= HOURS_PER_WEEK) return null;
  const weekdayUTC = Math.floor(value / 24);
  const hourUTC = value % 24;
  return {
    hourOfWeek: value,
    weekdayUTC,
    hourUTC,
    utcLabel: `${WEEKDAY_NAMES[weekdayUTC]} ${String(hourUTC).padStart(2, "0")}:00 UTC`,
  };
}

/**
 * The next instant at or after `now` whose UTC hour-of-week is `hourOfWeek`.
 *
 * Mirrors `nextHourOfWeek` in send_time_opt.go so the phone and the scheduler
 * agree on which moment the recommendation points at. Like the Go version it
 * truncates to the start of the hour before adding the delta, so the returned
 * instant is always on an hour boundary — with one deliberate difference: Go
 * returns `now` unchanged when the current bucket already matches (it is
 * scheduling from "now"), whereas this returns the START of the current hour,
 * because the phone is DESCRIBING a recurring window rather than picking a
 * send instant.
 */
export function nextBestSendInstant(
  hourOfWeek: number,
  now: Date = new Date(),
): Date | null {
  if (!Number.isInteger(hourOfWeek) || hourOfWeek < 0 || hourOfWeek >= HOURS_PER_WEEK) {
    return null;
  }
  const base = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0,
      0,
      0,
    ),
  );
  const current = base.getUTCDay() * 24 + base.getUTCHours();
  let delta = hourOfWeek - current;
  if (delta < 0) delta += HOURS_PER_WEEK;
  return new Date(base.getTime() + delta * 3_600_000);
}

/**
 * `computed_at`, or null when the column was NULL server-side.
 *
 * Go marshals a zero `time.Time` as "0001-01-01T00:00:00Z"; printing that as
 * "Jan 1, 1" is worse than printing nothing.
 */
export function computedAt(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Anything before the epoch is Go's zero value, not a real measurement.
  if (ms < 0) return null;
  return value;
}

/**
 * How the screen should treat a failed best-send-time read.
 *
 * The handler answers 404 in TWO different situations and they are not the
 * same sentence:
 *   - `{"error":"insufficient_data"}` — the subscriber exists, the model has
 *     fewer than MinOpens qualifying signals. Calm, expected, not a fault.
 *   - `{"error":{"code":"not_found"}}` — no such subscriber for this tenant.
 * Every other status is a genuine failure.
 */
export type SendTimeOutcome = "insufficient" | "missing" | "forbidden" | "error";

export function classifySendTimeFailure(
  status: number,
  code: string | undefined,
  rawBody?: unknown,
): SendTimeOutcome {
  if (status === 403) return "forbidden";
  if (status === 404) {
    if (code === "insufficient_data") return "insufficient";
    // The insufficient-data 404 is written as a BARE `{"error":"..."}` string
    // rather than the `{"error":{"code":...}}` envelope the SDK parses, so the
    // code may not survive the client. Fall back to the body.
    if (
      rawBody &&
      typeof rawBody === "object" &&
      (rawBody as { error?: unknown }).error === "insufficient_data"
    ) {
      return "insufficient";
    }
    return "missing";
  }
  return "error";
}

/** The minimum qualifying signals the handler reports on an insufficient 404. */
export function insufficientMessage(minSignalUnits: unknown): string {
  const n =
    typeof minSignalUnits === "number" && Number.isFinite(minSignalUnits)
      ? minSignalUnits
      : null;
  return n === null
    ? "Not enough opens or clicks yet to model a best send time for this contact."
    : `Not enough opens or clicks yet — this contact needs at least ${n} before a best send time can be modelled.`;
}
