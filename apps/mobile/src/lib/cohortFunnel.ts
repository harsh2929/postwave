/**
 * lib/cohortFunnel.ts — the PER-COHORT half of
 * `GET /api/v1/analytics/subscribers/funnel`, plus the audience scope.
 *
 * `lib/subscriberFunnel.ts` reads the aggregate roll-up (`steps`) and throws
 * the `cohorts` array away after counting it. That array is the answer to the
 * question the aggregate cannot answer — "are the people who joined in March
 * converting worse than the people who joined in January?" — and desktop has
 * rendered it since SUB-128 (CohortFunnelCard.tsx per-cohort table).
 *
 * FOUR CONTRACT FACTS THAT SHAPE EVERY FUNCTION BELOW, all read from
 * apps/api/internal/analytics/service.go:1090-1160:
 *
 *  1. ROWS ARE NEWEST FIRST. The query ends `ORDER BY cohort DESC`, so the
 *     first row is the most recent signup month. Sorting here would fight the
 *     server for no gain; the order is preserved and named in the caption.
 *  2. ONLY MONTHS WITH SIGNUPS APPEAR. The GROUP BY drops empty months, so a
 *     12-month request can return 3 rows. The caption states the count it got
 *     rather than the count it asked for.
 *  3. THE TWO RATES HAVE DIFFERENT DENOMINATORS. `first_purchase_rate` is
 *     against that cohort's signups; `repeat_purchase_rate` is against its
 *     FIRST-PURCHASERS (the prior stage). Printing both under one "conversion"
 *     header is the misreading this table exists to prevent, so each column
 *     names its own denominator.
 *  4. `audience_id` IS A TAG NAME, NOT AN ID. handlers.go:535 passes the raw
 *     query value into `$3 = ANY(s.tags)` — matching `subscribers.tags`, which
 *     holds tag NAMES. Sending a tag UUID matches nothing and returns a
 *     well-formed empty funnel, which is indistinguishable from "this audience
 *     never bought anything".
 *
 * Pure and free of react-native imports so every rule above is assertable in a
 * node vitest (house rule 6).
 */
import { EMDASH, num, percent } from "@/lib/format";

/** One signup-month cohort. Every measure is nullable: see `wholeCount`. */
export interface CohortFunnelRow {
  /** Server label, `YYYY-MM` (`to_char(cohort, 'YYYY-MM')`). */
  label: string;
  signups: number | null;
  firstPurchases: number | null;
  repeatPurchases: number | null;
  /** First purchases as a percentage of that cohort's SIGNUPS, 0..100. */
  firstRatePct: number | null;
  /** Repeat purchases as a percentage of its FIRST purchasers, 0..100. */
  repeatRatePct: number | null;
}

/** One aggregate stage of the scoped payload, for the scope summary line. */
export interface CohortStageTotal {
  stage: string;
  label: string;
  count: number | null;
}

export interface CohortFunnelView {
  rows: CohortFunnelRow[];
  stages: CohortStageTotal[];
}

/** The audience selection: "" means every subscriber, no filter sent. */
export const ALL_SUBSCRIBERS = "";

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

