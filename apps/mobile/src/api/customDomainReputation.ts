/**
 * api/customDomainReputation.ts — the per-domain reputation TREND behind the
 * snapshot grade the domains screen already shows.
 *
 *   GET /api/v1/sender-reputation/{domain}/history   (viewer)
 *
 * The server computes a day-grain score over the last 14 days from the same
 * subscriber-event stream as the snapshot; rates arrive as PERCENTAGES here
 * (0–100), unlike the hub's 0–1 fractions — kept as-is and named so.
 */
import { rawRequest, type AIApiError } from "./request";

import { itemsOf, numberOr, str, WireShapeError } from "@/lib/deliverabilityContracts";

class ReputationHistoryError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ReputationHistoryError";
    this.status = error.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ReputationHistoryPoint {
  day: string;
  score: number;
  sends: number;
  /** Percentages 0–100, not fractions. */
  bounceRatePct: number;
  complaintRatePct: number;
}

export async function fetchReputationHistory(
  domain: string,
): Promise<ReputationHistoryPoint[]> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/sender-reputation/${encodeURIComponent(domain)}/history`,
  );
  if (res.error) {
    throw new ReputationHistoryError(
      res.error,
      "Couldn't load the reputation history.",
    );
  }
  if (!isRecord(res.data)) throw new WireShapeError("reputation history");
  const out: ReputationHistoryPoint[] = [];
  for (const row of itemsOf(res.data.days ?? [], "reputation history")) {
    if (!isRecord(row)) continue;
    const day = str(row.day).trim();
    if (!day) continue;
    out.push({
      day,
      score: Math.max(0, Math.min(100, numberOr(row.score, 0))),
      sends: Math.max(0, numberOr(row.sends, 0)),
      bounceRatePct: Math.max(0, numberOr(row.bounce_rate, 0)),
      complaintRatePct: Math.max(0, numberOr(row.complaint_rate, 0)),
    });
  }
  return out;
}
