// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BrainCircuit } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementMetric,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "@/app/(dashboard)/app/_engagement/engagement-ui";
import { whoami } from "@/lib/auth-api";
import {
  getDataSufficiency,
  getClvDashboard,
  getPredictiveCatalog,
  listPredictiveProfiles,
  listRfmSegments,
  partialModels,
  placeholderCount,
  predictionIsPlaceholder,
} from "@/lib/predictive-api";
import { base, STALE } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export default function PredictivePage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "predictive",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );
  const identityReady = Boolean(meQuery.data);

  const catalog = useQuery({
    queryKey: [...keyBase, "catalog"],
    queryFn: getPredictiveCatalog,
    staleTime: STALE.reference,
    enabled: identityReady,
  });
  const sufficiency = useQuery({
    queryKey: [...keyBase, "sufficiency"],
    queryFn: getDataSufficiency,
    staleTime: STALE.dashboard,
    enabled: identityReady,
  });
  const rfm = useQuery({
    queryKey: [...keyBase, "rfm"],
    queryFn: listRfmSegments,
    staleTime: STALE.list,
    enabled: identityReady,
  });
  const profiles = useQuery({
    queryKey: [...keyBase, "profiles"],
    queryFn: listPredictiveProfiles,
    staleTime: STALE.list,
    enabled: identityReady,
  });
  const clv = useQuery({
    queryKey: [...keyBase, "clv-dashboard", "aggregate-only"],
    queryFn: ({ signal }) => getClvDashboard(signal),
    staleTime: STALE.dashboard,
    enabled: identityReady,
  });

  const models = Array.isArray(catalog.data?.models) ? catalog.data.models : [];
  const partial = partialModels(models);
  const sufficiencyReport = sufficiency.data;
  const rfmRows = Array.isArray(rfm.data) ? rfm.data : [];
  const profileRows = Array.isArray(profiles.data) ? profiles.data : [];
  const placeholders = placeholderCount(profileRows);

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Decision support"
        title="Predictive"
        description="Separate model readiness from data sufficiency before using lifetime value, RFM, or churn scores to target subscribers."
        icon={<BrainCircuit aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="pr-suff"
            title="Data sufficiency"
            description="Population-level evidence coverage. This is actionable by collecting more purchase and engagement history."
          >
            {sufficiency.isPending ? (
              <EngagementLoading label="Loading predictive data sufficiency" />
            ) : sufficiency.isError ? (
              <EngagementQueryError
                title="Data sufficiency could not be loaded"
                description="Prediction coverage is unknown; the audience is not being treated as fully scored or fully insufficient."
                retrying={sufficiency.isFetching}
                onRetry={() => void sufficiency.refetch()}
              />
            ) : sufficiencyReport?.total === 0 ? (
              <EngagementEmpty
                title="Nobody has been scored yet"
                description="Profiles appear after there is purchase or engagement history to model. Zero here is an unmeasured population, not 100% insufficiency."
              />
            ) : sufficiencyReport ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <EngagementMetric
                  label="Sufficient"
                  value={sufficiencyReport.sufficient.count.toLocaleString()}
                  hint={`${sufficiencyReport.sufficient.percentage.toLocaleString()}% of scored profiles`}
                  tone="positive"
                />
                <EngagementMetric
                  label="Limited"
                  value={sufficiencyReport.limited.count.toLocaleString()}
                  hint={`${sufficiencyReport.limited.percentage.toLocaleString()}% of scored profiles`}
                  tone="warning"
                />
                <EngagementMetric
                  label="Insufficient"
                  value={sufficiencyReport.insufficient.count.toLocaleString()}
                  hint={`${sufficiencyReport.insufficient.percentage.toLocaleString()}% of scored profiles`}
                  tone="danger"
                />
              </div>
            ) : null}
          </EngagementSurface>

          <EngagementSurface
            id="pr-models"
            title="Model readiness"
            description="Build-level status. Collecting more tenant data does not turn a partial model into a supported one."
          >
            {catalog.isPending ? (
              <EngagementLoading label="Loading predictive model catalog" />
            ) : catalog.isError ? (
              <EngagementQueryError
                title="Model catalog could not be loaded"
                description="No model is being represented as supported while its runtime status is unavailable."
                retrying={catalog.isFetching}
                onRetry={() => void catalog.refetch()}
              />
            ) : models.length === 0 ? (
              <EngagementEmpty
                title="No predictive models advertised"
                description="This build returned no model catalog; predictions should not be treated as available."
              />
            ) : (
              <>
                {partial.length > 0 ? (
                  <p className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-relaxed text-warning-emphasis">
                    {partial.length} of {models.length} models are not fully
                    supported in this build. Their output remains qualified
                    regardless of tenant data volume.
                  </p>
                ) : null}
                <ul className="divide-y rounded-lg border">
                  {models.map((model) => (
                    <li
                      key={model.key}
                      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">
                          {model.label}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {model.key.replace(/_/gu, " ")}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "w-fit shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium capitalize",
                          model.runtime_status === "supported"
                            ? "border-success/30 bg-success/10 text-success-emphasis"
                            : "border-warning/30 bg-warning/10 text-warning-emphasis",
                        )}
                      >
                        {model.runtime_status.replace(/_/gu, " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </EngagementSurface>
        </div>

        <EngagementSurface
          id="pr-clv"
          title="Predicted customer value"
          description="A tenant-wide aggregate snapshot. Currency and churn figures are model projections, not observed revenue or guaranteed outcomes."
        >
          {clv.isPending ? (
            <EngagementLoading
              label="Loading customer-value distribution"
              rows={4}
            />
          ) : clv.isError ? (
            <EngagementQueryError
              title="Customer-value distribution could not be verified"
              description="No financial projection is being inferred from per-subscriber rows. Retry to load the server-computed aggregate snapshot."
              retrying={clv.isFetching}
              onRetry={() => void clv.refetch()}
            />
          ) : !clv.data || clv.data.profile_count === 0 ? (
            <EngagementEmpty
              title="No customer-value snapshot yet"
              description="A snapshot appears after order history is ingested and predictive scoring has run."
            />
          ) : clv.data.scored_profiles === 0 ? (
            <EngagementEmpty
              title="Not enough evidence to estimate customer value"
              description={`${clv.data.profile_count.toLocaleString()} profiles have no sufficient or limited scoring evidence. Value tiers, currency projections, and churn defaults are withheld until usable history is available.`}
            />
          ) : (
            <ClvDashboardSnapshot data={clv.data} />
          )}
        </EngagementSurface>

        <EngagementSurface
          id="pr-rfm"
          title="RFM segments"
          description="Subscriber groups derived from recency, frequency, and monetary history."
        >
          {rfm.isPending ? (
            <EngagementLoading label="Loading RFM segments" rows={4} />
          ) : rfm.isError ? (
            <EngagementQueryError
              title="RFM segments could not be loaded"
              description="The segment request failed; no empty-segment conclusion has been drawn."
              retrying={rfm.isFetching}
              onRetry={() => void rfm.refetch()}
            />
          ) : rfmRows.length === 0 ? (
            <EngagementEmpty
              title="No RFM segments yet"
              description="Segments appear after scoring has enough commerce history to derive recency, frequency, and value."
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rfmRows.map((segment, index) => (
                <li
                  key={segment.key ?? index}
                  className="rounded-lg border bg-background/60 p-4"
                >
                  <p className="font-medium">
                    {segment.label || segment.key || "Unnamed segment"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                    {typeof segment.count === "number"
                      ? `${segment.count.toLocaleString()} subscribers`
                      : "Population not reported"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </EngagementSurface>

        <EngagementSurface
          id="pd-profiles"
          title="Per-subscriber predictions"
          description="Only sufficient profiles expose modeled risk and lifetime value; placeholders are labelled instead of rendered as findings."
        >
          {profiles.isPending ? (
            <EngagementLoading label="Loading predictive profiles" rows={5} />
          ) : profiles.isError ? (
            <EngagementQueryError
              title="Predictive profiles could not be loaded"
              description="Per-subscriber scores are unavailable and should not be used for targeting until a retry succeeds."
              retrying={profiles.isFetching}
              onRetry={() => void profiles.refetch()}
            />
          ) : profileRows.length === 0 ? (
            <EngagementEmpty
              title="No subscribers have been scored"
              description="Profiles will appear after predictive scoring runs against eligible history."
            />
          ) : (
            <>
              {placeholders > 0 ? (
                <p className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-relaxed text-warning-emphasis">
                  {placeholders === profileRows.length
                    ? `All ${profileRows.length} profiles have insufficient evidence. Their midpoint defaults are withheld.`
                    : `${placeholders} of ${profileRows.length} profiles have insufficient evidence and are labelled without default scores.`}
                </p>
              ) : null}
              <ul className="divide-y rounded-lg border">
                {profileRows.slice(0, 25).map((profile, index) => {
                  const placeholder = predictionIsPlaceholder(profile);
                  return (
                    <li
                      key={`${profile.subscriber_id || profile.email || "profile"}-${index}`}
                      className="p-3 sm:p-4"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <div className="min-w-0">
                          <p className="break-all text-sm font-medium">
                            {profile.email || profile.subscriber_id}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {placeholder
                              ? "Not enough data to predict"
                              : `${Math.round(profile.churn_risk * 100)}% churn risk · ${Math.round(profile.confidence * 100)}% confidence`}
                          </p>
                        </div>
                        {placeholder ? (
                          <span className="w-fit shrink-0 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning-emphasis">
                            Insufficient data
                          </span>
                        ) : (
                          <div className="shrink-0 text-left sm:text-right">
                            <p className="text-sm font-medium tabular-nums">
                              {currency.format(profile.total_clv_cents / 100)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Lifetime value
                            </p>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {profileRows.length > 25 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Showing the first 25 of {profileRows.length.toLocaleString()}{" "}
                  profiles.
                </p>
              ) : null}
            </>
          )}
        </EngagementSurface>
      </EngagementIdentityGate>
    </PageShell>
  );
}

function ClvDashboardSnapshot({
  data,
}: {
  data: Awaited<ReturnType<typeof getClvDashboard>>;
}) {
  const coverage =
    data.profile_count > 0
      ? Math.round((data.scored_profiles / data.profile_count) * 100)
      : 0;
  const percentiles = [
    ["P10", data.percentiles.p10_cents],
    ["P25", data.percentiles.p25_cents],
    ["Median", data.percentiles.p50_cents],
    ["P75", data.percentiles.p75_cents],
    ["P90", data.percentiles.p90_cents],
    ["P99", data.percentiles.p99_cents],
  ] as const;
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <EngagementMetric
          label="Profiles"
          value={data.profile_count.toLocaleString()}
          hint={`${coverage}% have sufficient or limited evidence`}
        />
        <EngagementMetric
          label="Scored"
          value={data.scored_profiles.toLocaleString()}
          hint="Insufficient profiles excluded"
          tone={coverage >= 70 ? "positive" : "warning"}
        />
        <EngagementMetric
          label="Modeled total"
          value={currency.format(data.total_clv_cents / 100)}
          hint="Projection across all profiles"
        />
        <EngagementMetric
          label="Predicted portion"
          value={currency.format(data.predicted_clv_cents / 100)}
          hint="Future-value component"
        />
        <EngagementMetric
          label="Average total"
          value={currency.format(data.avg_total_clv_cents / 100)}
          hint="Projected per profile"
        />
      </dl>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section
          aria-labelledby="pr-clv-percentiles"
          className="rounded-lg border p-3"
        >
          <h3 id="pr-clv-percentiles" className="text-sm font-medium">
            Value distribution
          </h3>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {percentiles.map(([label, cents]) => (
              <div key={label} className="rounded-md bg-muted/30 p-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">
                  {currency.format(cents / 100)}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          aria-labelledby="pr-clv-tiers"
          className="rounded-lg border p-3"
        >
          <h3 id="pr-clv-tiers" className="text-sm font-medium">
            Value tiers
          </h3>
          <ul className="mt-2 divide-y">
            {data.tiers.map((tier) => (
              <li
                key={tier.key}
                className="grid gap-1 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4"
              >
                <span className="font-medium">{tier.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {tier.profiles.toLocaleString()} profiles
                </span>
                <span className="tabular-nums text-muted-foreground sm:text-right">
                  {currency.format(tier.avg_total_clv_cents / 100)} avg ·{" "}
                  {Math.round(tier.avg_churn_risk * 100)}% projected churn
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {data.last_calculated_at ? (
        <p className="text-xs text-muted-foreground">
          Snapshot calculated{" "}
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(data.last_calculated_at))}
          . Aggregate-only request; subscriber preview identities were not
          transferred.
        </p>
      ) : null}
    </div>
  );
}
