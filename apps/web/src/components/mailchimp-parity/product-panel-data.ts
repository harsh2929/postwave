// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";
import {
  type AccountExportsResponse,
  type AgencyEcosystemResponse,
  type BatchesResponse,
  type ConnectedSitesResponse,
  type IntegrationMarketplaceResponse,
  type LandingPageParityResponse,
  type MultiChannelReadinessResponse,
  type SurveysResponse,
  type VerifiedDomainsResponse,
  type WebsiteBuilderStatusResponse,
} from "@/lib/mailchimp-compat-api";

export interface MultiChannelOpsData {
  readiness: MultiChannelReadinessResponse;
  surveys: SurveysResponse;
  landing: LandingPageParityResponse;
  website: WebsiteBuilderStatusResponse;
}

export async function loadMultiChannelOpsData(signal?: AbortSignal): Promise<MultiChannelOpsData> {
  const [readiness, surveys, landing, website] = await Promise.all([
    api.get<MultiChannelReadinessResponse>("/api/mailchimp/3.0/growth/channels", { signal }),
    api.get<SurveysResponse>("/api/mailchimp/3.0/surveys", { signal }),
    api.get<LandingPageParityResponse>("/api/mailchimp/3.0/landing-pages/parity", { signal }),
    api.get<WebsiteBuilderStatusResponse>("/api/mailchimp/3.0/website-builder", { signal }),
  ]);
  return { readiness, surveys, landing, website };
}

export interface PlatformOpsData {
  batches: BatchesResponse | null;
  exportsState: AccountExportsResponse | null;
  sites: ConnectedSitesResponse | null;
  domains: VerifiedDomainsResponse | null;
  marketplace: IntegrationMarketplaceResponse | null;
  agency: AgencyEcosystemResponse | null;
}

export async function loadPlatformOpsData(signal?: AbortSignal): Promise<PlatformOpsData> {
  const [batches, exportsState, sites, domains, marketplace, agency] = await Promise.all([
    api.get<BatchesResponse>("/api/mailchimp/3.0/batches", { signal }),
    api.get<AccountExportsResponse>("/api/mailchimp/3.0/account-exports", { signal }),
    api.get<ConnectedSitesResponse>("/api/mailchimp/3.0/connected-sites", { signal }),
    api.get<VerifiedDomainsResponse>("/api/mailchimp/3.0/verified-domains", { signal }),
    api.get<IntegrationMarketplaceResponse>("/api/mailchimp/3.0/integration-marketplace", { signal }),
    api.get<AgencyEcosystemResponse>("/api/mailchimp/3.0/agency-ecosystem", { signal }),
  ]);
  return { batches, exportsState, sites, domains, marketplace, agency };
}
