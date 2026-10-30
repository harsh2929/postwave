// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// The recent-campaign fan-out behind the Analytics page's campaign-derived
// panels — desktop useAnalyticsDashboardController.ts:190-534 as TanStack
// queries:
//
//   GET /api/v1/campaigns?page=1&per_page=5            the recent five
//   GET /api/v1/campaigns/{id}/report      ×5          performance bars
//   GET /api/v1/campaigns/{id}/benchmark   ×1 (latest) verdict badges
//   GET /api/v1/campaigns/{id}/devices     ×5          mail-client mix
//   GET /api/v1/campaigns/{id}/geography   ×5          top countries
//   GET /api/v1/campaigns/{id}/link-report ×5          top links
//   GET /api/v1/campaigns/{id}/bounces     ×5          bounce-type mix
//
// Every per-campaign read uses the SAME key the campaign drill-down uses
// (`[...qk.campaign(tenant, role, id), "analytics", <resource>]`), so a panel
// and the drill-down it links to share one cache entry — opening a campaign
// from here is instant, and neither can show the other a stale copy.
//
// Each panel asks only for what it draws (`want`), so the Audience tab never
// fetches reports and the Overview never fetches geography. Panels on one
// page asking for the same resource share the query, not a second request.
//
// Nothing here is a write. The reads sit behind the gateway's `read:reports`
// scope; a refusal carries the server's own sentence, which the panels render
// verbatim instead of inventing a permission explanation.

import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiErrorMessage } from "@/lib/api";
import {
  aggregateBounces,
  aggregateDevices,
  aggregateGeography,
  aggregateLinks,
  RECENT_CAMPAIGN_COUNT,
  recentCampaignName,
  type RecentCampaign,
} from "@/lib/analytics-recent-campaigns";
import {
  getCampaignBenchmark,
  getCampaignBounces,
  getCampaignDevices,
  getCampaignGeography,
  getCampaignLinkReport,
  getCampaignReport,
  type CampaignBenchmark,
  type CampaignBounceCounts,
  type CampaignDeviceRow,
  type CampaignGeographyRow,
  type CampaignLinkRow,
  type CampaignReport,
} from "@/lib/campaign-analytics-api";
import { listCampaigns } from "@/lib/campaigns-api";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

export interface RecentCampaignScope {
  tenantId: string;
  role: RoleKey;
}

export interface RecentCampaignWants {
  reports?: boolean;
  benchmark?: boolean;
  audience?: boolean;
  bounces?: boolean;
}

/** One resource's outcome across the campaigns it was read for. */
export interface ResourceOutcome {
  loading: boolean;
  /** The first failed read's SERVER sentence. Never invented. */
  error: string | null;
  /** How many of the per-campaign reads failed. */
  failed: number;
  retry: () => void;
}

/**
 * Identity first: an analytics read keyed to `anon` would be a cache entry
 * the next signed-in person could be served. Mirrors analyticsAuthorityReady.
 */
export function recentCampaignScopeReady(scope: RecentCampaignScope): boolean {
  return (
    scope.tenantId !== "" && scope.tenantId !== "anon" && scope.role !== null
  );
}

export function recentCampaignsKey(scope: RecentCampaignScope) {
  return qk.campaigns(scope.tenantId, scope.role, {
    purpose: "analytics-recent",
    page: 1,
    perPage: RECENT_CAMPAIGN_COUNT,
  });
}

function campaignAnalyticsKey(
  scope: RecentCampaignScope,
  campaignId: string,
  resource: string,
) {
  return [
    ...qk.campaign(scope.tenantId, scope.role, campaignId),
    "analytics",
    resource,
  ] as const;
}

function outcomeOf(
  results: ReadonlyArray<UseQueryResult<unknown>>,
  enabled: boolean,
): ResourceOutcome {
  const failed = results.filter((result) => result.isError);
  return {
    loading: enabled && results.some((result) => result.isPending),
    error: failed.length > 0 ? apiErrorMessage(failed[0]?.error) : null,
    failed: failed.length,
    retry: () => {
      for (const result of failed) void result.refetch();
    },
  };
}

/** Per-campaign data, `null` for a campaign whose read has not succeeded. */
function dataOf<T>(results: ReadonlyArray<UseQueryResult<T>>): Array<T | null> {
  return results.map((result) => (result.isSuccess ? result.data : null));
}

export interface RecentCampaignAnalytics {
  /** The campaign list itself. */
  list: ResourceOutcome;
  campaigns: RecentCampaign[];
  reports: Record<string, CampaignReport>;
  reportsOutcome: ResourceOutcome;
  /** The LATEST campaign's benchmark (desktop benchmarks ids[0] only). */
  benchmark: CampaignBenchmark | null;
  benchmarkOutcome: ResourceOutcome;
  /** Fan-in totals; `null` until every campaign's read has succeeded. */
  devices: CampaignDeviceRow[] | null;
  devicesOutcome: ResourceOutcome;
  geography: CampaignGeographyRow[] | null;
  geographyOutcome: ResourceOutcome;
  links: CampaignLinkRow[] | null;
  linksOutcome: ResourceOutcome;
  bounces: CampaignBounceCounts | null;
  bouncesOutcome: ResourceOutcome;
}

