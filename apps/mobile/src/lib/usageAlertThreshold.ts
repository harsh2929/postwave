/**
 * usageAlertThreshold — the phone-shaped control for BILL-038's usage/spend
 * alert threshold, and the copy that keeps it honest.
 *
 * The web settings page renders a `<input type="number">` from 0..100. That
 * is the wrong primitive on a phone (a numeric keyboard for a value nobody
 * tunes to the percentage point), so mobile offers a short set of discrete
 * steps instead. Two consequences follow, and both are handled here rather
 * than in the component:
 *
 *  - A VALUE SET ELSEWHERE MUST STILL BE VISIBLE. Someone who typed 83% on
 *    the web must not open the phone and see the control sitting on "Off" or
 *    silently snapped to 80. `thresholdOptions` splices the current value in
 *    as its own step when it is not one of the presets, so the screen always
 *    shows what is actually stored.
 *  - ABSENT IS NOT ZERO. The Go field is `*int` with `omitempty`, so an
 *    unconfigured threshold is missing from the payload entirely. It renders
 *    as "Off", never as "0%", and the summary sentence says there is no
 *    alert rather than claiming one at 0%.
 *
 * Import-free (no react-native) so every rule above is unit-tested.
 */

/** The discrete steps the phone offers, in ascending order. 0 = off. */
export const USAGE_ALERT_PRESETS: readonly number[] = [0, 75, 80, 90, 100];

export interface ThresholdOption {
  /** The percent to send. 0 clears the threshold server-side. */
  value: number;
  label: string;
  /** Spoken label — never a bare number. */
  accessibilityLabel: string;
}

/**
 * Normalise whatever the server sent into a percent, or null when there is
 * no threshold at all.
 *
 * A non-finite, negative or >100 value is treated as "not configured": the
 * server's own contract is 1..100, so anything else is a payload we cannot
 * render truthfully.
 */
export function normalizeThreshold(
  raw: number | null | undefined,
): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded <= 0 || rounded > 100) return null;
  return rounded;
}

/**
 * The steps to render, with `current` spliced in when it is not a preset.
 * `current` is the normalised value (null = off).
 */
export function thresholdOptions(current: number | null): ThresholdOption[] {
  const values = [...USAGE_ALERT_PRESETS];
  if (current != null && !values.includes(current)) {
    values.push(current);
    values.sort((a, b) => a - b);
  }
  return values.map((value) => ({
    value,
    label: value === 0 ? "Off" : `${value}%`,
    accessibilityLabel:
      value === 0
        ? "No usage alert"
        : `Alert at ${value} percent of a plan limit`,
  }));
}

/**
 * The sentence under the control. It names the CONSEQUENCE (a warning on the
 * billing screen, optionally an email) rather than restating the number,
 * because a percent with no object does not tell anyone what will happen.
 */
export function thresholdSummary(input: {
  threshold: number | null;
  emailOnAlert: boolean;
}): string {
  if (input.threshold == null) {
    return "No usage alert. Nothing warns you before a plan limit is reached.";
  }
  const base = `Warns you when any plan resource — monthly sends, contacts — reaches ${input.threshold}% of its limit.`;
  return input.emailOnAlert
    ? `${base} You also get an email.`
    : `${base} On the billing screen only; email is off.`;
}

/**
 * The PATCH body for a threshold change.
 *
 * Selecting "Off" must send an explicit `0` — the handler reads a MISSING
 * key as "leave as-is", so omitting it would make the Off chip a no-op that
 * looks like it worked.
 */
export function thresholdPatch(next: number): { usage_alert_threshold_pct: number } {
  const clamped = Number.isFinite(next)
    ? Math.max(0, Math.min(100, Math.round(next)))
    : 0;
  return { usage_alert_threshold_pct: clamped };
}
