// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Campaign analytics drill-down — the web half of the surface desktop has had
 * as `CampaignAnalyticsSlideover`. Eleven per-campaign reads across three
 * tabs; before this, web could show a campaign's totals nowhere but the
 * dashboard's tenant-wide rollup.
 *
 * Two properties are deliberate and load-bearing:
 *
 *  - **Per-resource failure isolation.** Each read is its own query and its
 *    own section. A 500 from `geography` costs the reader the geography card
 *    and nothing else, and it says so with the server's own sentence instead
 *    of rendering an empty card that looks like a country-less campaign.
 *  - **Per-tab loading.** Only the active tab's resources are requested, the
 *    same split desktop's `CAMPAIGN_ANALYTICS_TAB_RESOURCES` uses, so opening
 *    the page does not fire eleven heavy reads at once. Cached tabs stay
 *    rendered when you come back.
 *
 * Every query key is `qk.campaign(tenant, role, id)` plus the resource name,
 * so one person's analytics cache cannot be served to another tenant or role
 * on a shared browser, and reads wait for identity to resolve rather than
 * filling an `anon`-keyed entry.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Route } from "next";
import { ArrowLeft } from "lucide-react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/dashboard/page-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { getCampaign } from "@/lib/campaigns-api";
import {
  getCampaignAnomalies,
  getCampaignBenchmark,
  getCampaignBounces,
  getCampaignDevices,
  getCampaignEngagement,
  getCampaignGeography,
  getCampaignGoalResults,
  getCampaignLinkReport,
  getCampaignLocaleReport,
  getCampaignReport,
  getCampaignTimeseries,
  type CampaignAnomaly,
} from "@/lib/campaign-analytics-api";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

import {
  CampaignAnomaliesSection,
  CampaignBenchmarkSection,
  CampaignBounceMixSection,
  CampaignDeliveryTotalsSection,
  CampaignDevicesSection,
  CampaignEngagementSection,
  CampaignFunnelSection,
  CampaignGeographySection,
  CampaignGoalSection,
  CampaignLinksSection,
  CampaignLocalesSection,
  CampaignTimeseriesSection,
  CampaignTotalsSection,
  type SectionState,
} from "./campaign-analytics-sections";

type AnalyticsTab = "overview" | "audience" | "delivery";

type ResourceKey =
  | "report"
  | "benchmark"
  | "engagement"
  | "timeseries"
  | "goal"
  | "anomalies"
  | "links"
  | "geography"
  | "devices"
  | "locales"
  | "bounces";

/** Which reads each tab needs — mirrors desktop's tab/resource split so the
 *  two surfaces request the same evidence for the same question. */
const TAB_RESOURCES: Readonly<Record<AnalyticsTab, readonly ResourceKey[]>> = {
  overview: [
    "report",
    "benchmark",
    "engagement",
    "timeseries",
    "goal",
    "anomalies",
  ],
  audience: ["report", "links", "geography", "devices", "locales"],
  delivery: ["report", "bounces"],
};

const TABS: readonly { id: AnalyticsTab; label: string; blurb: string }[] = [
  {
    id: "overview",
    label: "Overview",
    blurb:
      "Cumulative delivery-to-click performance, trust signals, hourly movement, conversion-goal evidence, anomalies, and this workspace's own baseline.",
  },
  {
    id: "audience",
    label: "Audience & links",
    blurb:
      "Aggregate link, mail-client, country, and recipient-language signals. No recipient identities are loaded into this view.",
  },
  {
    id: "delivery",
    label: "Delivery",
    blurb: "Cumulative delivery totals and bounce classification.",
  },
];

/** Flatten a query into the four outcomes a section renders. The error string
 *  is the server's own sentence — a denial explains itself, we never guess. */
function sectionState<T>(query: UseQueryResult<T>): SectionState<T> {
  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.isError ? apiErrorMessage(query.error) : null,
    retry: () => {
      void query.refetch();
    },
  };
}

