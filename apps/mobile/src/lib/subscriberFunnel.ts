/**
 * lib/subscriberFunnel.ts — reading `GET /api/v1/analytics/subscribers/funnel`.
 *
 * THE FINDING THAT ASKED FOR THIS DESCRIBED A DIFFERENT FUNNEL, and building
 * the described one would have shipped four labels the server never sends. The
 * handler is apps/api/internal/analytics/handlers.go:472 (`SubscriberFunnel`,
 * behind `read:reports`), and the stages it actually returns are
 * `signup → first_purchase → repeat_purchase` — a COMMERCE funnel, matched
 * from `commerce_orders` to `subscribers` by lowercased email, counting only
 * orders with status `paid` placed at or after signup
 * (analytics/service.go:1051). There is no confirm stage and no engage stage.
 *
 * Three properties of that contract shape everything here:
 *
 *  1. RATES ARE PERCENTAGES, NOT FRACTIONS. `pct()` in analytics.go:1460
 *     multiplies by 100, and the signup step is hardcoded to `100`. Passing
 *     these to `percent()` without `alreadyPercent` would print "10,000%".
 *  2. EACH RATE IS AGAINST THE PREVIOUS STAGE, not against signup. The server
 *     computes `repeat / first`, so a workspace where every first-time buyer
 *     bought twice reads 100% at the last step on a handful of people.
 *  3. A ZERO CONVERSION IS USUALLY "NO STORE", NOT "NOBODY BOUGHT". Every
 *     workspace without a commerce integration gets `signup: N, first: 0,
 *     repeat: 0` — a funnel of zeros that reads as a catastrophic failure. The
 *     card says so in a sentence instead; see `funnelUnavailableReason`.
 *
 * Pure and import-free, so every rule above is testable in a node environment
 * (house rule 6).
 */

/** One stage of the aggregate roll-up across every cohort in the window. */
export interface FunnelStep {
  /** Server stage id: `signup` | `first_purchase` | `repeat_purchase`. */
  stage: string;
  /** Server-supplied display label, e.g. "First Purchase". */
  label: string;
  /** Subscribers that reached the stage. Null when nothing was reported. */
  count: number | null;
  /** Conversion from the PREVIOUS stage, 0..100. Null when not reported. */
  conversionPct: number | null;
}

export interface SubscriberFunnel {
  steps: FunnelStep[];
  /** Signup-month cohorts the roll-up covers; 0 when none were returned. */
  cohortCount: number;
}

/** The stage the server always emits first, and the bar widths' denominator. */
export const FUNNEL_BASE_STAGE = "signup";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function wholeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function conversion(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  // Clamped rather than dropped: a >100% conversion is arithmetically
  // impossible against a prior stage, and rendering "180% purchased" would be
  // worse than rendering the ceiling.
  return Math.min(100, value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Total parser: keeps every stage it can understand, drops the ones it cannot,
 * and never throws. Response-shape drift is this app's dominant defect class,
 * and a throw here would blank the whole Analytics screen rather than one card.
 */
export function parseSubscriberFunnel(raw: unknown): SubscriberFunnel {
  const envelope = record(raw);
  const steps: FunnelStep[] = [];
  const rawSteps = envelope && Array.isArray(envelope.steps) ? envelope.steps : [];
  for (const entry of rawSteps) {
    const row = record(entry);
    if (!row) continue;
    const stage = text(row.stage);
    if (!stage) continue;
    steps.push({
      stage,
      // The server always labels its stages; the fallback only covers a
      // future stage added without one, which is better titled by its id
      // than by an empty string.
      label: text(row.label) || stage,
      count: wholeCount(row.count),
      conversionPct: conversion(row.conversion_rate),
    });
  }
  const cohorts =
    envelope && Array.isArray(envelope.cohorts) ? envelope.cohorts.length : 0;
  return { steps, cohortCount: cohorts };
}

/** The signup count every other stage is measured against, or null. */
export function funnelBaseCount(funnel: SubscriberFunnel): number | null {
  const base =
    funnel.steps.find((step) => step.stage === FUNNEL_BASE_STAGE) ??
    funnel.steps[0];
  return base?.count ?? null;
}

export interface FunnelBar {
  stage: string;
  label: string;
  count: number | null;
  /** 0..100 width of the proportional bar, against the signup stage. */
  widthPct: number;
  /** Conversion from the previous stage, 0..100, or null. */
  conversionPct: number | null;
}

/**
 * Proportional bars, widths measured against the SIGNUP stage rather than
 * against each row's own predecessor — a funnel drawn from per-step rates
 * makes a 2%-of-signups stage look like a wide bar whenever the stage above it
 * is also small, which is the exact misreading a funnel exists to prevent.
 *
 * A stage with no reported count gets width 0 and keeps its null: an absent
 * measurement must not draw a bar of any length (house rule 8).
 */
export function funnelBars(funnel: SubscriberFunnel): FunnelBar[] {
  const base = funnelBaseCount(funnel);
  return funnel.steps.map((step) => ({
    stage: step.stage,
    label: step.label,
    count: step.count,
    widthPct:
      base === null || base <= 0 || step.count === null
        ? 0
        : Math.max(0, Math.min(100, (step.count / base) * 100)),
    conversionPct: step.conversionPct,
  }));
}

/**
 * Why the funnel must not be drawn, or null when it may be.
 *
 * The commerce case is the one that matters. Every workspace without a store
 * connected gets a well-formed payload whose last two stages are zero, and
 * drawing that is a picture of a business that lost all of its customers. The
 * sentence names the join the server actually performs so the reader can tell
 * "we have no orders" from "our orders are not matched".
 */
export function funnelUnavailableReason(
  funnel: SubscriberFunnel,
): string | null {
  if (funnel.steps.length < 2) {
    return "This workspace has not reported a subscriber funnel yet.";
  }
  const base = funnelBaseCount(funnel);
  if (base === null) {
    return "The signup total needed to size this funnel was not reported.";
  }
  const converted = funnel.steps
    .filter((step) => step.stage !== FUNNEL_BASE_STAGE)
    .reduce((sum, step) => sum + (step.count ?? 0), 0);
  if (converted === 0) {
    return "No paid orders are matched to these signup cohorts yet. Purchases are matched to subscribers by email address, so this stays empty until a commerce integration is sending orders.";
  }
  return null;
}

/**
 * Names the window in the card's caption. The server interprets `weeks` as
 * MONTHS for this endpoint (service.go:1026 `months := weeks`), which is the
 * kind of parameter naming that produces a caption claiming twelve weeks of
 * history over a year of it.
 */
export function funnelWindowLabel(months: number, cohortCount: number): string {
  const window =
    months === 1 ? "the last signup month" : `the last ${months} signup months`;
  if (cohortCount <= 0) return `Across ${window}.`;
  const noun = cohortCount === 1 ? "cohort" : "cohorts";
  return `Across ${window} · ${cohortCount} ${noun} with signups.`;
}

/** Spoken sentence for one bar; VoiceOver never sees the bar itself. */
export function funnelBarSpoken(bar: FunnelBar, base: number | null): string {
  if (bar.count === null) return `${bar.label}, not reported.`;
  const share =
    base === null || base <= 0
      ? ""
      : ` , ${Math.round((bar.count / base) * 100)} percent of signups`;
  const step =
    bar.stage === FUNNEL_BASE_STAGE || bar.conversionPct === null
      ? ""
      : `, ${bar.conversionPct.toFixed(1)} percent of the previous stage`;
  return `${bar.label}, ${bar.count}${share}${step}.`;
}
