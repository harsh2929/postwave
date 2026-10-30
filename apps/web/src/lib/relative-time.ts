// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared relative-time formatting. Extracted from resume-card.tsx (which held a
// file-private copy) so activity feeds, the resume card, and any timestamped
// surface render the same "5 minutes ago" phrasing. Dependency-free, locale-
// aware via Intl.RelativeTimeFormat, and defensive against malformed input so a
// bad value never throws during render.

// Constructing an Intl formatter is what these helpers actually cost: measured
// on V8, timeAgo runs 6.06ms/1000 calls building the formatter per call versus
// 0.66ms/1000 reusing one. Neither formatter takes per-call options, so one
// instance of each serves every timestamp on the page. They are built on first
// use rather than at module scope so importing this module (which a server
// render does for every list page) constructs nothing.
let relativeFormat: Intl.RelativeTimeFormat | undefined;
function relativeFormatter(): Intl.RelativeTimeFormat {
  relativeFormat ??= new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });
  return relativeFormat;
}

// These are exactly the fields Date#toLocaleString defaults to (ECMA-402
// ToDateTimeOptions with "any"/"all"), so the rendered string is unchanged --
// only the per-call formatter construction is gone.
let absoluteFormat: Intl.DateTimeFormat | undefined;
function absoluteFormatter(): Intl.DateTimeFormat {
  absoluteFormat ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  return absoluteFormat;
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/**
 * Relative "time ago" for an ISO timestamp (e.g. "5 minutes ago", "in 2 days").
 * Returns "" on a malformed timestamp so callers can omit the stamp entirely.
 * `now` is injectable so tests are deterministic.
 */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.round((now - then) / 1000);
  const rtf = relativeFormatter();
  for (const [unit, secsPer] of UNITS) {
    if (Math.abs(secs) >= secsPer) {
      return rtf.format(-Math.round(secs / secsPer), unit);
    }
  }
  return rtf.format(-secs, "second");
}

/**
 * Absolute, locale-formatted date + time for an ISO timestamp — the `title`/
 * tooltip companion to a relative stamp so the exact moment is one hover away.
 * Returns "" on malformed input.
 */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return absoluteFormatter().format(d);
}
