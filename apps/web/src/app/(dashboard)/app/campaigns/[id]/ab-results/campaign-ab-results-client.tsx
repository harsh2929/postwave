// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import type { Route } from "next";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { getABResults, type ABMetric } from "@/lib/ab-results-api";
import { getCampaign } from "@/lib/campaigns-api";
import { whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { comparisonLabel } from "./ab-results-helpers";

function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  const v = p > 1 ? p : p * 100;
  return `${v.toFixed(1)}%`;
}

export function CampaignABResultsClient() {
  const params = useParams<{ id: string }>();
  const campaignID = params.id;

  const [metric, setMetric] = useState<ABMetric>("open_rate");

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const campaignKey = useMemo(
    () => qk.campaign(tenantId, role, campaignID),
    [campaignID, role, tenantId],
  );
  const resultsKey = useMemo(
    () => [...campaignKey, "ab-results", metric] as const,
    [campaignKey, metric],
  );
  const resultsQuery = useQuery({
    queryKey: resultsKey,
    queryFn: () => getABResults(campaignID, metric),
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
    // Keep the prior report on screen while the new metric loads instead of
    // blanking the whole page to a loading card (CAMP-029).
    placeholderData: keepPreviousData,
  });
  const campaignQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(campaignID),
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
  });
  // A failed campaign lookup must not read as a campaign with no name: label
  // the crumb as a failed request rather than silently dropping it.
  const campaignName = campaignQuery.isError
    ? "Campaign (name failed to load)"
    : campaignQuery.data?.name;

  const data = resultsQuery.data ?? null;
  const loading = meQuery.isLoading || (resultsQuery.isPending && !data);
  const refetching = resultsQuery.isFetching && !resultsQuery.isPending;
  const error =
    resultsQuery.error instanceof Error
      ? resultsQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : resultsQuery.isError
          ? "Could not load A/B results — this is a failed request, not a test without data."
          : null;

  const metricLabel =
    metric === "open_rate"
      ? "Open rate"
      : metric === "click_rate"
        ? "Click rate"
        : "Reply rate";

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">
      <Breadcrumb
        className="mb-3"
        items={[
          { label: "Campaigns", href: asRoute("/app/campaigns") },
          ...(campaignName
            ? [
                {
                  label: campaignName,
                  href: asRoute(`/app/campaigns/${campaignID}`) as Route,
                },
              ]
            : []),
          { label: "A/B results" },
        ]}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="Back to campaign"
          title="Back to campaign"
        >
          <Link href={`/app/campaigns/${campaignID}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            A/B results
          </h1>
          {campaignName ? (
            <p className="break-words text-sm text-muted-foreground">
              {campaignName}
            </p>
          ) : null}
        </div>
        <a
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline"
          href="https://docs.postwave.dev/ab-tests/methodology"
          target="_blank"
          rel="noopener noreferrer"
        >
          Why these stats?
        </a>
      </div>

      <div className="mb-4 flex gap-2">
        <Select
          className="w-40"
          aria-label="Metric"
          value={metric}
          onChange={(e) => setMetric(e.target.value as ABMetric)}
        >
          <option value="open_rate">Open rate</option>
          <option value="click_rate">Click rate</option>
          <option value="reply_rate">Reply rate</option>
        </Select>
      </div>

      {error ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6 text-destructive">
            <span>{error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void meQuery.refetch();
                void resultsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {loading ? (
        <Card>
          <CardContent className="py-6 text-muted-foreground">
            Loading…
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <div
          className={
            refetching ? "opacity-60 transition-opacity" : "transition-opacity"
          }
        >
          {data.winner ? (
            <Card
              className={
                data.winner.method === "not_decided"
                  ? "mb-4"
                  : "mb-4 border-success/30 bg-success/5"
              }
            >
              <CardContent className="py-4">
                {data.winner.method === "not_decided" ? (
                  <p>
                    <strong>No clear winner yet.</strong> Keep the test running
                    or widen the recipient pool. We mark a winner once the
                    challenger crosses 95% confidence.
                  </p>
                ) : (
                  <p>
                    <strong>
                      {data.variants[data.winner.variant_index]
                        ?.variant_label ??
                        `Variant ${data.winner.variant_index + 1}`}{" "}
                      won
                    </strong>{" "}
                    <span className="text-muted-foreground">
                      ({(data.winner.confidence * 100).toFixed(1)}% confident
                      via {data.winner.method})
                    </span>
                  </p>
                )}
              </CardContent>
            </Card>
          ) : null}

          <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            {data.variants.map((v) => (
              <Card
                key={v.id ?? v.variant_index}
                className={
                  data.winner?.variant_index === v.variant_index
                    ? "border-success/30 bg-success/5"
                    : ""
                }
              >
                <CardContent className="py-4">
                  <div className="mb-2 flex items-baseline justify-between">
                    <strong>
                      {v.variant_label ?? `Variant ${v.variant_index + 1}`}
                    </strong>
                    {v.is_control ? (
                      <span className="rounded bg-muted px-2 py-0.5 text-xs">
                        Control
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="mb-2 truncate text-sm text-muted-foreground"
                    title={v.subject}
                  >
                    {v.subject ?? "(no subject)"}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm tabular-nums">
                    <div>
                      <div className="text-xs text-muted-foreground">Sent</div>
                      <div>{v.sent.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Hits</div>
                      <div>{v.hits.toLocaleString()}</div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-xs text-muted-foreground">
                        {metricLabel}
                      </div>
                      <div className="text-2xl font-semibold">
                        {v.sent > 0 ? fmtPct(v.rate) : "—"}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {data.bonferroni.applied_to_frequentist ? (
            <p className="mb-3 text-sm text-muted-foreground">
              Bonferroni: {data.bonferroni.num_comparisons} comparisons,
              corrected α = {data.bonferroni.corrected_alpha.toFixed(4)}.{" "}
              <span className="italic">
                significant_after_correction is the conservative read.
              </span>
            </p>
          ) : null}

          <Tabs defaultValue="bayesian">
            <TabsList aria-label="Experiment analysis method">
              <TabsTrigger value="bayesian">Bayesian</TabsTrigger>
              <TabsTrigger value="frequentist">Frequentist</TabsTrigger>
            </TabsList>
            <TabsContent value="bayesian">
              <Card>
                <CardContent className="py-4">
                  {Object.entries(data.bayesian).map(([key, b]) => (
                    <div
                      key={key}
                      className="flex flex-col gap-1 border-t py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <span>{comparisonLabel(key, data.variants)}</span>
                      <span className="text-sm tabular-nums">
                        P(B&gt;A) = {(b.prob_b_better * 100).toFixed(1)}% · 95%
                        CI [{b.credible_interval_95[0].toFixed(3)},{" "}
                        {b.credible_interval_95[1].toFixed(3)}]
                      </span>
                      <span
                        className={`rounded px-2 py-1 text-xs ${
                          b.prob_b_better >= 0.95
                            ? "bg-success/15 text-success-emphasis"
                            : "bg-muted"
                        }`}
                      >
                        {b.prob_b_better >= 0.95
                          ? "✓ P(B>A) > 95%"
                          : "· Not yet"}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="frequentist">
              <Card>
                <CardContent className="py-4">
                  {Object.entries(data.frequentist).map(([key, f]) => {
                    const isSig = data.bonferroni.applied_to_frequentist
                      ? f.significant_after_correction
                      : f.significant_at_95;
                    return (
                      <div
                        key={key}
                        className="flex flex-col gap-1 border-t py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <span>{comparisonLabel(key, data.variants)}</span>
                        <span className="text-sm tabular-nums">
                          z = {f.z_score.toFixed(2)} · p ={" "}
                          {f.p_value.toFixed(4)} · lift ={" "}
                          {f.lift_percent.toFixed(1)}%
                        </span>
                        <span
                          className={`rounded px-2 py-1 text-xs ${
                            isSig
                              ? "bg-success/15 text-success-emphasis"
                              : "bg-muted"
                          }`}
                          title={`raw p=${f.p_value.toFixed(4)}, corrected α=${data.bonferroni.corrected_alpha.toFixed(4)}`}
                        >
                          {isSig
                            ? data.bonferroni.applied_to_frequentist
                              ? "✓ Significant (Bonferroni)"
                              : "✓ Significant @ 95%"
                            : "· Not significant"}
                        </span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      ) : null}
    </div>
  );
}
