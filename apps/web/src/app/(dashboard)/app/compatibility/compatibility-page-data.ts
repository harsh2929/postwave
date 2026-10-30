// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError } from "@/lib/api";
import { listCampaigns, type Campaign } from "@/lib/campaigns-api";
import {
  getAccountExports,
  getAdvancedSegmentSchema,
  getAgencyEcosystem,
  getAudienceInsights,
  getBatches,
  getCampaignInbox,
  getCampaignPlanner,
  getCampaignReport,
  getClickMap,
  getConnectedSites,
  getContentStudio,
  getCustomReport,
  getDeliveryInsights,
  getIntegrationMarketplace,
  getLandingPageParity,
  getMailchimpBlockCatalog,
  getMailchimpCompatSummary,
  getMailchimpParityWorkbench,
  getMultiChannelReadiness,
  getMultivariateTest,
  getSendDayOptimization,
  getSendTimeOptimization,
  getSurveys,
  getVerifiedDomains,
  getWebsiteBuilderStatus,
  listCompatResources,
  type MailchimpCompatResourcePath,
  type AccountExportsResponse,
  type AdvancedSegmentSchemaResponse,
  type AgencyEcosystemResponse,
  type AudienceInsightsResponse,
  type BatchesResponse,
  type CampaignInboxResponse,
  type CampaignPlannerResponse,
  type CampaignReport,
  type ClickMapResponse,
  type CompatResource,
  type ConnectedSitesResponse,
  type ContentStudioResponse,
  type CustomReportResponse,
  type DeliveryInsightsResponse,
  type ImportedForm,
  type ImportedTemplate,
  type IntegrationMarketplaceResponse,
  type LandingPageParityResponse,
  type MailchimpBlockCatalogResponse,
  type MailchimpCompatSummary,
  type MailchimpParityWorkbenchResponse,
  type MultiChannelReadinessResponse,
  type MultivariateTestResponse,
  type OptimizationResponse,
  type ReportHistoryItem,
  type SurveysResponse,
  type VerifiedDomainsResponse,
  type WebsiteBuilderStatusResponse,
} from "@/lib/mailchimp-compat-api";

import { selectReportableCampaign } from "./compatibility-campaign";

export type CompatibilityPageData = {
  partialErrors: string[];
  /** Collections intentionally not requested without exact admin authority. */
  adminOnlyUnavailable: string[];
  summary: MailchimpCompatSummary;
  groups: CompatResource[];
  templates: ImportedTemplate[];
  forms: ImportedForm[];
  assets: CompatResource[];
  sections: CompatResource[];
  journeys: CompatResource[];
  landingPages: CompatResource[];
  popups: CompatResource[];
  integrations: CompatResource[];
  reportHistory: ReportHistoryItem[];
  campaigns: Campaign[];
  report: CampaignReport | null;
  planner: CampaignPlannerResponse | null;
  multivariate: MultivariateTestResponse | null;
  sendTime: OptimizationResponse | null;
  sendDay: OptimizationResponse | null;
  clickMap: ClickMapResponse | null;
  customReport: CustomReportResponse | null;
  deliveryInsights: DeliveryInsightsResponse | null;
  inbox: CampaignInboxResponse | null;
  multiChannel: MultiChannelReadinessResponse | null;
  surveys: SurveysResponse | null;
  landingParity: LandingPageParityResponse | null;
  websiteStatus: WebsiteBuilderStatusResponse | null;
  audienceInsights: AudienceInsightsResponse | null;
  segmentSchema: AdvancedSegmentSchemaResponse | null;
  contentStudio: ContentStudioResponse | null;
  blockCatalog: MailchimpBlockCatalogResponse | null;
  batches: BatchesResponse | null;
  accountExports: AccountExportsResponse | null;
  connectedSites: ConnectedSitesResponse | null;
  verifiedDomains: VerifiedDomainsResponse | null;
  marketplace: IntegrationMarketplaceResponse | null;
  agencyEcosystem: AgencyEcosystemResponse | null;
  parityWorkbench: MailchimpParityWorkbenchResponse | null;
};

