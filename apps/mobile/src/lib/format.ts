/**
 * lib/format.ts — the app's single formatting vocabulary.
 *
 * Every screen was formatting values inline and inconsistently:
 * `n.toLocaleString()` in one place and raw `String(n)` in another, four
 * different hand-rolled `timeAgo` implementations, `new Date(x).toLocaleDateString()`
 * with no guard against the invalid dates the API returns as `""`, and
 * hand-concatenated plurals ("1 subscribers"). None of these are bugs on their
 * own; together they are exactly the texture that makes an app feel unfinished.
 *
 * Three principles:
 *
 * 1. NEVER RENDER `NaN`, `Invalid Date`, OR `undefined`. Analytics APIs return
 *    nulls, empty strings, and occasionally strings where numbers belong. Every
 *    helper takes `unknown` and falls back to an em-dash, because a dash reads
 *    as "no value" while `NaN` reads as "this app is broken".
 *
 * 2. ZERO IS NOT EMPTY. `0` is a real, meaningful measurement — "0 bounces" is
 *    good news. Helpers only fall back for genuinely absent values, so a screen
 *    can still distinguish "no data yet" from "measured zero".
 *
 * 3. LOCALE-READY BY CONSTRUCTION. Everything routes through `Intl`, so adding
 *    localization later is a matter of threading a locale through
 *    `setFormatLocale()` rather than rewriting call sites. Relative time is
 *    hand-rolled because `Intl.RelativeTimeFormat` is not reliably present on
 *    Hermes/Android; it is feature-detected and used when available.
 */

/** What we render when a value is genuinely absent (not zero). */
export const EMDASH = "—";

let locale: string | undefined;

/**
 * Override the locale used by every formatter. Called once at startup when the
 * app gains localization; until then `undefined` means "use the device locale".
 */
export function setFormatLocale(next: string | undefined): void {
  locale = next;
  // Every cache below is keyed by locale, so a stale entry would keep printing
  // in the language the app started in.
  numberCache.clear();
  dateCache.clear();
  relativeCache.clear();
}

/**
 * WHY EVERY Intl FORMATTER IS CACHED, not just the numeric one.
 *
 * `new Intl.DateTimeFormat(...)` resolves a locale, loads its data and compiles
 * a pattern; `.format()` on an existing instance does none of that. These
 * helpers are called per row per render — a list under a 1 Hz clock was
 * building one formatter per visible row per second to produce text that had
 * not changed. The key is everything that can vary: the locale plus the option
 * bag, which each call site writes as a literal, so its key order is stable.
 */
const numberCache = new Map<string, Intl.NumberFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();
const relativeCache = new Map<string, Intl.RelativeTimeFormat>();

function cacheKey(options: object): string {
  return `${locale ?? ""}:${JSON.stringify(options)}`;
}

function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = cacheKey(options);
  let fmt = numberCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, options);
    numberCache.set(key, fmt);
  }
  return fmt;
}

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = cacheKey(options);
  let fmt = dateCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateCache.set(key, fmt);
  }
  return fmt;
}

function relativeFormat(
  options: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  const key = cacheKey(options);
  let fmt = relativeCache.get(key);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(locale, options);
    relativeCache.set(key, fmt);
  }
  return fmt;
}

/** Coerce to a finite number, or null when the value is absent/unusable. */
function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Coerce to a valid Date, or null. Handles ISO strings, epoch ms, and Date. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** `1234567` → `1,234,567`. Absent → em-dash. */
export function num(value: unknown, fallback = EMDASH): string {
  const n = finite(value);
  if (n === null) return fallback;
  return numberFormat({ maximumFractionDigits: 0 }).format(n);
}

/**
 * Compact form for tiles and chart axes: `1234` → `1.2K`, `2400000` → `2.4M`.
 * Full precision stays available to screen readers via `num()` — always pair a
 * compact display with an `accessibilityLabel` carrying the exact value, or a
 * VoiceOver user hears "one point two K" and loses the real number.
 */