export function useRecentCampaignAnalytics(
  scope: RecentCampaignScope,
  want: RecentCampaignWants,
): RecentCampaignAnalytics {
  const ready = recentCampaignScopeReady(scope);

  const listQuery = useQuery({
    queryKey: recentCampaignsKey(scope),
    queryFn: ({ signal }) =>
      listCampaigns({ page: 1, perPage: RECENT_CAMPAIGN_COUNT }, { signal }),
    enabled: ready,
    staleTime: STALE.dashboard,
  });

  const campaigns: RecentCampaign[] = (
    Array.isArray(listQuery.data) ? listQuery.data : []
  )
    .filter((campaign) => typeof campaign?.id === "string" && campaign.id)
    .slice(0, RECENT_CAMPAIGN_COUNT)
    .map((campaign) => ({
      id: campaign.id,
      name: recentCampaignName(campaign),
    }));
  const ids = campaigns.map((campaign) => campaign.id);
  const listed = ready && listQuery.isSuccess;

  const reportsOn = listed && want.reports === true;
  const benchmarkOn = listed && want.benchmark === true && ids.length > 0;
  const audienceOn = listed && want.audience === true;
  const bouncesOn = listed && want.bounces === true;

  const reportResults = useQueries({
    queries: ids.map((id) => ({
      queryKey: campaignAnalyticsKey(scope, id, "report"),
      queryFn: () => getCampaignReport(id),
      enabled: reportsOn,
      staleTime: STALE.detail,
    })),
  });
  const latestId = ids[0] ?? "";
  const benchmarkQuery = useQuery({
    queryKey: campaignAnalyticsKey(scope, latestId, "benchmark"),
    queryFn: () => getCampaignBenchmark(latestId),
    enabled: benchmarkOn,
    staleTime: STALE.detail,
  });
  const deviceResults = useQueries({
    queries: ids.map((id) => ({
      queryKey: campaignAnalyticsKey(scope, id, "devices"),
      queryFn: () => getCampaignDevices(id),
      enabled: audienceOn,
      staleTime: STALE.detail,
    })),
  });
  const geographyResults = useQueries({
    queries: ids.map((id) => ({
      queryKey: campaignAnalyticsKey(scope, id, "geography"),
      queryFn: () => getCampaignGeography(id),
      enabled: audienceOn,
      staleTime: STALE.detail,
    })),
  });
  const linkResults = useQueries({
    queries: ids.map((id) => ({
      queryKey: campaignAnalyticsKey(scope, id, "link-report"),
      queryFn: () => getCampaignLinkReport(id),
      enabled: audienceOn,
      staleTime: STALE.detail,
    })),
  });
  const bounceResults = useQueries({
    queries: ids.map((id) => ({
      queryKey: campaignAnalyticsKey(scope, id, "bounces"),
      queryFn: () => getCampaignBounces(id),
      enabled: bouncesOn,
      staleTime: STALE.detail,
    })),
  });

  const reports: Record<string, CampaignReport> = {};
  reportResults.forEach((result, index) => {
    const id = ids[index];
    if (id && result.isSuccess) reports[id] = result.data;
  });

  return {
    list: {
      loading: ready && listQuery.isPending,
      error: listQuery.isError ? apiErrorMessage(listQuery.error) : null,
      failed: listQuery.isError ? 1 : 0,
      retry: () => {
        void listQuery.refetch();
      },
    },
    campaigns,
    reports,
    reportsOutcome: outcomeOf(reportResults, reportsOn),
    benchmark:
      benchmarkOn && benchmarkQuery.isSuccess ? benchmarkQuery.data : null,
    benchmarkOutcome: outcomeOf(benchmarkOn ? [benchmarkQuery] : [], benchmarkOn),
    devices: audienceOn ? aggregateDevices(dataOf(deviceResults)) : null,
    devicesOutcome: outcomeOf(deviceResults, audienceOn),
    geography: audienceOn ? aggregateGeography(dataOf(geographyResults)) : null,
    geographyOutcome: outcomeOf(geographyResults, audienceOn),
    links: audienceOn ? aggregateLinks(dataOf(linkResults)) : null,
    linksOutcome: outcomeOf(linkResults, audienceOn),
    bounces: bouncesOn ? aggregateBounces(dataOf(bounceResults)) : null,
    bouncesOutcome: outcomeOf(bounceResults, bouncesOn),
  };
}
