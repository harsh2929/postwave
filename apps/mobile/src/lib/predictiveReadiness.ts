/**
 * lib/predictiveReadiness.ts — how much of the predictive model you may
 * actually believe, plus the RFM shape of the customer base.
 *
 * DASHBOARD#31. The Customer value card already carries the model's OUTPUT
 * (median value, the at-risk churn band). What it could not carry is the
 * model's COVERAGE, and model output without provenance is the one thing that
 * should never travel to a phone: a median customer value computed over 4% of
 * the list looks exactly like one computed over 96% of it.
 *
 * TWO ENDPOINTS, BOTH `read:reports` ONLY:
 *   GET /api/v1/predictive/data-sufficiency  (predictive.go:126)
 *   GET /api/v1/predictive/rfm/segments      (predictive.go:125)
 *
 * That is a deliberately WIDER gate than the CLV dashboard next to them, which
 * needs `read:reports AND read:subscribers` (predictive.go:127) because its
 * payload carries email addresses. Neither of these is recipient-linked — one
 * is three bucket counts, the other is a group-by — so a report-scoped session
 * that cannot open the value card can still read both of these. `read:reports`
 * is read-only, so `requireAdminRoleForScopes`
 * (apps/api/internal/apikeys/middleware.go:342) returns false and every signed-in
 * role may read them.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. `GetDataSufficiency`
 * (predictive/repo.go:344) answers a tenant that has NEVER been recomputed with
 * a ZEROED report and HTTP 200 — not a 404, not an error. So
 * `{total: 0, sufficient: {count: 0, percentage: 0}}` means "nothing has been
 * computed", and rendering it as "0% of profiles are ready" states a measured
 * finding where there is no measurement at all. `parseDataSufficiency` returns
 * `null` for that case, and every count it does return is `number | null`.
 *
 * Pure and import-free (house rule 6).
 */

export interface SufficiencyBucket {
  count: number;
  /** Server-computed share of `total`, 0..100. */
  percentage: number;
}

export interface DataSufficiency {
  insufficient: SufficiencyBucket;
  limited: SufficiencyBucket;
  sufficient: SufficiencyBucket;
  total: number;
  /** When the rollup was last written. Null when the server omitted it. */
  lastUpdated: string | null;
}

export interface RfmSegment {
  key: string;
  label: string;
  profiles: number;
  /** Mean monetary value in CENTS, or null when unreported. */
  avgMonetaryCents: number | null;
  /** Share of the scored population, 0..1. */
  share: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function ratio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
}

function bucket(value: unknown): SufficiencyBucket {
  const parsed = record(value);
  return {
    count: count(parsed?.count) ?? 0,
    percentage: ratio(parsed?.percentage),
  };
}

/**
 * `null` for both "not a sufficiency document" AND "no recompute has ever run"
 * — see the module header. The caller renders one sentence for both, because
 * they are the same fact from the reader's side: there is nothing to believe
 * yet.
 */
export function parseDataSufficiency(payload: unknown): DataSufficiency | null {
  const body = record(payload);
  if (!body) return null;
  const total = count(body.total);
  if (total == null || total <= 0) return null;
  const lastUpdated =
    typeof body.last_updated === "string" && body.last_updated.trim()
      ? body.last_updated.trim()
      : null;
  return {
    insufficient: bucket(body.insufficient),
    limited: bucket(body.limited),
    sufficient: bucket(body.sufficient),
    total,
    lastUpdated,
  };
}

/**
 * `rfmSegmentCatalog()` in apps/api/internal/predictive/predictive.go:558.
 * Kept as a lookup rather than a required union so a key this build has never
 * seen is still rendered — with its underscores stripped — instead of dropped.
 */
const RFM_LABELS: Record<string, string> = {
  champions: "Champions",
  loyal_customers: "Loyal customers",
  at_risk_high_value: "At-risk high value",
  needs_attention: "Needs attention",
  new_or_low_value: "New or low value",
  hibernating: "Hibernating",
  insufficient_data: "Insufficient data",
};

export function rfmSegmentLabel(key: string): string {
  return RFM_LABELS[key] ?? key.replace(/_/g, " ").trim();
}

/**
 * The server already sorts by descending count
 * (predictive/repo.go:427), and that order is preserved: it is the order the
 * question "what does my customer base look like" is answered in.
 */
export function parseRfmSegments(payload: unknown): readonly RfmSegment[] {
  const body = record(payload);
  const items = Array.isArray(body?.items) ? body.items : [];
  const parsed = items.flatMap((entry) => {
    const row = record(entry);
    const key =
      typeof row?.segment_key === "string" && row.segment_key.trim()
        ? row.segment_key.trim()
        : null;
    const profiles = count(row?.profiles);
    if (!key || profiles == null) return [];
    return [{ key, profiles, avgMonetaryCents: count(row?.avg_monetary_cents) }];
  });
  const total = parsed.reduce((sum, row) => sum + row.profiles, 0);
  return parsed.map((row) => ({
    key: row.key,
    label: rfmSegmentLabel(row.key),
    profiles: row.profiles,
    avgMonetaryCents: row.avgMonetaryCents,
    // Share of the SCORED population, which is what the bars compare. Zero
    // when nothing is scored, so a bar never divides by zero.
    share: total > 0 ? row.profiles / total : 0,
  }));
}

/**
 * The one sentence that decides whether the numbers above are worth reading.
 *
 * `sufficient` alone is the honest headline: `limited` is explicitly the band
 * the model scores WITHOUT enough history to be confident, so folding it in
 * would inflate the claim.
 */
export function sufficiencyHeadline(report: DataSufficiency | null): {
  headline: string;
  detail: string;
  tone: "ok" | "attention" | "neutral";
} {
  if (!report) {
    return {
      headline: "No prediction snapshot yet",
      detail:
        "The predictive model has not been run for this workspace, so there is no coverage to report — which is not the same as reporting zero coverage.",
      tone: "neutral",
    };
  }
  const pct = Math.round(report.sufficient.percentage);
  const detail = `${report.sufficient.count} of ${report.total} profiles have enough order and engagement history to score confidently. ${report.limited.count} are scored with limited history and ${report.insufficient.count} cannot be scored at all.`;
  if (pct >= 50) {
    return {
      headline: `${pct}% of profiles are confidently scored`,
      detail,
      tone: "ok",
    };
  }
  return {
    headline: `Only ${pct}% of profiles are confidently scored`,
    detail,
    tone: "attention",
  };
}
