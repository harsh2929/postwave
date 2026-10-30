/**
 * Pure helpers for the SendTimeHeatmap timezone toggle
 * (gap feature: sto-timezone-toggle-ui).
 *
 * These were lifted out of `SendTimeHeatmap.tsx` so the test suite can
 * import them without forcing vitest to parse JSX (the desktop
 * tsconfig sets `"jsx": "preserve"` so Vite's bundler-side parser can't
 * load a `.tsx` file directly in the node test environment).
 *
 * Conversion model
 * ----------------
 * The backend emits patterns on a UTC 7×24 grid (`grid[dow][hour]`, with
 * Sunday = 0, matching the Go server's day-of-week convention). To show
 * the same grid in another timezone we apply an offset across a
 * linear hour-of-week space (0..167), then decompose back to (dow, hour).
 *
 * - Fractional offsets (IST = +5:30, NPT = +5:45, Chatham = +12:45) are
 *   retained in the displayed axis and tooltip. A +05:30 projection maps
 *   a UTC 00:00 bucket to 05:30 rather than fabricating a 06:00 bucket.
 * - The shift is computed for the *current* moment, so DST during the
 *   180-day rollup window is smeared. That's acceptable — operators only
 *   look at one snapshot, and a "DST-aware" hourly re-bucket would need
 *   per-recipient tz data the backend doesn't ship yet.
 */

export type HeatmapTzMode = "utc" | "local" | "median";

/** Returns the operator's browser timezone name (IANA), e.g.
 *  "America/Los_Angeles". Falls back to "UTC" when `Intl` isn't
 *  available (very old WebViews or non-DOM test runners). */
export function resolveBrowserTz(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

/** UTC→local offset in minutes for the *current* moment.
 *  Positive = east of UTC. JS's `Date.getTimezoneOffset()` returns the
 *  inverse sign convention, hence the negation. */
export function localOffsetMinutes(): number {
  try {
    return -new Date().getTimezoneOffset();
  } catch {
    return 0;
  }
}

/** Minute component displayed on each projected local bucket. */
export function projectedMinute(offsetMinutes: number): number {
  if (!Number.isFinite(offsetMinutes)) return 0;
  return ((Math.trunc(offsetMinutes) % 60) + 60) % 60;
}

/** Shift a (dow, hour) pair by the integer part of an offset. The fractional
 *  component is retained separately by {@link projectedMinute}. */
export function shiftCell(
  dow: number,
  hour: number,
  offsetMinutes: number,
): { dow: number; hour: number } {
  const hourShift = Number.isFinite(offsetMinutes)
    ? Math.floor(offsetMinutes / 60)
    : 0;
  // Bring into a single linear hour-of-week space (0..167) so the
  // wraparound math is unambiguous, then decompose.
  const total = dow * 24 + hour + hourShift;
  // JS modulo can be negative; coerce into 0..167.
  const wrapped = ((total % 168) + 168) % 168;
  return { dow: Math.floor(wrapped / 24), hour: wrapped % 24 };
}

/** Project a UTC 7×24 grid into another timezone by hour-shift.
 *  Tolerates `undefined` and ragged input rows. */
export function shiftGrid(grid: number[][], offsetMinutes: number): number[][] {
  const out: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  if (!Array.isArray(grid)) return out;
  const hourShift = Number.isFinite(offsetMinutes)
    ? Math.floor(offsetMinutes / 60)
    : 0;
  if (hourShift === 0) {
    // Cheap copy that still tolerates ragged input.
    for (let d = 0; d < 7; d += 1) {
      const row = grid[d];
      if (!Array.isArray(row)) continue;
      for (let h = 0; h < 24; h += 1) {
        const v = row[h];
        if (typeof v === "number" && Number.isFinite(v)) out[d]![h] = v;
      }
    }
    return out;
  }
  for (let d = 0; d < 7; d += 1) {
    const row = grid[d];
    if (!Array.isArray(row)) continue;
    for (let h = 0; h < 24; h += 1) {
      const v = row[h];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const shifted = shiftCell(d, h, offsetMinutes);
      out[shifted.dow]![shifted.hour] = v;
    }
  }
  return out;
}

/** Short label for the axis/hint, e.g. "UTC", "PST", "IST". We don't
 *  try to derive a curated abbreviation — the IANA city name (or a GMT
 *  offset for unusual zones) is unambiguous enough. */
export function shortTzLabel(
  mode: HeatmapTzMode,
  tzName: string,
  offsetMinutes: number,
): string {
  if (mode === "utc") return "UTC";
  if (mode === "median") return "median recipient TZ";
  // Local. Prefer the city portion of the IANA name (after the last /),
  // falling back to a GMT±HH:MM stamp.
  if (tzName && tzName !== "UTC") {
    const parts = tzName.split("/");
    const city = parts[parts.length - 1]?.replace(/_/g, " ");
    if (city) {
      const sign = offsetMinutes >= 0 ? "+" : "−";
      const abs = Math.abs(offsetMinutes);
      const hh = Math.floor(abs / 60)
        .toString()
        .padStart(2, "0");
      const mm = (abs % 60).toString().padStart(2, "0");
      return `${city} (GMT${sign}${hh}:${mm})`;
    }
  }
  return "local";
}

export const TZ_PREF_KEY = "pw.sendtime.heatmap.tzmode";

export function loadStoredMode(): HeatmapTzMode | null {
  try {
    const raw =
      typeof window !== "undefined"
        ? window.localStorage.getItem(TZ_PREF_KEY)
        : null;
    if (raw === "utc" || raw === "local" || raw === "median") return raw;
  } catch {
    /* ignore — private mode / quota / SSR */
  }
  return null;
}

export function persistMode(mode: HeatmapTzMode): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TZ_PREF_KEY, mode);
    }
  } catch {
    /* ignore */
  }
}
