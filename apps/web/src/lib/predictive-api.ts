/**
 * lib/predictive-api.ts — predictive models (CLV, RFM, churn).
 *
 * WHY THIS EXISTS. Four `/api/v1/predictive/*` paths were reached by desktop
 * and by no web file.
 *
 * TWO SEPARATE QUALIFICATIONS, AND BOTH MATTER:
 *
 *   1. Per MODEL. `/catalog` reports `runtime_status` per model — `clv` and
 *      `rfm` are "supported", `churn` and `peer_benchmarks` are "partial".
 *      A partial model is not a working one, and presenting its output beside
 *      a supported model's makes them look equally trustworthy.
 *
 *   2. Per POPULATION. `/data-sufficiency` splits the audience into
 *      sufficient / limited / insufficient. A prediction over an insufficient
 *      population is a number with no evidence behind it.
 *
 * The API answers `total: 0` on a fresh workspace, so "no predictions" and
 * "predictions we cannot trust" are distinguishable — and must be
 * distinguished, because only one of them is a reason to go and collect more
 * data.
 *
 * COVERAGE: this module now wires all four predictive reads plus the separate
 * aggregate CLV dashboard:
 *   /api/v1/predictive/catalog
 *   /api/v1/predictive/data-sufficiency
 *   /api/v1/predictive/rfm/segments
 *   /api/v1/predictive/profiles
 *   /api/v1/clv-dashboard (aggregate-only; no identity previews requested)
 */
import { api } from "@/lib/api";

export interface PredictiveModel {
  key: string;
  label: string;
  /** "supported" | "partial" | ... — never present a partial model as ready. */
  runtime_status: string;
  [key: string]: unknown;
}

export interface PredictiveCatalog {
  models: PredictiveModel[];
  rfm_segments: unknown[];
  schema_version?: string;
}

export interface SufficiencyBucket {
  count: number;
  percentage: number;
}

export interface DataSufficiency {
  sufficient: SufficiencyBucket;
  limited: SufficiencyBucket;
  insufficient: SufficiencyBucket;
  total: number;
  last_updated?: string;
}

export interface RfmSegment {
  key?: string;
  label?: string;
  count?: number;
  [key: string]: unknown;
}

export interface ClvPercentiles {
  p10_cents: number;
  p25_cents: number;
  p50_cents: number;
  p75_cents: number;
  p90_cents: number;
  p99_cents: number;
}

export interface ClvTier {
  key: string;
  label: string;
  profiles: number;
  avg_total_clv_cents: number;
  avg_churn_risk: number;
}

