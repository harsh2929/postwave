// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure formatting for the campaign analytics drill-down. JSX-free so the unit
// side of the contract — which numbers are fractions and which are already
// multiplied by 100 — can be asserted directly.
//
// There is exactly one rate formatter and it takes a FRACTION. Percent-unit
// inputs are converted at the call site by `fractionFromPercent`, which is
// named rather than inlined so a reviewer can see, at each use, which unit the
// server sent. Guessing the unit is how a genuine 0.8% renders as 80%.

/** Counts. Non-finite reads as an em dash, never "NaN". */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/** A FRACTION in [0,1] as a percentage: 0.083 → "8.3%", 0.42 → "42%". */
export function formatFractionRate(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  const percent = fraction * 100;
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

/** Percent-unit → fraction, for the `CampaignReport.*_rate` fields. */
export function fractionFromPercent(percent: number): number {
  return Number.isFinite(percent) ? percent / 100 : 0;
}

/** Clamp a magnitude used for a bar width or a funnel step to a finite,
 *  non-negative number. A negative count is a bug, not a bar pointing left. */
export function finiteMagnitude(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A recorded instant, or an explicit statement that it was unreadable. */
export function formatInstant(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "time unavailable";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
}

/** Short axis label for an hourly bucket. */
export function formatHourLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
}

/** The attribution window as a person would say it. */
export function formatGoalWindow(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "window unavailable";
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

/**
 * A minor-unit amount (cents) in its own currency. The currency code is
 * required and comes from the server: an amount rendered without one is a
 * number pretending to be money, and this response is allowed to omit the
 * code — in which case the caller must say the figure is unavailable rather
 * than sum amounts it cannot attribute to a currency.
 */
export function formatMinorUnits(amountMinor: number, currency: string): string {
  if (!Number.isFinite(amountMinor)) return "—";
  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(major);
  } catch {
    // An unrecognised code is still the server's answer; show it beside the
    // number rather than dropping either half.
    return `${major.toFixed(2)} ${currency}`;
  }
}

/** `baseline_selection` / `baseline_unavailable_reason` arrive as snake_case
 *  server enums; render them as words without inventing new ones. */
export function humanizeServerEnum(value: string): string {
  return value.replaceAll("_", " ");
}

/** A benchmark metric named `*_rate` carries a fraction; the rest are counts. */
export function formatBenchmarkValue(name: string, value: number): string {
  return name.toLowerCase().includes("rate")
    ? formatFractionRate(value)
    : formatCount(value);
}

/** Signed percent change, or an em dash when the server withheld one. */
export function formatDeltaPercent(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return "—";
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

/** Trim a tracked destination to something readable in a narrow row while
 *  keeping the host, which is the part that identifies where a click went. */
export function displayLinkDestination(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}