function rate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  // Clamped, not dropped: a >100% conversion against a prior stage is
  // arithmetically impossible, and "180% purchased" is worse than the ceiling.
  return Math.min(100, value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The request path. `audience_id` is OMITTED rather than sent empty when no
 * audience is chosen — the handler trims and compares against `''`, so both
 * work, but an absent parameter keeps the unscoped URL (and its query cache
 * key) identical to the one `subscriberFunnelPath` already uses.
 */
export function cohortFunnelPath(months: number, audienceId: string): string {
  const window = Number.isFinite(months) && months > 0 ? Math.trunc(months) : 12;
  const base = `/api/v1/analytics/subscribers/funnel?bucket=month&cohort_by=created_at_month&weeks=${window}`;
  const audience = audienceId.trim();
  if (!audience) return base;
  return `${base}&audience_id=${encodeURIComponent(audience)}`;
}

/**
 * Total parser: keeps the rows it understands, drops the ones it cannot, never
 * throws. Response-shape drift is this app's dominant defect class, and a
 * throw here would blank the funnel card rather than one table.
 */
export function parseCohortFunnel(raw: unknown): CohortFunnelView {
  const envelope = record(raw);
  const rawRows =
    envelope && Array.isArray(envelope.cohorts) ? envelope.cohorts : [];
  const rows: CohortFunnelRow[] = [];
  for (const entry of rawRows) {
    const row = record(entry);
    if (!row) continue;
    const label = text(row.cohort_label);
    if (!label) continue;
    rows.push({
      label,
      signups: wholeCount(row.signup_count),
      firstPurchases: wholeCount(row.first_purchase_count),
      repeatPurchases: wholeCount(row.repeat_purchase_count),
      firstRatePct: rate(row.first_purchase_rate),
      repeatRatePct: rate(row.repeat_purchase_rate),
    });
  }
  const rawStages =
    envelope && Array.isArray(envelope.steps) ? envelope.steps : [];
  const stages: CohortStageTotal[] = [];
  for (const entry of rawStages) {
    const step = record(entry);
    if (!step) continue;
    const stage = text(step.stage);
    if (!stage) continue;
    stages.push({
      stage,
      label: text(step.label) || stage,
      count: wholeCount(step.count),
    });
  }
  return { rows, stages };
}

/** How the scope reads in a sentence. Mirrors desktop's `audienceLabel`. */
export function cohortScopeLabel(audienceId: string): string {
  const audience = audienceId.trim();
  return audience ? `audience “${audience}”` : "all subscribers";
}

/**
 * The line that keeps a FILTERED table from being read against the UNFILTERED
 * bars above it. The stage bars in this card come from the screen's own
 * unscoped query, so once an audience is chosen the two halves of the card
 * measure different populations — and saying so costs one line, where not
 * saying so costs the reader a wrong conclusion.
 *
 * Null when nothing is scoped: there is no discrepancy to explain.
 */
export function cohortScopeSummary(
  view: CohortFunnelView,
  audienceId: string,
): string | null {
  if (!audienceId.trim()) return null;
  const parts = view.stages
    .filter((stage) => stage.count !== null)
    .map((stage) => `${num(stage.count)} ${stage.label.toLowerCase()}`);
  const scope = cohortScopeLabel(audienceId);
  if (parts.length === 0) {
    return `Scoped to ${scope}. The stage bars above cover all subscribers.`;
  }
  return `Scoped to ${scope}: ${parts.join(" · ")}. The stage bars above cover all subscribers.`;
}

/** What the table says when the server returned no cohort rows at all. */
export function cohortFunnelEmptyCopy(
  audienceId: string,
  months: number,
): string {
  const window =
    months === 1 ? "the last signup month" : `the last ${months} signup months`;
  return `No signups in ${window} for ${cohortScopeLabel(audienceId)} — a cohort row appears once that month has a subscriber in it.`;
}

/**
 * The caveat under the table, in the same words desktop uses: conversion is
 * measured lifetime-to-date from each subscriber's own signup, so the newest
 * cohort — the first row — has had the least time to convert and always looks
 * worst.
 */
export const COHORT_MATURITY_NOTE =
  "Newest cohort first. Paid orders count from each subscriber's signup onward, so the newest cohorts have had the least time to reach a purchase and read lowest.";

/** One cell's text; an unreported measure is never drawn as a zero. */
export function cohortCell(value: number | null): string {
  return value === null ? EMDASH : num(value);
}

/** One rate cell, already a percentage on the wire (`pct()` × 100). */
export function cohortRate(value: number | null): string {
  return value === null
    ? EMDASH
    : percent(value, { alreadyPercent: true, digits: value >= 10 ? 0 : 1 });
}

/**
 * The spoken row. A table read cell-by-cell by VoiceOver loses which
 * denominator each rate belongs to, so the sentence carries both.
 */
export function cohortRowSpoken(row: CohortFunnelRow): string {
  const signups =
    row.signups === null ? "signups not reported" : `${row.signups} signups`;
  const first =
    row.firstPurchases === null
      ? "first purchases not reported"
      : `${row.firstPurchases} first purchases${
          row.firstRatePct === null
            ? ""
            : `, ${cohortRate(row.firstRatePct)} of signups`
        }`;
  const repeat =
    row.repeatPurchases === null
      ? "repeat purchases not reported"
      : `${row.repeatPurchases} repeat purchases${
          row.repeatRatePct === null
            ? ""
            : `, ${cohortRate(row.repeatRatePct)} of first purchasers`
        }`;
  return `${row.label}: ${signups}, ${first}, ${repeat}.`;
}

/** One entry in the audience filter row. */
export interface AudienceOption {
  value: string;
  label: string;
}

/**
 * The audience chips, built from the tag catalogue.
 *
 * `= ANY(s.tags)` matches tag NAMES (contract fact 4 above), so the chip's
 * VALUE is the name and not the catalogue row's id. Blank names are dropped —
 * a chip that sends `audience_id=` is the unfiltered read wearing a filter's
 * clothes — and duplicates are collapsed, because two catalogue rows may
 * differ by group while naming the same tag.
 *
 * `Array.isArray` rather than `?? []`: a restored snapshot written by an older
 * shape can be a non-iterable object, and `.map` on it crashes the card.
 */
export function audienceOptions(
  rows: readonly { name?: string | undefined }[] | undefined,
  limit = 40,
): AudienceOption[] {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of list) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return [
    { value: ALL_SUBSCRIBERS, label: "All subscribers" },
    ...names.slice(0, Math.max(0, limit)).map((name) => ({
      value: name,
      label: name,
    })),
  ];
}
