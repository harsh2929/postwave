// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { ApiError } from "@/lib/api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import {
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import {
  FreshAdminAuthorityError,
  verifyFreshAdminAuthority,
} from "@/lib/admin-mutation-authority";
import { downloadTextFile } from "@/lib/download";
import { base, qk, STALE } from "@/lib/query-keys";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Campaign } from "@/lib/campaigns-api";
import {
  type AdvancedSegmentSchemaResponse,
  type AccountExportsResponse,
  type AgencyEcosystemResponse,
  type AudienceInsightsResponse,
  type BatchesResponse,
  type CampaignInboxResponse,
  type CampaignPlannerResponse,
  type CampaignReport,
  type ClickMapResponse,
  type ConnectedSitesResponse,
  type CompatResource,
  type ContentStudioResponse,
  type CreativeAssistantResponse,
  type CustomReportResponse,
  type DeliveryInsightsResponse,
  type IntegrationMarketplaceResponse,
  type LandingPageParityResponse,
  type MailchimpBlockCatalogResponse,
  type MailchimpCompatSummary,
  type MailchimpParityWorkbenchResponse,
  type MultiChannelReadinessResponse,
  type MultivariateTestResponse,
  type OptimizationResponse,
  type SurveysResponse,
  type TemplateLanguagePreviewResponse,
  type VerifiedDomainsResponse,
  type VideoConvertResponse,
  type WebsiteBuilderStatusResponse,
} from "@/lib/mailchimp-compat-api";
import { loadCompatibilityPageData } from "./compatibility-page-data";
import { CompatibilityDetailSections } from "./compatibility-detail-sections";
import {
  compatibilityDemoActionsEnabled,
  useCompatibilityDemoActions,
} from "./use-compatibility-demo-actions";

const CompatibilityOverviewGrid = dynamic(
  () =>
    import("./compatibility-overview-grid").then(
      (mod) => mod.CompatibilityOverviewGrid,
    ),
  { loading: () => <CompatibilityOverviewSkeleton /> },
);

export default function CompatibilityPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = meQuery.isSuccess ? meQuery.data : null;
  const [tenantId, userId, role, viewerMode] = adminReadIdentityParts(identity);
  const authorityKey = identity
    ? [tenantId, userId, role, viewerMode].join("\u001f")
    : "unverified";
  const compatibilityBaseKey = useMemo(
    () =>
      [...base("compatibility", tenantId, role), userId, viewerMode] as const,
    [role, tenantId, userId, viewerMode],
  );
  const previousScopeRef = useRef<{
    fingerprint: string;
    queryKey: readonly unknown[];
  } | null>(null);

  useEffect(() => {
    if (meQuery.isPending) return;
    const previous = previousScopeRef.current;
    const current = identity
      ? { fingerprint: authorityKey, queryKey: compatibilityBaseKey }
      : null;
    if (
      previous &&
      (!current || previous.fingerprint !== current.fingerprint)
    ) {
      void queryClient.cancelQueries({
        queryKey: previous.queryKey,
        exact: false,
      });
      queryClient.removeQueries({ queryKey: previous.queryKey, exact: false });
    }
    if (!current) {
      void queryClient.cancelQueries({
        queryKey: ["compatibility"],
        exact: false,
      });
      queryClient.removeQueries({
        queryKey: ["compatibility"],
        exact: false,
      });
    }
    previousScopeRef.current = current;
  }, [
    authorityKey,
    compatibilityBaseKey,
    identity,
    meQuery.isPending,
    queryClient,
  ]);

  if (meQuery.isPending) {
    return <CompatibilityAccessState kind="loading" />;
  }
  if (meQuery.isError || !identity) {
    return (
      <CompatibilityAccessState
        kind="error"
        message={
          meQuery.error instanceof Error
            ? meQuery.error.message
            : "Moosewave could not verify the current workspace identity."
        }
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }

  return (
    <CompatibilityWorkspace
      key={authorityKey}
      identity={identity}
      authorityKey={authorityKey}
      compatibilityBaseKey={compatibilityBaseKey}
    />
  );
}

