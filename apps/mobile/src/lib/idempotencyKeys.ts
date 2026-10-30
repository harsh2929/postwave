/**
 * lib/idempotencyKeys.ts — "did that request run twice?", as a phone answers it.
 *
 * ── WHY THIS IS ON A PHONE AT ALL ──────────────────────────────────────────
 * The idempotency inspector (`internal/idempotency/inspector.go`) is five admin
 * routes with no client on any surface. The server even hands clients an
 * `operator_replay_url` that nothing follows.
 *
 * The audience is somebody diagnosing a duplicate — "the customer says they got
 * charged twice", "the webhook fired twice" — and that question arrives by
 * message, at any hour, away from a desk. It is answered by READING, which is
 * the shape a phone is good at.
 *
 * ── READ-ONLY, AND THE DELETE IS DELIBERATELY ABSENT ───────────────────────
 * `DELETE /api/v1/idempotency/keys/{key}` exists and does NOT ship here, and
 * this is the one place in this programme where the stopping-half rule points
 * the other way.
 *
 * Revoking a credential removes authority — safe when wrong. Deleting an
 * idempotency key removes a DEDUPLICATION GUARANTEE: the next retry of that
 * request executes for real instead of replaying its stored response. That is
 * the direction that CAUSES the duplicate the operator came here to
 * investigate. A destructive act whose failure mode is the exact problem being
 * diagnosed does not belong on a phone.
 *
 * No react-native imports — imported by node-run vitest.
 */
import { num, relativeTime } from "./format";

export interface IdempotencyStatsLike {
  total: number;
  pending: number;
  completed: number;
  expired: number;
}

export interface IdempotencyKeyLike {
  key: string;
  route: string;
  state: string;
  responseStatus?: number | undefined;
  createdAt: string;
  completedAt?: string | undefined;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function toIdempotencyStats(raw: unknown): IdempotencyStatsLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    total: int(r.total),
    pending: int(r.pending),
    completed: int(r.completed),
    expired: int(r.expired),
  };
}

export function toIdempotencyKey(raw: unknown): IdempotencyKeyLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" ? r.key : "";
  if (!key) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    key,
    route: str(r.route),
    // A missing state is NOT "completed". An unknown state is unknown, and
    // rendering it as finished is the one claim this screen must never make.
    state: str(r.state) || "unknown",
    ...(typeof r.response_status === "number"
      ? { responseStatus: r.response_status }
      : {}),
    createdAt: str(r.created_at),
    ...(str(r.completed_at) ? { completedAt: str(r.completed_at) } : {}),
  };
}

/**
 * The headline.
 *
 * PENDING IS THE NUMBER THAT MATTERS, and it leads even when it is zero. A
 * pending key is a request that started and never recorded a result — which is
 * both the cause of a duplicate (a retry cannot replay what was never stored)
 * and the symptom of a hung handler. `total` alone answers nothing.
 */
export function idempotencySummary(stats: IdempotencyStatsLike): string {
  if (stats.pending === 0) {
    return `No requests are mid-flight. ${num(stats.completed)} completed, ${num(stats.expired)} expired.`;
  }
  return `${num(stats.pending)} request${stats.pending === 1 ? "" : "s"} started and never recorded a result. ${num(stats.completed)} completed.`;
}

/** Anything mid-flight wants attention; a clean ledger does not. */
export function idempotencyTone(
  stats: IdempotencyStatsLike,
): "warning" | "success" {
  return stats.pending > 0 ? "warning" : "success";
}

/**
 * One key, as a line.
 *
 * The KEY ITSELF IS NOT SHOWN. It is a client-chosen string that frequently
 * embeds an order id, a customer reference or an email — the exact identifiers
 * this screen has no reason to put on a lock screen or in a screenshot. The
 * route and the timing are what diagnose a duplicate; the key is what you paste
 * into a desk tool afterwards.
 */
export function idempotencyKeyLine(
  row: IdempotencyKeyLike,
  now: number = Date.now(),
): string {
  const started = row.createdAt
    ? `started ${relativeTime(row.createdAt, { now, fallback: "recently" })}`
    : "start time unknown";
  if (row.state === "pending") {
    return `${row.route || "unknown route"} — ${started}, still no result.`;
  }
  const outcome = row.responseStatus
    ? `answered ${row.responseStatus}`
    : row.state;
  return `${row.route || "unknown route"} — ${outcome}, ${started}.`;
}

/** Mid-flight requests first: they are the only ones anybody is looking for. */
export function sortIdempotencyKeys<T extends IdempotencyKeyLike>(
  rows: readonly T[],
): T[] {
  const list = Array.isArray(rows) ? rows : [];
  return [...list].sort((a, b) => {
    const aPending = a.state === "pending" ? 0 : 1;
    const bPending = b.state === "pending" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    const at = (v: string): number => {
      const n = new Date(v).getTime();
      return Number.isFinite(n) ? n : 0;
    };
    return at(b.createdAt) - at(a.createdAt);
  });
}
