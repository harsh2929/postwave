/**
 * The predictive projection that rides the subscriber DETAIL GET and that
 * mobile was discarding at its type boundary (AUDIENCE#28).
 *
 * Four independent facts arrive on `GET /api/v1/subscribers/{id}` and none of
 * them needed a second request:
 *
 *   - `prediction`             — apps/api/internal/subscribers/types.go:215,
 *                                a narrowed projection of profile_predictions:
 *                                historic / predicted / total CLV in CENTS,
 *                                churn_risk and confidence in [0,1], a
 *                                data_sufficiency band, and the SUB-060 ranked
 *                                churn_drivers.
 *   - `prediction_confidence`  — types.go:206, the SUB-010 model-lineage
 *   - `prediction_model_version` scalars from subscriber_prediction_metadata.
 *   - `expected_next_order_at` — types.go:225 (SUB-061 replenishment cadence)
 *   - `order_cadence_metrics`  — types.go:231 (SUB-062, average days between
 *                                orders + last_computed_at)
 *
 * Every field above is `omitempty` on the Go side, which is the whole reason
 * this module exists: ABSENCE IS NOT ZERO. A subscriber the predictive worker
 * has never scored must render nothing at all — not "£0.00 lifetime value" and
 * not "0% churn risk", both of which are confident statements about a model run
 * that never happened.
 *
 * Import-free by construction so the rules can be unit-tested in the node
 * vitest environment (house rule 6).
 */

/** The three CLV figures, already converted out of cents. */
export interface PredictionValue {
  /** Realised lifetime value to date, in MAJOR units. */
  historic: number;
  /** Modelled forward lifetime value, in MAJOR units. */
  predicted: number;
  /** historic + predicted — the headline figure, in MAJOR units. */
  total: number;
}

export interface ChurnDriver {
  key: string;
  label: string;
  value: string;
  /** Coarse salience band the API already computed. */
  impact: "high" | "medium" | "low" | "unknown";
}

export type SufficiencyBand = "insufficient" | "limited" | "sufficient";