function CompatibilityWorkspace({
  identity,
  authorityKey,
  compatibilityBaseKey,
}: {
  identity: MeResponse;
  authorityKey: string;
  compatibilityBaseKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState<MailchimpCompatSummary | null>(null);
  const [groups, setGroups] = useState<CompatResource[]>([]);
  const [assets, setAssets] = useState<CompatResource[]>([]);
  const [sections, setSections] = useState<CompatResource[]>([]);
  const [journeys, setJourneys] = useState<CompatResource[]>([]);
  const [landingPages, setLandingPages] = useState<CompatResource[]>([]);
  const [popups, setPopups] = useState<CompatResource[]>([]);
  const [integrations, setIntegrations] = useState<CompatResource[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [planner, setPlanner] = useState<CampaignPlannerResponse | null>(null);
  const [multivariate, setMultivariate] =
    useState<MultivariateTestResponse | null>(null);
  const [sendTime, setSendTime] = useState<OptimizationResponse | null>(null);
  const [sendDay, setSendDay] = useState<OptimizationResponse | null>(null);
  const [clickMap, setClickMap] = useState<ClickMapResponse | null>(null);
  const [customReport, setCustomReport] = useState<CustomReportResponse | null>(
    null,
  );
  const [deliveryInsights, setDeliveryInsights] =
    useState<DeliveryInsightsResponse | null>(null);
  const [inbox, setInbox] = useState<CampaignInboxResponse | null>(null);
  const [multiChannel, setMultiChannel] =
    useState<MultiChannelReadinessResponse | null>(null);
  const [surveys, setSurveys] = useState<SurveysResponse | null>(null);
  const [landingParity, setLandingParity] =
    useState<LandingPageParityResponse | null>(null);
  const [websiteStatus, setWebsiteStatus] =
    useState<WebsiteBuilderStatusResponse | null>(null);
  const [audienceInsights, setAudienceInsights] =
    useState<AudienceInsightsResponse | null>(null);
  const [segmentSchema, setSegmentSchema] =
    useState<AdvancedSegmentSchemaResponse | null>(null);
  const [contentStudio, setContentStudio] =
    useState<ContentStudioResponse | null>(null);
  const [blockCatalog, setBlockCatalog] =
    useState<MailchimpBlockCatalogResponse | null>(null);
  const [batches, setBatches] = useState<BatchesResponse | null>(null);
  const [accountExports, setAccountExports] =
    useState<AccountExportsResponse | null>(null);
  const [connectedSites, setConnectedSites] =
    useState<ConnectedSitesResponse | null>(null);
  const [verifiedDomains, setVerifiedDomains] =
    useState<VerifiedDomainsResponse | null>(null);
  const [marketplace, setMarketplace] =
    useState<IntegrationMarketplaceResponse | null>(null);
  const [agencyEcosystem, setAgencyEcosystem] =
    useState<AgencyEcosystemResponse | null>(null);
  const [parityWorkbench, setParityWorkbench] =
    useState<MailchimpParityWorkbenchResponse | null>(null);
  const [creativeDraft, setCreativeDraft] =
    useState<CreativeAssistantResponse | null>(null);
  const [videoConversion, setVideoConversion] =
    useState<VideoConvertResponse | null>(null);
  const [templatePreview, setTemplatePreview] =
    useState<TemplateLanguagePreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partialErrors, setPartialErrors] = useState<string[]>([]);
  const [adminOnlyUnavailable, setAdminOnlyUnavailable] = useState<string[]>(
    [],
  );
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const includeAdmin = canReadAdminData(identity);
  const demoActionsEnabled =
    includeAdmin &&
    compatibilityDemoActionsEnabled(effectiveAuthRole(identity));
  const compatibilityDataKey = useMemo(
    () => [...compatibilityBaseKey, "overview"] as const,
    [compatibilityBaseKey],
  );
  const compatibilityDataQuery = useQuery({
    queryKey: compatibilityDataKey,
    queryFn: ({ signal }) =>
      loadCompatibilityPageData({ includeAdmin, signal }),
    staleTime: STALE.list,
    retry: false,
  });

  const containAuthorityFailure = useCallback(
    (failure: unknown) => {
      void queryClient.cancelQueries({
        queryKey: compatibilityBaseKey,
        exact: false,
      });
      queryClient.removeQueries({
        queryKey: compatibilityBaseKey,
        exact: false,
      });
      if (failure instanceof FreshAdminAuthorityError) {
        queryClient.setQueryData(qk.authMe(), failure.freshIdentity);
      }
    },
    [compatibilityBaseKey, queryClient],
  );

  const beforeWrite = useCallback(
    async (signal: AbortSignal) => {
      try {
        await verifyFreshAdminAuthority(identity, signal);
      } catch (failure) {
        if (!signal.aborted) containAuthorityFailure(failure);
        throw failure;
      }
    },
    [containAuthorityFailure, identity],
  );

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: compatibilityBaseKey,
        exact: false,
      });
    } finally {
      setRefreshing(false);
    }
  }, [compatibilityBaseKey, queryClient]);

  // Export the aggregated parity snapshot (GOV-054) so it can be handed to a
  // stakeholder. loadCompatibilityPageData already assembles the whole picture
  // into one object; we serialize that as JSON.
  const exportReport = useCallback(() => {
    const data = compatibilityDataQuery.data;
    if (!data) return;
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `postwave-compatibility-${stamp}.json`,
      JSON.stringify(
        { generated_at: new Date().toISOString(), ...data },
        null,
        2,
      ),
      "application/json;charset=utf-8",
    );
  }, [compatibilityDataQuery.data]);

  const {
    applyLocalMailchimpClosures,
    busy,
    convertSampleVideo,
    createAccountExportSnapshot,
    draftCampaignCreative,
    previewSampleTemplate,
    runAction,
    runBatchCompatibilityCheck,
    seedCampaignBuilder,
    seedCommerce,
    seedContactModel,
    seedGrowth,
    seedJourney,
    seedReport,
  } = useCompatibilityDemoActions({
    authorityKey,
    beforeWrite,
    campaigns,
    demoActionsEnabled,
    groupsCount: groups.length,
    integrations,
    refresh,
    setAccountExports,
    setBatches,
    setCreativeDraft,
    setParityWorkbench,
    setReport,
    setTemplatePreview,
    setVideoConversion,
  });

  useEffect(() => {
    const data = compatibilityDataQuery.data;
    if (!data) return;
    setError(null);
    setPartialErrors(data.partialErrors);
    setAdminOnlyUnavailable(data.adminOnlyUnavailable);
    setSummary(data.summary);
    setGroups(data.groups);
    setAssets(data.assets);
    setSections(data.sections);
    setJourneys(data.journeys);
    setLandingPages(data.landingPages);
    setPopups(data.popups);
    setIntegrations(data.integrations);
    setCampaigns(data.campaigns);
    setMultiChannel(data.multiChannel);
    setSurveys(data.surveys);
    setLandingParity(data.landingParity);
    setWebsiteStatus(data.websiteStatus);
    setAudienceInsights(data.audienceInsights);
    setSegmentSchema(data.segmentSchema);
    setContentStudio(data.contentStudio);
    setBlockCatalog(data.blockCatalog);
    setBatches(data.batches);
    setAccountExports(data.accountExports);
    setConnectedSites(data.connectedSites);
    setVerifiedDomains(data.verifiedDomains);
    setMarketplace(data.marketplace);
    setAgencyEcosystem(data.agencyEcosystem);
    setParityWorkbench(data.parityWorkbench);
    setPlanner(data.planner);
    setCustomReport(data.customReport);
    setReport(data.report);
    setMultivariate(data.multivariate);
    setSendTime(data.sendTime);
    setSendDay(data.sendDay);
    setClickMap(data.clickMap);
    setDeliveryInsights(data.deliveryInsights);
    setInbox(data.inbox);
    setLoaded(true);
  }, [compatibilityDataQuery.data]);

  useEffect(() => {
    if (compatibilityDataQuery.isPending && !compatibilityDataQuery.data) {
      setLoaded(false);
    }
  }, [compatibilityDataQuery.data, compatibilityDataQuery.isPending]);

  useEffect(() => {
    if (!compatibilityDataQuery.isError) return;
    setError(
      compatibilityDataQuery.error instanceof Error
        ? compatibilityDataQuery.error.message
        : "Could not load compatibility data — this is a failed request, not an empty workspace.",
    );
  }, [compatibilityDataQuery.isError, compatibilityDataQuery.error]);
  const authorizationRejected =
    compatibilityDataQuery.error instanceof ApiError &&
    (compatibilityDataQuery.error.status === 401 ||
      compatibilityDataQuery.error.status === 403);

  const readiness = useMemo(() => {
    if (!summary) return 0;
    // `if (!summary)` guards the CONTAINER, not its members. A summary that
    // arrives without one of these six sections — a partial payload, a shape
    // change, an endpoint that answers {} — passes that check and then throws
    // on `.groups`, taking the whole page down with a blank screen rather than
    // degrading one tile. Found by mounting the page against an empty body.
    const n = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const contacts = summary.contacts ?? {};
    const campaigns = summary.campaigns ?? {};
    const reports = summary.reports ?? {};
    const automations = summary.automations ?? {};
    const growth = summary.growth ?? {};
    const ecommerce = summary.ecommerce ?? {};
    const checks = [
      n(contacts.groups) > 0,
      n(campaigns.assets) > 0 && n(campaigns.reusable_sections) > 0,
      n(reports.events) > 0,
      n(automations.total) > 0,
      n(growth.landing_pages) > 0 || n(growth.popups) > 0,
      n(ecommerce.integrations) > 0 && n(ecommerce.orders) > 0,
    ];
    return checks.filter(Boolean).length;
  }, [summary]);

  return (
    <div className="mx-auto min-w-0 max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Mailchimp compatibility
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational coverage for the six parity areas customers expect
            during a switch. Imported Mailchimp objects are read-only here; demo
            seed controls only appear when explicitly enabled.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!demoActionsEnabled && <Badge variant="outline">Read-only</Badge>}
          {/* The badge measures which of the six areas have data seeded, not
              production readiness — label it for what it measures (GOV-045).
              Neutral placeholder until the first fetch resolves. */}
          {loaded ? (
            <Badge variant={readiness === 6 ? "success" : "secondary"}>
              {readiness}/6 areas with data
            </Badge>
          ) : (
            <Badge variant="secondary">…/6 areas with data</Badge>
          )}
          {loaded && compatibilityDataQuery.dataUpdatedAt ? (
            <span className="text-xs text-muted-foreground">
              Updated{" "}
              <RelativeTime
                iso={new Date(
                  compatibilityDataQuery.dataUpdatedAt,
                ).toISOString()}
              />
            </span>
          ) : null}
          <Button
            variant="outline"
            className="min-h-11"
            onClick={exportReport}
            disabled={!loaded || authorizationRejected || busy !== null}
          >
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            // Query invalidation can reject if the overview reader fails; keep
            // that visible in the banner instead of leaving an unhandled
            // promise rejection.
            onClick={() =>
              refresh().catch((err: unknown) => {
                setError(
                  err instanceof Error
                    ? err.message
                    : "Could not load compatibility data.",
                );
              })
            }
            // Keep an explicit refresh lifecycle so even a very fast cache
            // invalidation exposes deterministic busy/disabled semantics.
            disabled={busy !== null || (!loaded && !error)}
            loading={refreshing}
          >
            {!refreshing ? <RefreshCw className="h-4 w-4" /> : null}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      )}
      {partialErrors.length > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis"
        >
          <p className="font-medium">
            Some compatibility data could not be loaded. Values from these
            sources are unavailable, not zero:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {partialErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {adminOnlyUnavailable.length > 0 ? (
        <div
          role="status"
          className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          <p className="font-medium text-foreground">
            Some compatibility detail is admin-only
          </p>
          <p className="mt-1">
            {adminOnlyUnavailable.join(", ")} were not requested for this
            effective role. Their missing rows are unavailable, not empty.
          </p>
        </div>
      ) : null}

      {/* Initial-load skeleton: until the first fetch resolves, show shimmering
          placeholders instead of all-zero cards that read like a populated-but-
          empty account. Skipped when an error is already surfaced above. */}
      {!loaded && !error ? (
        <CompatibilityOverviewSkeleton />
      ) : (!loaded && error) || authorizationRejected ? (
        <Card role="alert" className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-6 text-sm text-muted-foreground">
            Compatibility values are unavailable because the request failed
            {authorizationRejected ? " or the server rejected this role" : ""}.
            No unavailable value is being shown as zero. Refresh after access is
            restored.
          </CardContent>
        </Card>
      ) : (
        <>
          <CompatibilityOverviewGrid
            summary={summary}
            assets={assets}
            sections={sections}
            journeys={journeys}
            landingPages={landingPages}
            popups={popups}
            integrations={integrations}
            report={report}
            busy={busy}
            demoActionsEnabled={demoActionsEnabled}
            runAction={runAction}
            seedContactModel={seedContactModel}
            seedCampaignBuilder={seedCampaignBuilder}
            seedReport={seedReport}
            seedJourney={seedJourney}
            seedGrowth={seedGrowth}
            seedCommerce={seedCommerce}
          />

          <CompatibilityDetailSections
            groups={groups}
            assets={assets}
            journeys={journeys}
            landingPages={landingPages}
            popups={popups}
            integrations={integrations}
            planner={planner}
            multivariate={multivariate}
            sendTime={sendTime}
            sendDay={sendDay}
            clickMap={clickMap}
            customReport={customReport}
            deliveryInsights={deliveryInsights}
            inbox={inbox}
            multiChannel={multiChannel}
            surveys={surveys}
            landingParity={landingParity}
            websiteStatus={websiteStatus}
            audienceInsights={audienceInsights}
            segmentSchema={segmentSchema}
            contentStudio={contentStudio}
            blockCatalog={blockCatalog}
            batches={batches}
            accountExports={accountExports}
            connectedSites={connectedSites}
            verifiedDomains={verifiedDomains}
            marketplace={marketplace}
            agencyEcosystem={agencyEcosystem}
            parityWorkbench={parityWorkbench}
            busy={busy}
            creativeDraft={creativeDraft}
            demoActionsEnabled={demoActionsEnabled}
            templatePreview={templatePreview}
            videoConversion={videoConversion}
            applyLocalMailchimpClosures={applyLocalMailchimpClosures}
            createAccountExportSnapshot={createAccountExportSnapshot}
            convertSampleVideo={convertSampleVideo}
            draftCampaignCreative={draftCampaignCreative}
            previewSampleTemplate={previewSampleTemplate}
            runBatchCompatibilityCheck={runBatchCompatibilityCheck}
          />
        </>
      )}
    </div>
  );
}

function CompatibilityAccessState({
  kind,
  message,
  retrying = false,
  onRetry,
}: {
  kind: "loading" | "error";
  message?: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="mx-auto min-w-0 max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Mailchimp compatibility
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Compatibility data is loaded only after the current workspace identity
          is verified.
        </p>
      </div>
      <Card role={kind === "loading" ? "status" : "alert"}>
        <CardHeader>
          <p className="font-semibold">
            {kind === "loading"
              ? "Checking compatibility access…"
              : "Couldn’t verify compatibility access"}
          </p>
          <p className="text-sm text-muted-foreground">
            {kind === "loading"
              ? "Moosewave is confirming the current workspace, effective role, and viewer mode before requesting compatibility data."
              : `${message ?? "The identity check failed."} No compatibility request was made.`}
          </p>
        </CardHeader>
        {kind === "error" && onRetry ? (
          <CardContent>
            <Button type="button" onClick={onRetry} loading={retrying}>
              {retrying ? "Retrying…" : "Retry access check"}
            </Button>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}

function CompatibilityOverviewSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading compatibility data…</span>
      <div
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        aria-hidden="true"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-8 w-20" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-4 w-40" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-3/4" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
