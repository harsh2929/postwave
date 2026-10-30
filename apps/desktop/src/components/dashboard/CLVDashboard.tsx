/**
 * Aggregated predicted customer-value evidence for the Dashboard.
 *
 * The API returns one snapshot that is normalized into a bounded,
 * identity-free view model before it reaches React state. Values remain
 * explicitly described as projections; preview rows use display-rank aliases
 * and never expose email addresses or subscriber identifiers in DOM,
 * accessibility text, screenshots, or serialized markup. A 404 still means
 * the feature is unavailable on this deployment rather than an empty customer
 * dataset.
 */

import { type ReactElement, type ReactNode, useRef } from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { type CLVDistribution, predictiveApi } from "../../lib/api-client";
import { fmtDate, fmtRelative } from "../../lib/format-date";
import { SectionHeader } from "../SectionHeader";
import { fmtCents, fmtPct01 } from "../segments/rfm-helpers";

import "./DashboardEvidenceSurfaces.css";

const PREVIEW_LIMIT = 5;
const TIER_LIMIT = 8;

interface CLVTierEvidence {
  key: string;
  label: string;
  profiles: number;
  avg_total_clv_cents: number;
  avg_churn_risk: number;
}

interface CLVProfileEvidence {
  key: string;
  alias: string;
  total_clv_cents: number;
  churn_risk: number;
}

interface CLVSnapshot {
  profile_count: number;
  scored_profiles: number;
  total_clv_cents: number;
  predicted_clv_cents: number;
  avg_total_clv_cents: number;
  percentiles: CLVDistribution["percentiles"];
  tiers: CLVTierEvidence[];
  top_profiles: CLVProfileEvidence[];
  at_risk_profiles: CLVProfileEvidence[];
  last_calculated_at: string | null;
}

type CLVDashboardResource =
  | { kind: "unavailable" }
  | { kind: "snapshot"; value: CLVSnapshot | null };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function count(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}

function money(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}

function risk(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function tierCategory(value: unknown): string {
  if (typeof value !== "string") return "standard";
  const key = value.trim().toLowerCase();
  return ["champions", "high_value", "at_risk"].includes(key)
    ? key
    : "standard";
}

function tierDisplayLabel(category: string, index: number): string {
  if (category === "champions") return "Champions";
  if (category === "high_value") return "High value";
  if (category === "at_risk") return "At risk";
  return `Value tier ${index + 1}`;
}

function normalizeTier(value: unknown, index: number): CLVTierEvidence | null {
  if (!value || typeof value !== "object") return null;
  const tier = value as CLVDistribution["tiers"][number];
  if (
    !count(tier.profiles) ||
    !money(tier.avg_total_clv_cents) ||
    !risk(tier.avg_churn_risk)
  ) {
    return null;
  }
  const category = tierCategory(tier.key);
  return {
    key: `tier-${index + 1}-${category}`,
    label: tierDisplayLabel(category, index),
    profiles: tier.profiles,
    avg_total_clv_cents: tier.avg_total_clv_cents,
    avg_churn_risk: tier.avg_churn_risk,
  };
}

function normalizeProfile(
  value: unknown,
  index: number,
  group: "top" | "risk",
): CLVProfileEvidence | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as CLVDistribution["top_profiles"][number];
  if (!money(profile.total_clv_cents) || !risk(profile.churn_risk)) return null;
  const rank = String(index + 1).padStart(2, "0");
  const alias = group === "top" ? `Profile A${rank}` : `At-risk B${rank}`;
  return {
    // Keys and aliases are rank-only. They contain no hash, prefix, or other
    // material derived from email/subscriber_id and are stable for this
    // normalized display order only.
    key: `${group}-profile-${rank}`,
    alias,
    total_clv_cents: profile.total_clv_cents,
    churn_risk: profile.churn_risk,
  };
}

function normalizeProfiles(
  value: unknown,
  group: "top" | "risk",
): CLVProfileEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: CLVProfileEvidence[] = [];
  for (const [index, profile] of value.slice(0, PREVIEW_LIMIT).entries()) {
    const next = normalizeProfile(profile, index, group);
    if (!next) return null;
    normalized.push(next);
  }
  return normalized;
}

