/**
 * Shared date formatters. Every page used to redefine these — dozens of
 * copies across the codebase, each ~10 lines, varying subtly.
 * Centralising means: smaller bundle, one place to fix bugs, consistent
 * output.
 *
 * Post-consolidation sweep (2026-06): ~40 pages/components import these
 * helpers; 18 byte-identical local copies were folded in (11 → fmtDate,
 * 4 → fmtDateTime, 3 → fmtDayMonth). Helpers that remain local do so
 * intentionally because their rendered output differs:
 *   - relative-time variants with different buckets/sentinels ("5s ago",
 *     "moments ago", "never", compact "5m", future-aware "in 2h",
 *     week/month/year buckets);
 *   - date+time with seconds (audit/webhook detail slideovers) or with
 *     `hour: "numeric"` (no leading zero — fmtDateTime uses "2-digit");
 *   - time-only, weekday, duration, and date-range formats;
 *   - chart-axis formatters that take `Date`/epoch-ms inputs.
 *
 * All formatters:
 *   - accept `string | null | undefined`
 *   - return "—" for empty / invalid input
 *   - never throw (Date parsing failures fall back to the raw input)
 *
 * Output uses the user's locale via `undefined` locale — same as the
 * old call sites — so we don't change any visible behaviour by moving.
 */

const EMPTY = "—";

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a date string. Bare `YYYY-MM-DD` inputs are constructed as
 * LOCAL dates — `new Date("2025-04-15")` parses as UTC midnight, which
 * `toLocaleDateString` then renders as Apr 14 anywhere west of
 * Greenwich. Anything with a time component keeps `Date`'s parsing.
 */
function parseDate(s: string): Date {
  if (BARE_DATE_RE.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    // Out-of-range parts would silently roll over in the Date
    // constructor; fall through to Date parsing (→ Invalid Date → the
    // caller's raw-input fallback) instead.
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d);
    }
  }
  return new Date(s);
}

/**
 * Short date — e.g. "Apr 15, 2025". Most "when did this happen?" cells
 * use this. Does NOT include a time, even when the input has one.
 */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return EMPTY;
  try {
    const d = parseDate(s);
    return Number.isNaN(d.getTime())
      ? s
      : d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
  } catch {
    return s;
  }
}

/**
 * Short date + clock time — e.g. "Apr 15, 2025, 10:23 AM". Use for
 * audit logs and other places where the time matters.
 */
export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return EMPTY;
  try {
    const d = parseDate(s);
    return Number.isNaN(d.getTime())
      ? s
      : d.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  } catch {
    return s;
  }
}

/**
 * Day + month only — e.g. "Apr 15". Used in tight contexts (chips,
 * tooltips) where the year is implicit.
 */
export function fmtDayMonth(s: string | null | undefined): string {
  if (!s) return EMPTY;
  try {
    const d = parseDate(s);
    return Number.isNaN(d.getTime())
      ? s
      : d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
  } catch {
    return s;
  }
}

/**
 * Relative time — "5m ago", "2h ago", "3d ago", falling back to
 * `fmtDate(s)` after 7 days. Useful for activity feeds.
 */
export function fmtRelative(s: string | null | undefined): string {
  if (!s) return EMPTY;
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return s;
  const diff = Date.now() - ts;
  if (diff < 0) return fmtDate(s);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(s);
}