export function CampaignAnalyticsClient() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;
  const [tab, setTab] = useState<AnalyticsTab>("overview");

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const campaignKey = useMemo(
    () => qk.campaign(tenantId, role, campaignId),
    [campaignId, role, tenantId],
  );

  // Identity first: an analytics read keyed to `anon` would be a cache entry
  // the next signed-in person could be served.
  const identityReady = meQuery.isFetched;
  const wants = (resource: ResourceKey): boolean =>
    identityReady && TAB_RESOURCES[tab].includes(resource);

  const campaignQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(campaignId),
    enabled: identityReady,
    staleTime: STALE.detail,
  });

  const reportQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "report"],
    queryFn: () => getCampaignReport(campaignId),
    enabled: wants("report"),
    staleTime: STALE.detail,
  });
  const benchmarkQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "benchmark"],
    queryFn: () => getCampaignBenchmark(campaignId),
    enabled: wants("benchmark"),
    staleTime: STALE.detail,
  });
  const engagementQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "engagement"],
    queryFn: () => getCampaignEngagement(campaignId),
    enabled: wants("engagement"),
    staleTime: STALE.detail,
  });
  const timeseriesQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "timeseries"],
    queryFn: () => getCampaignTimeseries(campaignId),
    enabled: wants("timeseries"),
    staleTime: STALE.detail,
  });
  const goalQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "goal-results"],
    queryFn: () => getCampaignGoalResults(campaignId),
    enabled: wants("goal"),
    staleTime: STALE.detail,
  });
  const anomaliesQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "anomalies"],
    queryFn: () => getCampaignAnomalies(campaignId),
    enabled: wants("anomalies"),
    staleTime: STALE.detail,
  });
  const linksQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "link-report"],
    queryFn: () => getCampaignLinkReport(campaignId),
    enabled: wants("links"),
    staleTime: STALE.detail,
  });
  const geographyQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "geography"],
    queryFn: () => getCampaignGeography(campaignId),
    enabled: wants("geography"),
    staleTime: STALE.detail,
  });
  const devicesQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "devices"],
    queryFn: () => getCampaignDevices(campaignId),
    enabled: wants("devices"),
    staleTime: STALE.detail,
  });
  const localesQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "locale-report"],
    queryFn: () => getCampaignLocaleReport(campaignId),
    enabled: wants("locales"),
    staleTime: STALE.detail,
  });
  const bouncesQuery = useQuery({
    queryKey: [...campaignKey, "analytics", "bounces"],
    queryFn: () => getCampaignBounces(campaignId),
    enabled: wants("bounces"),
    staleTime: STALE.detail,
  });

  const report = sectionState(reportQuery);
  // The anomalies route answers with an envelope; the section renders the
  // rows, so unwrap here rather than teach the section about the envelope.
  const anomalies: SectionState<CampaignAnomaly[]> = {
    ...sectionState(anomaliesQuery),
    data: anomaliesQuery.data?.anomalies ?? null,
  };

  // A campaign whose name failed to load must not read as a campaign with no
  // name; say which it is.
  const campaignName = campaignQuery.isError
    ? "Campaign (name failed to load)"
    : campaignQuery.data?.name;

  const activeTab = TABS.find((entry) => entry.id === tab) ?? TABS[0]!;

  return (
    <PageShell>
      <Breadcrumb
        items={[
          { label: "Campaigns", href: asRoute("/app/campaigns") },
          ...(campaignName
            ? [
                {
                  label: campaignName,
                  href: asRoute(`/app/campaigns/${campaignId}`) as Route,
                },
              ]
            : []),
          { label: "Analytics" },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="Back to campaign"
          title="Back to campaign"
        >
          <Link href={`/app/campaigns/${campaignId}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Campaign analytics
          </h1>
          {campaignName ? (
            <p className="break-words text-sm text-muted-foreground">
              {campaignName}
            </p>
          ) : null}
        </div>
      </div>

      {meQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t confirm who you are</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{apiErrorMessage(meQuery.error)}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void meQuery.refetch();
              }}
            >
              Retry sign-in check
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as AnalyticsTab)}
      >
        <TabsList aria-label="Campaign analytics sections">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <p className="mt-3 text-sm text-muted-foreground">{activeTab.blurb}</p>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <CampaignTotalsSection report={report} />
          <CampaignBenchmarkSection benchmark={sectionState(benchmarkQuery)} />
          <CampaignEngagementSection
            engagement={sectionState(engagementQuery)}
          />
          <CampaignAnomaliesSection anomalies={anomalies} />
          <CampaignTimeseriesSection
            timeseries={sectionState(timeseriesQuery)}
          />
          <CampaignGoalSection goal={sectionState(goalQuery)} />
          <CampaignFunnelSection report={report} />
        </TabsContent>

        <TabsContent value="audience" className="mt-4 space-y-4">
          <CampaignLinksSection links={sectionState(linksQuery)} />
          <CampaignDevicesSection devices={sectionState(devicesQuery)} />
          <CampaignGeographySection geography={sectionState(geographyQuery)} />
          <CampaignLocalesSection locales={sectionState(localesQuery)} />
        </TabsContent>

        <TabsContent value="delivery" className="mt-4 space-y-4">
          <CampaignDeliveryTotalsSection report={report} />
          <CampaignBounceMixSection bounces={sectionState(bouncesQuery)} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