function normalizeTiers(value: unknown): CLVTierEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: CLVTierEvidence[] = [];
  for (const [index, tier] of value.slice(0, TIER_LIMIT).entries()) {
    const next = normalizeTier(tier, index);
    if (!next) return null;
    normalized.push(next);
  }
  return normalized;
}

function normalizeTimestamp(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value)
  ) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function normalizeCLVDistribution(value: unknown): CLVSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CLVDistribution>;
  const percentiles = candidate.percentiles;
  if (
    !count(candidate.profile_count) ||
    !count(candidate.scored_profiles) ||
    candidate.scored_profiles > candidate.profile_count ||
    !money(candidate.total_clv_cents) ||
    !money(candidate.predicted_clv_cents) ||
    !money(candidate.avg_total_clv_cents) ||
    !percentiles ||
    !money(percentiles.p10_cents) ||
    !money(percentiles.p25_cents) ||
    !money(percentiles.p50_cents) ||
    !money(percentiles.p75_cents) ||
    !money(percentiles.p90_cents) ||
    !money(percentiles.p99_cents)
  ) {
    return null;
  }
  const orderedPercentiles = [
    percentiles.p10_cents,
    percentiles.p25_cents,
    percentiles.p50_cents,
    percentiles.p75_cents,
    percentiles.p90_cents,
    percentiles.p99_cents,
  ];
  if (
    orderedPercentiles.some(
      (item, index) => index > 0 && item < orderedPercentiles[index - 1]!,
    )
  ) {
    return null;
  }
  const tiers = normalizeTiers(candidate.tiers);
  const topProfiles = normalizeProfiles(candidate.top_profiles, "top");
  const atRiskProfiles = normalizeProfiles(candidate.at_risk_profiles, "risk");
  const lastCalculatedAt = normalizeTimestamp(candidate.last_calculated_at);
  if (
    !tiers ||
    !topProfiles ||
    !atRiskProfiles ||
    lastCalculatedAt === undefined ||
    (Array.isArray(candidate.tiers) && candidate.tiers.length > TIER_LIMIT)
  ) {
    return null;
  }
  let tierProfileCount = 0;
  for (const tier of tiers) {
    tierProfileCount += tier.profiles;
    if (!Number.isSafeInteger(tierProfileCount)) return null;
  }
  const hasDistributionEvidence =
    candidate.total_clv_cents > 0 ||
    candidate.predicted_clv_cents > 0 ||
    candidate.avg_total_clv_cents > 0 ||
    orderedPercentiles.some((item) => item > 0) ||
    tiers.length > 0 ||
    topProfiles.length > 0 ||
    atRiskProfiles.length > 0;
  if (
    candidate.predicted_clv_cents > candidate.total_clv_cents ||
    tierProfileCount !== candidate.profile_count ||
    (Array.isArray(candidate.top_profiles) &&
      candidate.top_profiles.length > candidate.profile_count) ||
    (Array.isArray(candidate.at_risk_profiles) &&
      candidate.at_risk_profiles.length > candidate.profile_count) ||
    (candidate.profile_count === 0 &&
      (hasDistributionEvidence || lastCalculatedAt !== null))
  ) {
    return null;
  }
  return {
    profile_count: candidate.profile_count,
    scored_profiles: candidate.scored_profiles,
    total_clv_cents: candidate.total_clv_cents,
    predicted_clv_cents: candidate.predicted_clv_cents,
    avg_total_clv_cents: candidate.avg_total_clv_cents,
    percentiles,
    tiers,
    top_profiles: topProfiles,
    at_risk_profiles: atRiskProfiles,
    last_calculated_at: lastCalculatedAt,
  };
}

function tierBadgeClass(key: string): string {
  if (key.endsWith("-champions") || key.endsWith("-high_value")) {
    return "badge success pw-clv-tier-badge";
  }
  if (key.endsWith("-at_risk")) return "badge danger pw-clv-tier-badge";
  return "badge pw-clv-tier-badge";
}

