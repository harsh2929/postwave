/**
 * lib/clvSummary.ts — the two numbers worth carrying out of the CLV dashboard.
 *
 * Handler: apps/api/internal/predictive/predictive.go:127
 * `r.With(readProfiles).Get("/api/v1/clv-dashboard", d.CLVDashboard)`, where
 * `readProfiles = RequireAllScopes(read:reports, read:subscribers)`. Both are
 * read-only scopes, so `requireAdminRoleForScopes` (apikeys/middleware.go:342)
 * returns false and any signed-in role may read it; an API-KEY session missing
 * either scope gets a 403 `insufficient_scope`, which the card renders as an
 * error rather than as an empty workspace.
 *
 * WHAT IS DELIBERATELY LEFT ON THE DESKTOP. The payload also carries
 * `top_profiles` and `at_risk_profiles` — arrays of EMAIL ADDRESSES with a
 * churn score attached. That is a named list of the workspace's most valuable
 * customers, and it is exactly the kind of thing that should not be one tap
 * from a phone's lock screen when the phone-appropriate question is a single
 * pair of figures. This module never reads those arrays, so they cannot be
 * rendered by accident, cannot be written into the offline snapshot vault, and
 * cannot end up in a screenshot.
 *
 * MONEY IS IN CENTS everywhere in this payload (`*_cents` suffixes on every
 * field). Callers must divide before formatting; `clvMajorUnits` exists so no
 * screen has to remember.
 *
 * Pure and import-free (house rule 6).
 */

/** The phone-sized read of `GET /api/v1/clv-dashboard`. */
export interface ClvSummary {
  /** Profiles in the current prediction snapshot. Null when unreported. */
  profileCount: number | null;
  /** Of those, the ones with enough order history to be worth trusting. */
  scoredProfiles: number | null;
  /** Median TOTAL (historic + predicted) value, in cents. */
  medianTotalCents: number | null;
  /** 90th-percentile total value, in cents — the top-decile customer. */
  p90TotalCents: number | null;
  /** Profiles the server banded `at_risk` (churn risk ≥ 0.6 with value). */
  atRiskProfiles: number | null;
  /** Mean total value inside the at-risk band, in cents. */
  atRiskAvgCents: number | null;
  /** When the snapshot was last recomputed; null when never. */
  lastCalculatedAt: string | null;
}

/** The band key the server assigns to high-churn-risk, non-zero-value rows. */
export const AT_RISK_TIER_KEY = "at_risk";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

function whole(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

export function parseClvSummary(raw: unknown): ClvSummary {
  const envelope = record(raw);
  const percentiles = envelope ? record(envelope.percentiles) : null;
  const tiers = envelope && Array.isArray(envelope.tiers) ? envelope.tiers : [];
  let atRiskProfiles: number | null = null;
  let atRiskAvgCents: number | null = null;
  for (const entry of tiers) {
    const tier = record(entry);
    if (!tier || tier.key !== AT_RISK_TIER_KEY) continue;
    atRiskProfiles = whole(tier.profiles);
    atRiskAvgCents = cents(tier.avg_total_clv_cents);
  }
  return {
    profileCount: envelope ? whole(envelope.profile_count) : null,
    scoredProfiles: envelope ? whole(envelope.scored_profiles) : null,
    medianTotalCents: percentiles ? cents(percentiles.p50_cents) : null,
    p90TotalCents: percentiles ? cents(percentiles.p90_cents) : null,
    atRiskProfiles,
    atRiskAvgCents,
    lastCalculatedAt:
      envelope && typeof envelope.last_calculated_at === "string"
        ? envelope.last_calculated_at
        : null,
  };
}

/** Cents → major units, or null. Never guesses a currency: the payload has none. */
export function clvMajorUnits(value: number | null): number | null {
  return value === null ? null : value / 100;
}

/**
 * Why the card must not print a value, or null when it may.
 *
 * TWO DIFFERENT SILENCES, and conflating them is the failure this prevents.
 * `profile_count === 0` means the predictive model has never run for this
 * workspace — the table is empty, and there is nothing to say. A snapshot that
 * exists but whose median is zero means the model ran and found no order
 * history to value, which is a fact about the workspace's commerce data rather
 * than about the model.
 */
export function clvUnavailableReason(summary: ClvSummary): string | null {
  if (summary.profileCount === null) {
    return "This workspace has not reported a customer-value snapshot.";
  }
  if (summary.profileCount === 0) {
    return "No customer-value predictions have been computed for this workspace yet.";
  }
  if (summary.medianTotalCents === null) {
    return "The value distribution was not reported for this snapshot.";
  }
  if (summary.medianTotalCents === 0 && (summary.p90TotalCents ?? 0) === 0) {
    return "Customer values are all zero in this snapshot. Predicted value is derived from paid commerce orders, so it stays at zero until orders are matched to subscribers.";
  }
  return null;
}

/**
 * The confidence caption. It states the SCORED share rather than the raw
 * profile count, because a median computed over a snapshot where four in five
 * rows have too little history to score is a number the reader should discount.
 */
export function clvConfidenceLine(summary: ClvSummary): string | null {
  const { profileCount, scoredProfiles } = summary;
  if (profileCount === null || profileCount <= 0) return null;
  if (scoredProfiles === null) return null;
  if (scoredProfiles >= profileCount) {
    return `Across ${profileCount} scored profiles.`;
  }
  const share = Math.round((scoredProfiles / profileCount) * 100);
  return `Across ${profileCount} profiles; ${scoredProfiles} (${share}%) have enough order history to score confidently.`;
}