export interface NormalizedPrediction {
  value: PredictionValue | null;
  /** Churn probability in [0,1]. Null when the field was absent/not finite. */
  churnRisk: number | null;
  /** Model confidence in [0,1]. Null when absent. */
  confidence: number | null;
  sufficiency: SufficiencyBand | null;
  drivers: ChurnDriver[];
  calculatedAt: string | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Cents → major units.
 *
 * All three CLV figures are `int` cents on the wire. Dividing here rather than
 * at the render site means a future caller cannot forget and print a 100×
 * lifetime value.
 */
export function centsToMajor(value: unknown): number | null {
  const n = finite(value);
  return n === null ? null : n / 100;
}

function normalizeImpact(value: unknown): ChurnDriver["impact"] {
  const s = str(value)?.toLowerCase();
  return s === "high" || s === "medium" || s === "low" ? s : "unknown";
}

export function normalizeChurnDrivers(value: unknown): ChurnDriver[] {
  if (!Array.isArray(value)) return [];
  const out: ChurnDriver[] = [];
  for (const raw of value) {
    const row = record(raw);
    if (!row) continue;
    const label = str(row.label);
    // A driver with no human label cannot be rendered honestly — the `key` is
    // a machine token ("recency_days"), not copy.
    if (!label) continue;
    out.push({
      key: str(row.key) ?? label,
      label,
      value: str(row.value) ?? "",
      impact: normalizeImpact(row.impact),
    });
  }
  return out;
}

function normalizeSufficiency(value: unknown): SufficiencyBand | null {
  const s = str(value)?.toLowerCase();
  return s === "insufficient" || s === "limited" || s === "sufficient"
    ? s
    : null;
}

/**
 * Project the wire object onto something renderable, or null when the
 * predictive worker has not scored this address.
 *
 * Returns null — rather than a zeroed object — for a missing `prediction`, so
 * the card can be omitted entirely. The three CLV figures are treated as ONE
 * fact: the API writes them together from a single model row, so a payload
 * missing any of them is a payload whose money figures cannot be trusted, and
 * `value` goes null while churn/confidence survive.
 */
export function normalizePrediction(raw: unknown): NormalizedPrediction | null {
  const row = record(raw);
  if (!row) return null;
  const historic = centsToMajor(row.historic_clv_cents);
  const predicted = centsToMajor(row.predicted_clv_cents);
  const total = centsToMajor(row.total_clv_cents);
  const churnRisk = finite(row.churn_risk);
  const confidence = finite(row.confidence);
  const sufficiency = normalizeSufficiency(row.data_sufficiency);
  const drivers = normalizeChurnDrivers(row.churn_drivers);
  const calculatedAt = str(row.calculated_at);
  const value =
    historic !== null && predicted !== null && total !== null
      ? { historic, predicted, total }
      : null;
  // Nothing survived — an empty object on the wire is indistinguishable from
  // no model run, and rendering an empty card for it is noise.
  if (
    value === null &&
    churnRisk === null &&
    confidence === null &&
    sufficiency === null &&
    drivers.length === 0
  ) {
    return null;
  }
  return { value, churnRisk, confidence, sufficiency, drivers, calculatedAt };
}

export interface ChurnBand {
  key: "low" | "elevated" | "high";
  /** Rendered beside the meter — state is never colour-alone (house rule 4). */
  label: string;
  tone: "success" | "warning" | "danger";
}

/**
 * Bands mirror the desktop RFMProfileCard's thresholds so the same person is
 * not "At risk" on one surface and "Healthy" on the other.
 */
export function churnBand(risk: number | null): ChurnBand | null {
  if (risk === null) return null;
  if (risk >= 0.66) return { key: "high", label: "High risk", tone: "danger" };
  if (risk >= 0.33) {
    return { key: "elevated", label: "Elevated risk", tone: "warning" };
  }
  return { key: "low", label: "Low risk", tone: "success" };
}

/**
 * The caveat that must ride ALONGSIDE any number derived from a thin model
 * run. `sufficient` earns no caveat; everything else — including an
 * unrecognised band — does, because a churn percentage computed from two
 * orders looks exactly like one computed from two hundred.
 */
export function sufficiencyNote(band: SufficiencyBand | null): string | null {
  if (band === "sufficient") return null;
  if (band === "limited") {
    return "Limited history — treat these figures as directional.";
  }
  if (band === "insufficient") {
    return "Not enough history to model this contact reliably.";
  }
  return null;
}

/** Whether the band is weak enough that the figures should read as estimates. */
export function isThinEvidence(band: SufficiencyBand | null): boolean {
  return band === "insufficient" || band === "limited";
}

export interface NextOrderProjection {
  /** ISO instant the projection points at. */
  at: string;
  /** Whole days from `now` — negative when the window has already passed. */
  days: number;
  overdue: boolean;
}

/**
 * `expected_next_order_at` relative to now, in whole days.
 *
 * Whole days, not hours: the projection is `last_order_at +
 * average_days_between_orders`, a day-resolution estimate, and rendering it to
 * the hour would imply a precision the model does not have.
 */
export function nextOrderProjection(
  value: unknown,
  now: number = Date.now(),
): NextOrderProjection | null {
  const iso = str(value);
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const days = Math.round((at - now) / 86_400_000);
  return { at: iso, days, overdue: days < 0 };
}

export interface OrderCadence {
  averageDays: number;
  lastComputedAt: string | null;
}

export function normalizeOrderCadence(raw: unknown): OrderCadence | null {
  const row = record(raw);
  if (!row) return null;
  const averageDays = finite(row.average_days_between_orders);
  // A zero-day cadence is not a cadence; it is an unpopulated trait.
  if (averageDays === null || averageDays <= 0) return null;
  return { averageDays, lastComputedAt: str(row.last_computed_at) };
}

/**
 * The replenishment sentence, assembled here rather than in JSX so the
 * singular/plural and the overdue wording are unit-testable and the card stays
 * inside its complexity budget.
 */
export function nextOrderSentence(
  projection: NextOrderProjection,
  formatDate: (iso: string) => string,
): string {
  const when = formatDate(projection.at);
  const magnitude = Math.abs(projection.days);
  const unit = magnitude === 1 ? "day" : "days";
  if (projection.overdue) {
    return `Next order was expected ${magnitude} ${unit} ago — ${when}`;
  }
  if (projection.days === 0) return `Next order expected today — ${when}`;
  return `Next order expected in ${projection.days} ${unit} — ${when}`;
}

export function cadenceSentence(
  cadence: OrderCadence,
  formatDate: (iso: string) => string,
): string {
  const every = Math.round(cadence.averageDays);
  const base = `Orders roughly every ${every} ${every === 1 ? "day" : "days"}`;
  return cadence.lastComputedAt
    ? `${base} · measured ${formatDate(cadence.lastComputedAt)}`
    : base;
}

/**
 * The one spoken sentence for the card, so a screen-reader user gets the
 * verdict without walking a grid of compacted currency tiles.
 *
 * Deliberately assembled from the parts that are PRESENT: an em-dash tile is
 * absent from the sentence rather than spoken as "no value", which would make
 * a partially-scored profile read as a list of failures.
 */
export function predictionSpokenSummary(
  prediction: NormalizedPrediction,
  formatMoney: (major: number) => string,
): string {
  const parts: string[] = [];
  if (prediction.value) {
    parts.push(
      `Total predicted lifetime value ${formatMoney(prediction.value.total)}`,
      `of which ${formatMoney(prediction.value.historic)} realised so far`,
    );
  }
  const band = churnBand(prediction.churnRisk);
  if (band && prediction.churnRisk !== null) {
    parts.push(
      `${band.label}, ${Math.round(prediction.churnRisk * 100)} percent churn probability`,
    );
  }
  if (prediction.confidence !== null) {
    parts.push(
      `model confidence ${Math.round(prediction.confidence * 100)} percent`,
    );
  }
  const note = sufficiencyNote(prediction.sufficiency);
  if (note) parts.push(note);
  return parts.length > 0 ? `${parts.join(". ")}.` : "No prediction available.";
}