function churnRiskClass(value: number): string {
  if (value >= 0.6) return "pw-clv-risk pw-clv-risk-danger";
  if (value >= 0.3) return "pw-clv-risk pw-clv-risk-warning";
  return "pw-clv-risk pw-clv-risk-success";
}

function recomputeLabel(timestamp: string): string {
  const absolute = fmtDate(timestamp);
  const relative = fmtRelative(timestamp);

  return absolute === relative ? absolute : `${absolute} (${relative})`;
}

function ProjectionBadge(): ReactElement {
  return (
    <span
      className="badge pw-dashboard-evidence-estimate"
      aria-label="Projection: calculated from current data, not an observed fact"
    >
      Projection
    </span>
  );
}

function CLVMetric({
  label,
  value,
  note,
  projected = false,
}: {
  label: string;
  value: ReactNode;
  note: string;
  projected?: boolean;
}): ReactElement {
  return (
    <div className="pw-clv-metric">
      <dt className="pw-clv-metric-label">
        <span>{label}</span>
        {projected ? <ProjectionBadge /> : null}
      </dt>
      <dd className="pw-clv-metric-value tabular">{value}</dd>
      <dd className="pw-clv-metric-note">{note}</dd>
    </div>
  );
}

function ProfilePreviewList({
  title,
  profiles,
  emptyNote,
}: {
  title: string;
  profiles: CLVProfileEvidence[];
  emptyNote: string;
}): ReactElement {
  return (
    <section className="pw-clv-card pw-clv-profile-card" aria-label={title}>
      <header className="pw-clv-subsection-header">
        <h4>{title}</h4>
        <span>Identity-protected preview · up to {PREVIEW_LIMIT}</span>
      </header>
      {profiles.length === 0 ? (
        <p className="pw-clv-subsection-empty">{emptyNote}</p>
      ) : (
        <ul className="pw-clv-profile-list">
          {profiles.map((profile) => (
            <li key={profile.key} className="pw-clv-profile">
              <div className="pw-clv-profile-identity">
                <span className="pw-clv-profile-alias">{profile.alias}</span>
                <span className="badge pw-clv-profile-segment">
                  Identity hidden
                </span>
              </div>
              <dl className="pw-clv-profile-facts">
                <div>
                  <dt>Projected total CLV</dt>
                  <dd className="tabular">
                    {fmtCents(profile.total_clv_cents)}
                  </dd>
                </div>
                <div>
                  <dt>Projected churn risk</dt>
                  <dd
                    className={`${churnRiskClass(profile.churn_risk)} tabular`}
                  >
                    {fmtPct01(profile.churn_risk)}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CLVEmptyState(): ReactElement {
  return (
    <div className="pw-clv-state pw-clv-empty" role="status">
      <div className="pw-clv-state-kicker">Projection not available yet</div>
      <h4>No predicted customer-value snapshot</h4>
      <p>
        Scores require subscriber order history. Once order data is available,
        run a recompute from the Segments page&apos;s RFM &amp; predictive
        section.
      </p>
    </div>
  );
}

function CLVLoadingState(): ReactElement {
  return (
    <div
      className="pw-clv-state pw-clv-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading predicted customer value</span>
      <div className="skel pw-clv-loading-heading" aria-hidden="true" />
      <div className="pw-clv-loading-metrics" aria-hidden="true">
        <div className="pw-clv-loading-placeholder" />
        <div className="pw-clv-loading-placeholder" />
        <div className="pw-clv-loading-placeholder" />
        <div className="pw-clv-loading-placeholder" />
      </div>
      <div
        className="pw-clv-loading-placeholder pw-clv-loading-chart"
        aria-hidden="true"
      />
    </div>
  );
}

export function CLVDashboard(): ReactElement | null {
  const refreshFlightRef = useRef<Promise<void> | null>(null);
  const resource = useRemoteResource<CLVDashboardResource>(
    async () => {
      const response = await predictiveApi.clvDashboard({
        previewLimit: PREVIEW_LIMIT,
      });
      if (response.error) {
        return response.error.status === 404
          ? { data: { kind: "unavailable" } as const }
          : { error: response.error };
      }
      if (response.data == null) {
        return { data: { kind: "snapshot", value: null } as const };
      }
      const snapshot = normalizeCLVDistribution(response.data);
      return snapshot
        ? { data: { kind: "snapshot", value: snapshot } as const }
        : { error: { kind: "parse" as const } };
    },
    { identity: "clv-dashboard" },
  );
  const loading = resource.transport === "loading";
  const denied = resource.access === "denied";

  const refresh = (): void => {
    if (refreshFlightRef.current) return;
    const request = resource.reload();
    refreshFlightRef.current = request;
    void request.finally(() => {
      if (refreshFlightRef.current === request) refreshFlightRef.current = null;
    });
  };

  if (resource.data?.kind === "unavailable") return null;
  const data = resource.data?.kind === "snapshot" ? resource.data.value : null;
  const retainedVerifiedEmpty =
    resource.stale &&
    resource.data?.kind === "snapshot" &&
    resource.data.value === null;

  return (
    <section className="pw-clv-dashboard" aria-label="Predicted customer value">
      <SectionHeader
        title="Predicted customer value"
        description="Customer-value distribution across available profile predictions, with data-sufficiency coverage called out."
        helpText="CLV and churn figures are heuristic projections computed from order history, not observed facts. Tier and preview evidence can include profiles below the sufficiency threshold. Run a recompute from the Segments page after order data has been ingested."
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={refresh}
            disabled={loading}
            aria-busy={loading || undefined}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {resource.failure ? (
        <div className="notice pw-clv-notice" role="alert">
          <div className="pw-clv-notice-copy">
            <strong>
              {denied
                ? "CLV projection unavailable for this role"
                : "CLV projection could not be verified"}
            </strong>
            <p>
              {resource.failure.message}
              {resource.stale && data
                ? " The last verified projection remains visible below."
                : ""}
              {retainedVerifiedEmpty
                ? " The last verified response contained no CLV projection, so there is no prior projection to display."
                : ""}
            </p>
          </div>
          {!denied ? (
            <button
              type="button"
              className="btn btn-sm pw-clv-notice-action"
              disabled={loading}
              aria-busy={loading || undefined}
              onClick={refresh}
            >
              {loading ? "Retrying…" : "Retry CLV dashboard"}
            </button>
          ) : null}
        </div>
      ) : null}

      {loading && data ? (
        <div className="pw-clv-refresh-status" role="status" aria-live="polite">
          Refreshing the projection; showing the last verified snapshot until
          the request completes.
        </div>
      ) : null}

      {loading && !data ? (
        <CLVLoadingState />
      ) : !data && !resource.failure ? (
        <CLVEmptyState />
      ) : data ? (
        <CLVSnapshotContent data={data} />
      ) : null}
    </section>
  );
}

function CLVSnapshotContent({ data }: { data: CLVSnapshot }): ReactElement {
  if (data.profile_count === 0) return <CLVEmptyState />;

  const partial = data.scored_profiles < data.profile_count;
  const percentiles = data.percentiles;
  const flatDistribution = percentiles.p99_cents === percentiles.p10_cents;
  const meterMin = flatDistribution
    ? Math.max(0, percentiles.p10_cents - 1)
    : percentiles.p10_cents;
  const meterMax = flatDistribution
    ? Math.max(1, percentiles.p99_cents)
    : percentiles.p99_cents;
  const medianValue = Math.min(
    meterMax,
    Math.max(meterMin, percentiles.p50_cents),
  );
  const percentileRows = [
    ["p10 · 10th percentile", percentiles.p10_cents],
    ["p50 median", percentiles.p50_cents],
    ["p90 · 90th percentile", percentiles.p90_cents],
    ["p99 · 99th percentile", percentiles.p99_cents],
  ] as const;

  return (
    <div className="pw-clv-snapshot">
      {partial ? (
        <div className="pw-clv-partial" role="status">
          <strong>
            {data.scored_profiles === 0
              ? "No profiles meet the data-sufficiency threshold."
              : "Data-sufficiency coverage is partial."}
          </strong>{" "}
          {data.scored_profiles.toLocaleString()} of{" "}
          {data.profile_count.toLocaleString()} profiles meet the current
          sufficiency threshold. Distribution, tier, and preview projections can
          include profiles below that threshold; treat those estimates with
          additional caution.
        </div>
      ) : null}

      <dl className="pw-clv-metrics" aria-label="Customer value summary">
        <CLVMetric
          label="Sufficient profiles"
          value={data.scored_profiles.toLocaleString()}
          note={`of ${data.profile_count.toLocaleString()} projected profiles`}
        />
        <CLVMetric
          label="Predicted CLV"
          value={fmtCents(data.predicted_clv_cents)}
          note="future projected value"
          projected
        />
        <CLVMetric
          label="Total CLV"
          value={fmtCents(data.total_clv_cents)}
          note="historic plus projected value"
          projected
        />
        <CLVMetric
          label="Average CLV"
          value={fmtCents(data.avg_total_clv_cents)}
          note="per projected profile"
          projected
        />
      </dl>

      <figure className="pw-clv-card pw-clv-range">
        <figcaption className="pw-clv-card-heading">
          <span>Total CLV distribution</span>
          <ProjectionBadge />
        </figcaption>
        <p className="pw-clv-card-description">
          The meter locates the median within the 10th-to-99th-percentile range.
        </p>
        <meter
          className="pw-clv-range-meter"
          min={meterMin}
          max={meterMax}
          value={medianValue}
          aria-label={`Median projected customer value: ${fmtCents(percentiles.p50_cents)}`}
        >
          {fmtCents(percentiles.p50_cents)}
        </meter>
        <dl className="pw-clv-percentiles">
          {percentileRows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="tabular">{fmtCents(value)}</dd>
            </div>
          ))}
        </dl>
      </figure>

      <section className="pw-clv-card pw-clv-tiers" aria-label="Value tiers">
        <header className="pw-clv-subsection-header">
          <h4>Value tiers</h4>
          <span>
            Counts, average projected CLV, and average churn risk across the
            full prediction snapshot
          </span>
        </header>
        {data.tiers.length === 0 ? (
          <p className="pw-clv-subsection-empty">
            This snapshot did not include a value-tier breakdown.
          </p>
        ) : (
          <ul className="pw-clv-tier-list">
            {data.tiers.map((tier) => (
              <li key={tier.key} className="pw-clv-tier">
                <span className={tierBadgeClass(tier.key)}>{tier.label}</span>
                <strong className="pw-clv-tier-count tabular">
                  {tier.profiles.toLocaleString()}
                  <span> profiles</span>
                </strong>
                <dl className="pw-clv-tier-facts">
                  <div>
                    <dt>Average projected CLV</dt>
                    <dd className="tabular">
                      {fmtCents(tier.avg_total_clv_cents)}
                    </dd>
                  </div>
                  <div>
                    <dt>Average churn risk</dt>
                    <dd
                      className={`${churnRiskClass(tier.avg_churn_risk)} tabular`}
                    >
                      {fmtPct01(tier.avg_churn_risk)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="pw-clv-profile-grid">
        <ProfilePreviewList
          title="Top value profiles"
          profiles={data.top_profiles}
          emptyNote="No profiles were included in this preview."
        />
        <ProfilePreviewList
          title="At-risk high-value profiles"
          profiles={data.at_risk_profiles}
          emptyNote="No high-value profiles are currently identified as at risk."
        />
      </div>

      <footer className="pw-clv-recomputed" role="note">
        {data.last_calculated_at ? (
          <>
            Last recomputed{" "}
            <time dateTime={data.last_calculated_at}>
              {recomputeLabel(data.last_calculated_at)}
            </time>
          </>
        ) : (
          "The snapshot did not include a recompute timestamp."
        )}
      </footer>
    </div>
  );
}