export async function loadCompatibilityPageData({
  includeAdmin,
  signal,
}: {
  includeAdmin: boolean;
  signal?: AbortSignal;
}): Promise<CompatibilityPageData> {
  const partialErrors: string[] = [];
  const adminOnlyUnavailable = includeAdmin
    ? []
    : ["Automations", "Landing pages", "Popups", "Ecommerce integrations"];
  const request = { signal };
  // A 404 is "this object was never created / never sent" — an empty, neutral
  // condition, not a load failure. Surfacing it in the fail-loud banner made a
  // healthy fresh tenant look broken (GOV-015). Only genuine failures (5xx,
  // network, auth) belong in the banner.
  const isNeverSent = (error: unknown): boolean =>
    error instanceof ApiError && error.status === 404;
  const optional = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof ApiError &&
          (error.status === 401 || error.status === 403))
      ) {
        throw error;
      }
      if (!isNeverSent(error)) {
        partialErrors.push(`${label}: ${errorMessage(error)}`);
      }
      return null;
    }
  };
  const optionalList = async <T = CompatResource>(
    label: string,
    path: MailchimpCompatResourcePath,
  ): Promise<T[]> => {
    try {
      return await listCompatResources<T>(path, request);
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof ApiError &&
          (error.status === 401 || error.status === 403))
      ) {
        throw error;
      }
      if (!isNeverSent(error)) {
        partialErrors.push(`${label}: ${errorMessage(error)}`);
      }
      return [];
    }
  };
  const [
    summary,
    groups,
    templates,
    forms,
    assets,
    sections,
    journeys,
    landingPages,
    popups,
    integrations,
    reportHistory,
    campaigns,
    multiChannel,
    surveys,
    landingParity,
    websiteStatus,
    audienceInsights,
    segmentSchema,
    contentStudio,
    blockCatalog,
    batches,
    accountExports,
    connectedSites,
    verifiedDomains,
    marketplace,
    agencyEcosystem,
    parityWorkbench,
  ] = await Promise.all([
    getMailchimpCompatSummary(request),
    listCompatResources("groups", request),
    Promise.resolve([] as ImportedTemplate[]),
    Promise.resolve([] as ImportedForm[]),
    optionalList("Campaign assets", "assets"),
    optionalList("Reusable sections", "sections"),
    includeAdmin
      ? optionalList("Automations", "automations")
      : Promise.resolve([]),
    includeAdmin
      ? optionalList("Landing pages", "landing-pages")
      : Promise.resolve([]),
    includeAdmin ? optionalList("Popups", "popups") : Promise.resolve([]),
    includeAdmin
      ? optionalList("Ecommerce integrations", "ecommerce/integrations")
      : Promise.resolve([]),
    Promise.resolve([] as ReportHistoryItem[]),
    // Keep this sample bounded, but include enough newest-first rows to find a
    // sent campaign behind drafts or scheduled work. Report-only endpoints are
    // intentionally skipped below when the sample contains no sent campaign.
    listCampaigns({ limit: 10 }, request),
    optional("Multi-channel readiness", () =>
      getMultiChannelReadiness(request),
    ),
    optional("Surveys", () => getSurveys(request)),
    optional("Landing-page parity", () => getLandingPageParity(request)),
    optional("Website builder", () => getWebsiteBuilderStatus(request)),
    optional("Audience insights", () => getAudienceInsights(request)),
    optional("Advanced segment schema", () =>
      getAdvancedSegmentSchema(request),
    ),
    optional("Content studio", () => getContentStudio(request)),
    optional("Block catalog", () => getMailchimpBlockCatalog(request)),
    optional("Batches", () => getBatches(request)),
    optional("Account exports", () => getAccountExports(request)),
    optional("Connected sites", () => getConnectedSites(request)),
    optional("Verified domains", () => getVerifiedDomains(request)),
    optional("Marketplace", () => getIntegrationMarketplace(request)),
    optional("Agency ecosystem", () => getAgencyEcosystem(request)),
    optional("Parity workbench", () => getMailchimpParityWorkbench(request)),
  ]);
  const planner = await optional("Campaign planner", () =>
    getCampaignPlanner(request),
  );
  const customReport = await optional("Custom report", () =>
    getCustomReport(undefined, request),
  );
  const reportable = selectReportableCampaign(campaigns);
  if (!reportable) {
    return {
      partialErrors,
      adminOnlyUnavailable,
      summary,
      groups,
      templates,
      forms,
      assets,
      sections,
      journeys,
      landingPages,
      popups,
      integrations,
      reportHistory,
      campaigns,
      report: null,
      planner,
      multivariate: null,
      sendTime: null,
      sendDay: null,
      clickMap: null,
      customReport,
      deliveryInsights: null,
      inbox: null,
      multiChannel,
      surveys,
      landingParity,
      websiteStatus,
      audienceInsights,
      segmentSchema,
      contentStudio,
      blockCatalog,
      batches,
      accountExports,
      connectedSites,
      verifiedDomains,
      marketplace,
      agencyEcosystem,
      parityWorkbench,
    };
  }
  const [
    report,
    multivariate,
    sendTime,
    sendDay,
    clickMap,
    deliveryInsights,
    inbox,
  ] = await Promise.all([
    optional("Campaign report", () =>
      getCampaignReport(reportable.id, request),
    ),
    optional("Multivariate test", () =>
      getMultivariateTest(reportable.id, request),
    ),
    optional("Send-time optimization", () =>
      getSendTimeOptimization(reportable.id, request),
    ),
    optional("Send-day optimization", () =>
      getSendDayOptimization(reportable.id, request),
    ),
    optional("Click map", () => getClickMap(reportable.id, request)),
    optional("Delivery insights", () =>
      getDeliveryInsights(reportable.id, request),
    ),
    optional("Campaign inbox", () => getCampaignInbox(reportable.id, request)),
  ]);

  return {
    partialErrors,
    adminOnlyUnavailable,
    summary,
    groups,
    templates,
    forms,
    assets,
    sections,
    journeys,
    landingPages,
    popups,
    integrations,
    reportHistory,
    campaigns,
    report,
    planner,
    multivariate,
    sendTime,
    sendDay,
    clickMap,
    customReport,
    deliveryInsights,
    inbox,
    multiChannel,
    surveys,
    landingParity,
    websiteStatus,
    audienceInsights,
    segmentSchema,
    contentStudio,
    blockCatalog,
    batches,
    accountExports,
    connectedSites,
    verifiedDomains,
    marketplace,
    agencyEcosystem,
    parityWorkbench,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}