/** Aggregate-only CLV view. Subscriber preview identities are not retained. */
export interface ClvDashboard {
  profile_count: number;
  scored_profiles: number;
  total_clv_cents: number;
  predicted_clv_cents: number;
  avg_total_clv_cents: number;
  percentiles: ClvPercentiles;
  tiers: ClvTier[];
  last_calculated_at: string | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid predictive analytics response");
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid CLV ${field}`);
  }
  return value;
}

function clvRisk(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error("Invalid CLV churn risk");
  }
  return value;
}

function clvText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 100) throw new Error(`Invalid CLV ${field}`);
  return text;
}

/**
 * Validate the aggregate as one internally-consistent snapshot. A partial or
 * malformed response becomes an error state rather than a plausible set of
 * zero-value financial metrics.
 */
export function parseClvDashboard(value: unknown): ClvDashboard {
  const raw = record(value);
  const profileCount = nonNegativeInteger(raw.profile_count, "profile_count");
  const scoredProfiles = nonNegativeInteger(
    raw.scored_profiles,
    "scored_profiles",
  );
  if (scoredProfiles > profileCount) {
    throw new Error("Invalid CLV scored profile count");
  }
  const total = nonNegativeInteger(raw.total_clv_cents, "total_clv_cents");
  const predicted = nonNegativeInteger(
    raw.predicted_clv_cents,
    "predicted_clv_cents",
  );
  if (predicted > total) throw new Error("Invalid CLV predicted total");
  const average = nonNegativeInteger(
    raw.avg_total_clv_cents,
    "avg_total_clv_cents",
  );

  const percentileRaw = record(raw.percentiles);
  const percentileValues = [
    "p10_cents",
    "p25_cents",
    "p50_cents",
    "p75_cents",
    "p90_cents",
    "p99_cents",
  ].map((field) => nonNegativeInteger(percentileRaw[field], field));
  if (
    percentileValues.some(
      (item, index) => index > 0 && item < percentileValues[index - 1]!,
    )
  ) {
    throw new Error("Invalid CLV percentile ordering");
  }
  const percentiles: ClvPercentiles = {
    p10_cents: percentileValues[0]!,
    p25_cents: percentileValues[1]!,
    p50_cents: percentileValues[2]!,
    p75_cents: percentileValues[3]!,
    p90_cents: percentileValues[4]!,
    p99_cents: percentileValues[5]!,
  };

  if (!Array.isArray(raw.tiers) || raw.tiers.length > 12) {
    throw new Error("Invalid CLV tiers");
  }
  const seen = new Set<string>();
  let tierPopulation = 0;
  const tiers = raw.tiers.map((value) => {
    const tier = record(value);
    const key = clvText(tier.key, "tier key");
    if (seen.has(key)) throw new Error("Duplicate CLV tier");
    seen.add(key);
    const profiles = nonNegativeInteger(tier.profiles, "tier profiles");
    tierPopulation += profiles;
    if (!Number.isSafeInteger(tierPopulation)) {
      throw new Error("Invalid CLV tier population");
    }
    return {
      key,
      label: clvText(tier.label, "tier label"),
      profiles,
      avg_total_clv_cents: nonNegativeInteger(
        tier.avg_total_clv_cents,
        "tier average",
      ),
      avg_churn_risk: clvRisk(tier.avg_churn_risk),
    };
  });
  if (tierPopulation !== profileCount) {
    throw new Error("Invalid CLV tier population");
  }

  let lastCalculatedAt: string | null = null;
  if (raw.last_calculated_at != null) {
    if (
      typeof raw.last_calculated_at !== "string" ||
      raw.last_calculated_at.length > 64 ||
      !Number.isFinite(Date.parse(raw.last_calculated_at))
    ) {
      throw new Error("Invalid CLV calculation timestamp");
    }
    lastCalculatedAt = raw.last_calculated_at;
  }
  const hasEvidence =
    total > 0 ||
    predicted > 0 ||
    average > 0 ||
    percentileValues.some((item) => item > 0) ||
    tiers.some((tier) => tier.profiles > 0);
  if (profileCount === 0 && (hasEvidence || lastCalculatedAt !== null)) {
    throw new Error("Invalid empty CLV snapshot");
  }

  return {
    profile_count: profileCount,
    scored_profiles: scoredProfiles,
    total_clv_cents: total,
    predicted_clv_cents: predicted,
    avg_total_clv_cents: average,
    percentiles,
    tiers,
    last_calculated_at: lastCalculatedAt,
  };
}

/**
 * Requests aggregate evidence only. `preview_limit=0` tells the API not to
 * transfer email/subscriber previews to a screen that never displays them.
 */
export async function getClvDashboard(
  signal?: AbortSignal,
): Promise<ClvDashboard> {
  const response = await api.get<unknown>(
    "/api/v1/clv-dashboard?preview_limit=0",
    { signal },
  );
  return parseClvDashboard(response);
}

const EMPTY_BUCKET: SufficiencyBucket = { count: 0, percentage: 0 };

function bucket(value: unknown): SufficiencyBucket {
  if (!value || typeof value !== "object") return EMPTY_BUCKET;
  const b = value as Partial<SufficiencyBucket>;
  return {
    count: Number.isFinite(b.count) ? Number(b.count) : 0,
    percentage: Number.isFinite(b.percentage) ? Number(b.percentage) : 0,
  };
}

export async function getPredictiveCatalog(): Promise<PredictiveCatalog> {
  const res = await api.get<PredictiveCatalog>("/api/v1/predictive/catalog");
  return {
    ...res,
    models: asArray<PredictiveModel>(res?.models),
    rfm_segments: asArray(res?.rfm_segments),
  };
}

export async function getDataSufficiency(): Promise<DataSufficiency> {
  const res = await api.get<DataSufficiency>(
    "/api/v1/predictive/data-sufficiency",
  );
  return {
    sufficient: bucket(res?.sufficient),
    limited: bucket(res?.limited),
    insufficient: bucket(res?.insufficient),
    total: Number.isFinite(res?.total) ? Number(res.total) : 0,
    last_updated: res?.last_updated,
  };
}

export async function listRfmSegments(): Promise<RfmSegment[]> {
  const res = record(await api.get<unknown>("/api/v1/predictive/rfm/segments"));
  if (!Array.isArray(res.items))
    throw new Error("Invalid RFM segment response.");
  return res.items.map((value): RfmSegment => {
    const row = record(value);
    if (
      typeof row.segment_key !== "string" ||
      !/^[a-z][a-z0-9_]{0,79}$/u.test(row.segment_key) ||
      !Number.isSafeInteger(row.profiles) ||
      (row.profiles as number) < 0
    )
      throw new Error("Invalid RFM segment response.");
    const label = row.segment_key.replace(/_/gu, " ");
    return {
      key: row.segment_key,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      count: row.profiles as number,
    };
  });
}

/** Models whose runtime_status is anything other than "supported". */
export function partialModels(
  models: readonly PredictiveModel[],
): PredictiveModel[] {
  return models.filter((m) => m.runtime_status !== "supported");
}

export interface PredictiveProfile {
  email: string;
  subscriber_id: string;
  /** All three are CENTS. */
  historic_clv_cents: number;
  predicted_clv_cents: number;
  total_clv_cents: number;
  /** 0..1. 0.5 is the model's midpoint default, not a measured coin-flip. */
  churn_risk: number;
  /** 0..1. 0.1 across the board means the model is guessing. */
  confidence: number;
  /** "insufficient" means every figure beside it is a placeholder. */
  data_sufficiency: string;
  predicted_gender: string;
  predicted_order_count: number;
  churn_drivers: string[];
}

/**
 * Per-subscriber predictions.
 *
 * EVERY FIGURE HERE IS CONDITIONAL ON `data_sufficiency`. In this workspace
 * all twelve profiles report "insufficient" with confidence 0.1 and a churn
 * risk of exactly 0.5 — the midpoint the model emits when it has nothing to
 * work from. Rendering that as "50% churn risk" turns a placeholder into a
 * finding, and the natural next action is to send win-back offers to people
 * whose risk was never actually computed.
 */
export async function listPredictiveProfiles(): Promise<PredictiveProfile[]> {
  const r = await api.get<{ items?: unknown }>("/api/v1/predictive/profiles");
  const arr = Array.isArray(r?.items) ? r.items : [];
  return arr.map((row) => {
    const p = ((row as Record<string, unknown>)?.prediction ?? {}) as Record<
      string,
      unknown
    >;
    const n = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const t = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      email: t(p.email),
      subscriber_id: t(p.subscriber_id),
      historic_clv_cents: n(p.historic_clv_cents),
      predicted_clv_cents: n(p.predicted_clv_cents),
      total_clv_cents: n(p.total_clv_cents),
      churn_risk: n(p.churn_risk),
      confidence: n(p.confidence),
      data_sufficiency: t(p.data_sufficiency),
      predicted_gender: t(p.predicted_gender),
      predicted_order_count: n(p.predicted_order_count),
      churn_drivers: Array.isArray(p.churn_drivers)
        ? (p.churn_drivers as string[])
        : [],
    };
  });
}

/** True when the profile's numbers are placeholders rather than predictions. */
export function predictionIsPlaceholder(p: PredictiveProfile): boolean {
  return p.data_sufficiency !== "" && p.data_sufficiency !== "sufficient";
}

/** How many of a set have nothing real behind them. */
export function placeholderCount(profiles: PredictiveProfile[]): number {
  return profiles.filter(predictionIsPlaceholder).length;
}
