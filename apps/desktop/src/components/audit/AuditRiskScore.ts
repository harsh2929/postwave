/**
 * AuditRiskScore — tiny heuristic that flags suspicious audit rows.
 * Refined Audit PR 3.
 *
 * The score is intentionally rule-based (not ML) so an auditor can
 * read the source and verify "yes, that is what triggered this
 * badge". Each rule contributes a small weight; the sum lands in
 * one of three buckets:
 *
 *   low   — 0    → no badge
 *   med   — 1..2 → amber "Watch" pill
 *   high  — 3+   → red "Risk" pill with the dominant reason in the
 *                  tooltip
 *
 * Rules (PR 3):
 *   +2  Destructive action (delete / purge / drop / revoke / rotate)
 *   +2  Bulk export (>5k rows) — metadata.row_count > 5000
 *   +1  IP outside the tenant's most common /16 (heuristic stand-in
 *       for "new country" since we don't have geoip on the client)
 *   +1  Off-hours (outside 06:00–22:00 local time)
 *   +1  Failed auth (login + metadata.success === false)
 *
 * The heuristic is a frontend convenience — it never gates writes.
 * The audit row is still recorded normally; the badge is a triage
 * hint for the auditor reading the page.
 */

import {
  api,
  type AnomalyScoreResponse,
  type AuditRow,
} from "../../lib/api-client";

import { classifyAction } from "./AuditSeverity";

export type RiskBucket = "low" | "med" | "high";

export interface RiskAssessment {
  bucket: RiskBucket;
  score: number;
  reasons: string[];
  /** ueba-baselines (AI/Anomaly, P1): set when this assessment was
   *  hydrated from the server-side UEBA worker rather than the
   *  client-side rule fallback. Surfaces "UEBA" badge in the row. */
  source?: "client" | "ueba";
  /** ueba-baselines: MITRE ATT&CK technique IDs the server flagged for
   *  this row. Empty for client-side assessments. */
  mitre?: string[];
}

interface RiskContext {
  /** Most-common /16 prefix across the visible row set, used as the
   *  "expected network" baseline. Passed in from the page so each
   *  row doesn't recompute. */
  commonIpPrefix16?: string;
}

function ipPrefix16(ip?: string): string | undefined {
  if (!ip) return undefined;
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  return `${parts[0]}.${parts[1]}`;
}

function rowHourLocal(at: string): number {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 12;
  return d.getHours();
}

export function assessRisk(row: AuditRow, ctx: RiskContext = {}): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];

  // Destructive verb.
  if (classifyAction(row.action) === "destructive") {
    score += 2;
    reasons.push("destructive action");
  }

  // Large export.
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const rowCount = typeof meta.row_count === "number" ? meta.row_count : 0;
  if (rowCount > 5000) {
    score += 2;
    reasons.push(`exported ${rowCount.toLocaleString()} rows`);
  }

  // Network mismatch — only counts when we have a baseline to
  // compare against (single-row review otherwise would over-fire).
  const pfx = ipPrefix16(row.ip);
  if (ctx.commonIpPrefix16 && pfx && pfx !== ctx.commonIpPrefix16) {
    score += 1;
    reasons.push(`unfamiliar network ${pfx}.*.*`);
  }

  // Off-hours.
  const h = rowHourLocal(row.at);
  if (h < 6 || h >= 22) {
    score += 1;
    reasons.push(`off-hours (${h}:00 local)`);
  }

  // Failed auth.
  if (
    classifyAction(row.action) === "auth" &&
    (meta.success === false || meta.failed === true)
  ) {
    score += 1;
    reasons.push("failed authentication");
  }

  let bucket: RiskBucket = "low";
  if (score >= 3) bucket = "high";
  else if (score >= 1) bucket = "med";

  return { bucket, score, reasons };
}

/**
 * ueba-baselines (AI/Anomaly, P1): fetch the server-computed UEBA
 * anomaly score for a single audit row. Replaces the
 * client-rule-only assessRisk for the slideover / risk badge once
 * the page is showing the row's details.
 *
 * Falls back to the client-side rule assessment when:
 *   - the server returns {available:false} (no UEBA row yet)
 *   - the request fails entirely (offline / 503)
 *
 * The fallback path preserves the existing behaviour for cold-start
 * tenants whose UEBA worker hasn't produced a score yet.
 */
export async function fetchAnomalyScore(
  row: AuditRow,
  ctx: RiskContext = {},
): Promise<RiskAssessment> {
  const res = await api.getAuditAnomalyScore(Number(row.id));
  if (res.error || !res.data || !res.data.available) {
    return assessRisk(row, ctx);
  }
  const payload: AnomalyScoreResponse = res.data;
  return {
    bucket: payload.bucket,
    score: Math.round(payload.score),
    reasons: payload.reasons.map(
      (r) =>
        `${r.type.replace(/_/g, " ")}: ${r.reason} (conf ${Math.round(
          r.confidence * 100,
        )}%)`,
    ),
    source: "ueba",
    mitre: payload.mitreTechniques ?? [],
  };
}

/**
 * Tiny in-process cache so AuditRowItem renders don't fan out one
 * request per row. Cache is keyed by audit id; entries expire after
 * the page reload. We deliberately don't persist to localStorage —
 * UEBA scores can shift between baseline recomputes and stale data
 * here would mislead an auditor.
 */
const anomalyCache = new Map<string | number, RiskAssessment>();

export async function fetchAnomalyScoreCached(
  row: AuditRow,
  ctx: RiskContext = {},
): Promise<RiskAssessment> {
  const cached = anomalyCache.get(row.id);
  if (cached) return cached;
  const ass = await fetchAnomalyScore(row, ctx);
  anomalyCache.set(row.id, ass);
  return ass;
}

/** Find the most common /16 prefix across a row set. Used by the
 *  page to pass a single baseline into every assessRisk call. */
export function commonIpPrefix(rows: AuditRow[]): string | undefined {
  const counts: Record<string, number> = {};
  let bestPrefix: string | undefined;
  let bestCount = 0;
  for (const r of rows) {
    const pfx = ipPrefix16(r.ip);
    if (!pfx) continue;
    counts[pfx] = (counts[pfx] ?? 0) + 1;
    if (counts[pfx] > bestCount) {
      bestCount = counts[pfx];
      bestPrefix = pfx;
    }
  }
  return bestPrefix;
}
