/**
 * isp-breakdown-helpers — pure formatting/sorting behind the
 * IspBreakdownCard (#41).
 *
 * The Go handler (apps/api/internal/isp_breakdown) emits rates as
 * FRACTIONS (unique events / sent, 0..1) — the UI multiplies once,
 * here, so the conversion can't drift per-column.
 */

import type { ISPBucket } from "../../lib/api-client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/** Validate the successful JSON body before sorting or formatting rows. */
export function parseIspBuckets(value: unknown): ISPBucket[] | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const countFields = [
    "subscribers",
    "sent",
    "opens",
    "clicks",
    "bounces",
    "complaints",
  ] as const;
  const rateFields = [
    "open_rate",
    "click_rate",
    "bounce_rate",
    "complaint_rate",
  ] as const;
  if (
    !value.every(
      (row) =>
        isRecord(row) &&
        typeof row.isp === "string" &&
        row.isp.length <= 8_192 &&
        row.isp.trim().length > 0 &&
        countFields.every((field) => isCount(row[field])) &&
        rateFields.every((field) => isRate(row[field])),
    )
  ) {
    return null;
  }
  return value as ISPBucket[];
}

/** 0.1234 → "12.3%". null/undefined/NaN → "—" (no fake zeros). */
export function formatRate(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Buckets sorted by send volume (desc) so the providers that matter
 * most sit on top; ties broken alphabetically for a stable render.
 * Pure — returns a new array.
 */
export function sortIspBuckets(buckets: ISPBucket[]): ISPBucket[] {
  return [...buckets].sort(
    (a, b) => b.sent - a.sent || a.isp.localeCompare(b.isp),
  );
}

/**
 * Flag rates an operator should look at: bounce ≥ 2% or complaint
 * ≥ 0.1% are the conventional ESP attention thresholds.
 */
export function ispRowSeverity(b: ISPBucket): "ok" | "warn" {
  if (b.bounce_rate >= 0.02 || b.complaint_rate >= 0.001) return "warn";
  return "ok";
}
