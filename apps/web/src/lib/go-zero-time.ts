/**
 * lib/go-zero-time.ts — Go's zero time is not a date.
 *
 * A Go `time.Time` that was never set marshals as `"0001-01-01T00:00:00Z"`,
 * and it means "never", not "the first of January, year one". Feed it to
 * `Intl.DateTimeFormat` or `toLocaleDateString()` and the screen says
 * `01/01/0001` — a date that looks like corrupt data to anybody reading it.
 *
 * Observed live on 2026-08-21: `GET /api/v1/translations/settings` answers
 * `updated_at: "0001-01-01T00:00:00Z"` on a workspace that has never saved
 * translation settings.
 *
 * `Date.parse` accepts the string happily, so nothing downstream throws — this
 * is a display bug, not a crash, which is exactly why it survives until
 * somebody looks at the page.
 */

/** Go's `time.Time{}` marshalled by encoding/json. */
const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/**
 * True when the value is absent, empty, or Go's zero time.
 *
 * The year check catches the variants Go emits with different offsets
 * (`0001-01-01T00:00:00+00:00`) without trying to enumerate them.
 */
export function isNeverTimestamp(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed === GO_ZERO_TIME) return true;
  return trimmed.startsWith("0001-01-01");
}

/**
 * Format a wire timestamp, or return `fallback` when it means "never".
 *
 * The fallback is a required argument rather than a default so each call site
 * has to say what "never" means THERE — "Never saved" and "—" are different
 * sentences and only the caller knows which one is true.
 */
export function formatWireTimestamp(
  value: string | null | undefined,
  fallback: string,
  format: (d: Date) => string = (d) => d.toLocaleString(),
): string {
  if (isNeverTimestamp(value)) return fallback;
  const parsed = new Date(value as string);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return format(parsed);
}