export function compactNum(value: unknown, fallback = EMDASH): string {
  const n = finite(value);
  if (n === null) return fallback;
  if (Math.abs(n) < 1000) return numberFormat({ maximumFractionDigits: 0 }).format(n);
  return numberFormat({
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(n);
}

/**
 * `0.0423` → `4.2%`. Pass `{ alreadyPercent: true }` when the API hands you
 * `4.23` meaning 4.23% — both conventions appear in this backend, and guessing
 * from magnitude silently mislabels a genuine 0.5% as 50%.
 */
export function percent(
  value: unknown,
  { alreadyPercent = false, digits = 1, fallback = EMDASH } = {},
): string {
  const n = finite(value);
  if (n === null) return fallback;
  const ratio = alreadyPercent ? n / 100 : n;
  return numberFormat({
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(ratio);
}

/** Money. `amount` is in MAJOR units (dollars), matching the billing API. */
export function money(
  value: unknown,
  currency = "USD",
  { fallback = EMDASH, cents = false } = {},
): string {
  const n = finite(value);
  if (n === null) return fallback;
  return numberFormat({
    style: "currency",
    currency,
    // Whole-dollar figures in a tile read better without ".00"; a line item
    // that can carry cents should pass `cents: true`.
    minimumFractionDigits: cents ? 2 : Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Pluralize a count with its noun: `plural(1, "subscriber")` → `1 subscriber`,
 * `plural(0, "subscriber")` → `0 subscribers`. Irregulars take an explicit
 * plural: `plural(3, "entry", "entries")`.
 */
export function plural(
  count: unknown,
  singular: string,
  pluralForm?: string,
): string {
  const n = finite(count);
  if (n === null) return `${EMDASH} ${pluralForm ?? `${singular}s`}`;
  const word = n === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${num(n)} ${word}`;
}

/** Absolute date, no time: `Mar 14, 2026`. */
export function date(value: unknown, fallback = EMDASH): string {
  const d = toDate(value);
  if (!d) return fallback;
  return dateFormat({
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

/**
 * Calendar-label date, for a DAY HEADING rather than a timestamp:
 * `Mon, Mar 14` / `Mar 14` / `Mar 14, 2026`.
 *
 * This exists because four day-grouped surfaces (the notification inbox, the
 * audit feed, the schedule wheel, the DMARC window) each called
 * `toLocaleDateString(undefined, {…})` with their own option bag, which is
 * how the app ended up with a heading that showed the year and another,
 * three rows away, that did not. The two decisions those call sites actually
 * make — "does the weekday lead?" and "has the year rolled over?" — are the
 * only knobs here; everything else is fixed so the headings agree.
 *
 * `weekday: "long"` with `dayMonth: false` gives the bare weekday ("Monday"),
 * which is what a heading inside the current week wants.
 */
export function calendarDate(
  value: unknown,
  {
    weekday,
    withYear = false,
    dayMonth = true,
    fallback = EMDASH,
  }: {
    weekday?: "long" | "short" | undefined;
    withYear?: boolean;
    dayMonth?: boolean;
    fallback?: string;
  } = {},
): string {
  const d = toDate(value);
  if (!d) return fallback;
  const options: Intl.DateTimeFormatOptions = {
    ...(weekday ? { weekday } : {}),
    ...(dayMonth ? { month: "short" as const, day: "numeric" as const } : {}),
    ...(withYear ? { year: "numeric" as const } : {}),
  };
  return dateFormat(options).format(d);
}

/**
 * A MONTH HEADING, with no day in it: `March 2026`.
 *
 * `calendarDate` cannot express this — its `dayMonth` switch is all-or-nothing
 * and drops the month along with the day — and the month grid on the campaign
 * schedule needs the long month name beside the year. Kept here rather than at
 * the call site so a second calendar surface cannot pick a different option
 * bag and disagree with the first, which is the exact split lib/format exists
 * to close.
 */
export function monthYear(value: unknown, fallback = EMDASH): string {
  const d = toDate(value);
  if (!d) return fallback;
  return dateFormat({ month: "long", year: "numeric" }).format(d);
}

/** Date + time: `Mar 14, 2026 at 4:05 PM`. */
export function dateTime(value: unknown, fallback = EMDASH): string {
  const d = toDate(value);
  if (!d) return fallback;
  return dateFormat({
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** Time only: `4:05 PM`. */
export function time(value: unknown, fallback = EMDASH): string {
  const d = toDate(value);
  if (!d) return fallback;
  return dateFormat({
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const hasRelativeTimeFormat =
  typeof (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat ===
  "function";

/**
 * Human relative time: `just now`, `4m ago`, `3h ago`, `2d ago`, `in 5m`.
 * Past AND future are supported — a scheduled campaign's send time is in the
 * future, and the four hand-rolled `timeAgo` helpers this replaces all rendered
 * future timestamps as a nonsensical negative age.
 *
 * Beyond ~4 weeks it falls back to an absolute date, because "63d ago" makes
 * the reader do arithmetic that a date does for them.
 */
export function relativeTime(
  value: unknown,
  { now = Date.now(), fallback = EMDASH } = {},
): string {
  const d = toDate(value);
  if (!d) return fallback;

  const deltaMs = d.getTime() - now;
  const abs = Math.abs(deltaMs);

  if (abs < 45_000) return "just now";
  if (abs >= 4 * WEEK) return date(d);

  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < HOUR
      ? [Math.round(deltaMs / MINUTE), "minute"]
      : abs < DAY
        ? [Math.round(deltaMs / HOUR), "hour"]
        : abs < WEEK
          ? [Math.round(deltaMs / DAY), "day"]
          : [Math.round(deltaMs / WEEK), "week"];

  if (hasRelativeTimeFormat) {
    return relativeFormat({ numeric: "auto" }).format(amount, unit);
  }

  // Hermes/Android fallback — terse forms matching the app's existing voice.
  const short = unit === "minute" ? "m" : unit === "hour" ? "h" : unit === "day" ? "d" : "w";
  const magnitude = Math.abs(amount);
  return deltaMs < 0 ? `${magnitude}${short} ago` : `in ${magnitude}${short}`;
}

/** A duration in ms as `1m 20s` / `2h 5m` / `340ms`. For job + send timings. */
export function duration(ms: unknown, fallback = EMDASH): string {
  const n = finite(ms);
  if (n === null || n < 0) return fallback;
  if (n < 1000) return `${Math.round(n)}ms`;
  const totalSeconds = Math.round(n / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** Byte sizes for exports/attachments: `2.4 MB`. */
export function bytes(value: unknown, fallback = EMDASH): string {
  const n = finite(value);
  if (n === null || n < 0) return fallback;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = n / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${numberFormat({ maximumFractionDigits: size < 10 ? 1 : 0 }).format(size)} ${units[i]}`;
}

/**
 * Middle-truncate an identifier so both ends stay readable:
 * `truncateMiddle("wh_9f2c…b41a", 14)`. Better than a trailing ellipsis for
 * IDs, URLs, and hashes, where the tail is the distinguishing part.
 */
export function truncateMiddle(value: string, max = 18): string {
  // Coerce rather than trust. This is a FORMATTER: it sits at the end of a
  // chain that starts at the wire, and its callers pass fields straight out of
  // a payload (`truncateMiddle(job.id, 22)`). A non-string there used to reach
  // `.length` and `.slice` and take the whole screen down with a red-screen
  // "Cannot read property 'slice' of undefined" -- observed in-app on
  // 2026-08-19 on the migrations screen, where /api/v1/migrations answered
  // 200 text/html (an SPA fallback for an absent upstream) and every job field
  // was therefore undefined.
  //
  // An identifier that cannot be shown is worth an empty string. It is never
  // worth the screen.
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  const keep = Math.max(3, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** Signed delta for trend rows: `+12.4%` / `-3.0%` / `0%`. */
export function signedPercent(
  value: unknown,
  { alreadyPercent = false, digits = 1, fallback = EMDASH } = {},
): string {
  const n = finite(value);
  if (n === null) return fallback;
  const rendered = percent(Math.abs(n), { alreadyPercent, digits });
  if (n > 0) return `+${rendered}`;
  if (n < 0) return `−${rendered}`; // U+2212 minus, not a hyphen
  return rendered;
}

/**
 * The exact, screen-reader-friendly long form of a compact number.
 * Pair with `compactNum` on any tile: `accessibilityLabel={exact(n, "opens")}`.
 */
export function exact(value: unknown, noun?: string): string {
  const n = finite(value);
  if (n === null) return noun ? `No ${noun}` : "No value";
  return noun ? plural(n, noun.replace(/s$/, "")) : num(n);
}
