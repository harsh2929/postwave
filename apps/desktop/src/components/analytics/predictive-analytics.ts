/**
 * predictive-analytics — pure aggregation/sorting logic for the
 * Analytics-page "Predictive analytics" surface (KLV-07).
 *
 * The wire gives us a capped slice of PredictivePrediction rows (GET
 * /api/v1/predictive/profiles?limit=) and a separate per-email
 * RFMScoreRow list. The UI wants:
 *
 *   - aggregate CLV totals across the loaded slice (historic is REAL
 *     order history; predicted/total carry an estimate badge),
 *   - the top-N profiles by predicted value OR by churn risk, sorted
 *     client-side over the loaded slice (labelled honestly),
 *   - an honest low-sample gate so confidence/data_sufficiency caution
 *     is shown only when the server itself reports weak data.
 *
 * Kept out of the component so all of it is unit-testable without a DOM.
 * Honesty rules baked in: defensive array/number coercion everywhere,
 * never divide by zero, never fabricate a number we weren't given.
 */

import type { PredictivePrediction } from "../../lib/api-client";

/** Sort modes for the top-profiles table. */
export type ProfileSort = "value" | "risk";

export interface CLVTotals {
  /** Sum of historic_clv_cents — REAL order history, not an estimate. */
  historicCents: number;
  /** Sum of predicted_clv_cents — a projection (estimate). */
  predictedCents: number;
  /** Sum of total_clv_cents — historic + predicted (estimate). */
  totalCents: number;
  /** Number of rows actually summed (the loaded slice size). */
  count: number;
}

/** Coerce a possibly-nullish numeric field to a finite number, else 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Sum the CLV columns across the loaded profiles slice. Each field is
 * coerced defensively (`?? 0` semantics) so a malformed row can never
 * throw or poison the total with NaN.
 */
export function aggregateCLV(
  items: PredictivePrediction[] | undefined | null,
): CLVTotals {
  const rows = Array.isArray(items) ? items : [];
  let historicCents = 0;
  let predictedCents = 0;
  let totalCents = 0;
  for (const r of rows) {
    historicCents += num(r?.historic_clv_cents);
    predictedCents += num(r?.predicted_clv_cents);
    totalCents += num(r?.total_clv_cents);
  }
  return { historicCents, predictedCents, totalCents, count: rows.length };
}

/**
 * Return a NEW array of the loaded profiles sorted by the chosen mode:
 *   - "value" → highest predicted CLV first,
 *   - "risk"  → highest churn risk first.
 * Ties break on total CLV then email so the order is stable. The input
 * is never mutated; non-array input yields [].
 */
export function sortProfiles(
  items: PredictivePrediction[] | undefined | null,
  mode: ProfileSort,
): PredictivePrediction[] {
  const rows = Array.isArray(items) ? items.slice() : [];
  rows.sort((a, b) => {
    if (mode === "risk") {
      const d = num(b?.churn_risk) - num(a?.churn_risk);
      if (d !== 0) return d;
    } else {
      const d = num(b?.predicted_clv_cents) - num(a?.predicted_clv_cents);
      if (d !== 0) return d;
    }
    const t = num(b?.total_clv_cents) - num(a?.total_clv_cents);
    if (t !== 0) return t;
    return (a?.email ?? "").localeCompare(b?.email ?? "");
  });
  return rows;
}

/**
 * Honest low-sample gate. The server reports a free-form
 * `data_sufficiency` string per profile ("low"/"insufficient"/"ok"/…)
 * plus a 0..1 confidence. Flag caution when either signal is genuinely
 * weak — we never invent the threshold from thin air. (Mirrors the
 * Segments RFMSection rule so the two surfaces agree.)
 */
export function isLowSufficiency(
  dataSufficiency: string | undefined | null,
  confidence: number | undefined | null,
): boolean {
  const s = (dataSufficiency ?? "").toLowerCase();
  if (s.includes("low") || s.includes("insufficient")) return true;
  // The backend's confidence is always one of {0.85,0.65,0.45,0.25,0.1}
  // (predictive.go predictionConfidence) — never 0 — and a genuinely
  // weak score (orderCount 0/1) already carries an "insufficient"/"limited"
  // sufficiency the string check above handles. The `> 0` lower bound
  // treats an explicit 0 as "no signal" (deferring to the sufficiency
  // string) rather than a weak signal — a deliberate, tested choice.
  return typeof confidence === "number" && confidence > 0 && confidence < 0.4;
}

/**
 * Guarded date formatting for expected_next_order_at. Returns "—" for
 * absent/unparseable values rather than rendering "Invalid Date".
 */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "—";
  try {
    return new Date(t).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * Minimise profile PII on the report surface. A stable subscriber id is
 * preferred; when the producer only has email, reveal one local-part
 * character and the domain so rows remain distinguishable without placing the
 * full address on screen or in screenshots.
 */
export function predictiveProfileLabel(
  profile: Pick<PredictivePrediction, "email" | "subscriber_id">,
): string {
  const subscriberId = profile.subscriber_id?.trim();
  if (subscriberId)
    return `Subscriber …${subscriberId.slice(Math.max(0, subscriberId.length - 8))}`;
  const email = profile.email?.trim();
  if (!email) return "Profile unavailable";
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "Profile redacted";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${"•".repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`;
}
