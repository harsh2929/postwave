// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange } from "lucide-react";

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
  getEngagementClassification,
  getFatigueDeciles,
  listCohorts,
} from "@/lib/analytics-extras-api";
import { base, STALE } from "@/lib/query-keys";

const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

export default function CohortsPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "analytics-extras",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );
  const identityReady = Boolean(meQuery.data);

  const cohorts = useQuery({
    queryKey: [...keyBase, "cohorts"],
    queryFn: listCohorts,
    staleTime: STALE.list,
    enabled: identityReady,
  });
  const fatigue = useQuery({
    queryKey: [...keyBase, "fatigue"],
    queryFn: getFatigueDeciles,
    staleTime: STALE.reference,
    enabled: identityReady,
  });
  const classification = useQuery({
    queryKey: [...keyBase, "classification"],
    queryFn: getEngagementClassification,
    staleTime: STALE.dashboard,
    enabled: identityReady,
  });

  const cohortRows = Array.isArray(cohorts.data) ? cohorts.data : [];
  const deciles = Array.isArray(fatigue.data) ? fatigue.data : [];
  const c = classification.data;

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Audience intelligence"
        title="Cohorts"
        description="Compare intake-month engagement, distinguish human activity from machine noise, and spot send fatigue before it becomes churn."
        icon={<CalendarRange aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
          <EngagementSurface
            id="ch-cohorts"
            title="Intake cohorts"
            description="Weekly engagement among subscribers who joined in the same month. Newer cohorts omit weeks they have not completed yet."
          >
            {cohorts.isPending ? (
              <EngagementLoading label="Loading intake cohorts" rows={4} />
            ) : cohorts.isError ? (
              <EngagementQueryError
                title="Cohorts could not be loaded"
                description="Existing cohort history is unavailable; no zero-engagement conclusion has been drawn."
                retrying={cohorts.isFetching}
                onRetry={() => void cohorts.refetch()}
              />
            ) : cohortRows.length === 0 ? (
              <EngagementEmpty
                title="No intake cohorts yet"
                description="Cohorts appear after subscribers join and complete enough time for a weekly engagement window."
              />
            ) : (
              <ul
                className="divide-y rounded-lg border"
                aria-label="Intake cohort engagement"
              >
                {cohortRows.map((cohort) => (
                  <li
                    key={cohort.cohort_label}
                    className="space-y-3 p-3 sm:p-4"
                  >
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <span className="font-medium">{cohort.cohort_label}</span>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {cohort.cohort_size.toLocaleString()} joined
                      </span>
                    </div>
                    {cohort.weeks.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No completed weeks to measure yet.
                      </p>
                    ) : (
                      <ol className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                        {cohort.weeks.map((rate, index) => (
                          <li
                            key={index}
                            className="rounded-md bg-muted/50 px-2 py-1.5 text-center"
                            aria-label={`Week ${index + 1}: ${percent.format(rate)} engaged`}
                          >
                            <span className="block text-[10px] uppercase text-muted-foreground">
                              W{index + 1}
                            </span>
                            <span className="text-xs font-medium tabular-nums">
                              {percent.format(rate)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </EngagementSurface>

          <EngagementSurface
            id="ch-class"
            title="Engagement quality"
            description="Interaction events are classified independently from recipient counts on other screens."
          >
            {classification.isPending ? (
              <EngagementLoading label="Loading engagement classification" />
            ) : classification.isError ? (
              <EngagementQueryError
                title="Classification could not be loaded"
                description="Human, machine, and unknown activity are unavailable; none of those bands is being inferred."
                retrying={classification.isFetching}
                onRetry={() => void classification.refetch()}
              />
            ) : c ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <EngagementMetric
                    label="Total"
                    value={c.total.toLocaleString()}
                  />
                  <EngagementMetric
                    label="Human"
                    value={c.human.toLocaleString()}
                    tone="positive"
                  />
                  <EngagementMetric
                    label="Machine"
                    value={c.machine.toLocaleString()}
                  />
                  <EngagementMetric
                    label="Unknown"
                    value={c.unknown.toLocaleString()}
                    tone={c.unknown > 0 ? "warning" : "default"}
                  />
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  Counted in {c.unit.replace(/_/gu, " ") || "unspecified units"}
                  .
                  {c.classifier_version
                    ? ` Classifier ${c.classifier_version}.`
                    : ""}
                </p>
                {c.methodology ? (
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {c.methodology}
                  </p>
                ) : null}
              </>
            ) : (
              <EngagementEmpty
                title="No classification summary"
                description="The API completed without a classification payload. Retry before using engagement quality for a decision."
              />
            )}
          </EngagementSurface>
        </div>

        <EngagementSurface
          id="ch-fatigue"
          title="Send fatigue"
          description="Equal-population buckets compare open and unsubscribe rates by how many messages subscribers received."
        >
          {fatigue.isPending ? (
            <EngagementLoading label="Loading send fatigue" rows={4} />
          ) : fatigue.isError ? (
            <EngagementQueryError
              title="Send fatigue could not be loaded"
              description="The exposure curve is unavailable; a missing response is not treated as healthy engagement."
              retrying={fatigue.isFetching}
              onRetry={() => void fatigue.refetch()}
            />
          ) : deciles.length === 0 ? (
            <EngagementEmpty
              title="Not enough sending history"
              description="Fatigue buckets appear after subscribers have enough sent-message exposure to compare."
            />
          ) : (
            <ul
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              aria-label="Send fatigue buckets"
            >
              {deciles.map((decile, decileIndex) => (
                <li
                  // Tied send counts can give several deciles the same
                  // display bucket. The API's ordered decile rank is the row
                  // identity, so it remains unique when labels repeat.
                  key={`fatigue-decile-${decileIndex + 1}`}
                  className="rounded-lg border bg-background/60 p-4"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">
                      {decile.sends_bucket}{" "}
                      {decile.sends_bucket === "1" ? "send" : "sends"}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {decile.subscribers.toLocaleString()}{" "}
                      {decile.subscribers === 1 ? "subscriber" : "subscribers"}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Open rate
                      </dt>
                      <dd className="font-medium tabular-nums">
                        {percent.format(decile.open_rate)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Unsubscribe
                      </dt>
                      <dd className="font-medium tabular-nums">
                        {percent.format(decile.unsub_rate)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </EngagementSurface>
      </EngagementIdentityGate>
    </PageShell>
  );
}
