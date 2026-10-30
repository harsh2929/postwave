// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export type DeveloperMarketplaceAppType =
  | "private"
  | "public"
  | "native"
  | "catalog_only";

export type DeveloperMarketplaceAppDistribution =
  | "private"
  | "marketplace"
  | "partner_catalog"
  | "native_postwave"
  | "catalog_only";

export type DeveloperMarketplaceAppStatus =
  | "draft"
  | "submitted"
  | "in_review"
  | "approved"
  | "active"
  | "suspended"
  | "rejected"
  | "archived";

export interface DeveloperMarketplaceReviewItem {
  key: string;
  label: string;
  complete: boolean;
  required: boolean;
}

export interface DeveloperMarketplaceApp {
  id?: string;
  tenant_id?: string;
  name: string;
  slug?: string;
  app_type: DeveloperMarketplaceAppType | string;
  distribution: DeveloperMarketplaceAppDistribution | string;
  status: DeveloperMarketplaceAppStatus | string;
  owner_email?: string;
  support_email?: string;
  homepage_url?: string;
  privacy_url?: string;
  terms_url?: string;
  description?: string;
  scopes: string[];
  redirect_uris: string[];
  api_revisions: string[];
  webhook_topics: string[];
  test_mode: boolean;
  metadata?: Record<string, unknown>;
  review_notes?: string;
  submitted_at?: string | null;
  approved_at?: string | null;
  created_at?: string;
  updated_at?: string;
  review_checklist?: DeveloperMarketplaceReviewItem[];
}

export type DeveloperMarketplaceAppInput = Partial<
  Omit<
    DeveloperMarketplaceApp,
    "id" | "tenant_id" | "created_at" | "updated_at" | "review_checklist"
  >
> &
  Pick<DeveloperMarketplaceApp, "name" | "app_type" | "distribution" | "status">;

export interface DeveloperMarketplaceValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
  review_checklist?: DeveloperMarketplaceReviewItem[];
}

export interface DeveloperMarketplaceAppsResponse {
  items: DeveloperMarketplaceApp[];
}

export interface DeveloperMarketplaceCatalog {
  schema_version?: string;
  api_revisions?: Record<string, unknown>[];
  app_types?: Record<string, unknown>[];
  distributions?: Record<string, unknown>[];
  scopes?: string[];
  webhook_topics?: string[];
  webhook_catalog?: Record<string, unknown>[];
  sdk_policy?: Record<string, unknown>;
  oauth_runtime?: Record<string, unknown>;
  listing_review?: Record<string, unknown>;
  partner_levels?: string[];
  revocation_paths?: Record<string, string>;
  [key: string]: unknown;
}

export interface DeveloperMarketplaceOAuthClient {
  id?: string;
  tenant_id?: string;
  app_id?: string;
  client_id?: string;
  status: string;
  redirect_uris: string[];
  scopes: string[];
  created_at?: string;
  updated_at?: string;
  revoked_at?: string | null;
}

export interface DeveloperMarketplaceOAuthClientInput {
  status?: string;
  redirect_uris: string[];
  scopes: string[];
}

export interface DeveloperMarketplaceOAuthClientResponse {
  client: DeveloperMarketplaceOAuthClient;
  client_secret?: string;
}

export interface DeveloperMarketplaceOAuthClientsResponse {
  items: DeveloperMarketplaceOAuthClient[];
}

export interface DeveloperMarketplaceOAuthAuthorizeInput {
  response_type: "code";
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state: string;
  code_challenge: string;
  code_challenge_method: "S256";
  installed_by?: string;
}

export interface DeveloperMarketplaceInstallation {
  id?: string;
  tenant_id?: string;
  app_id: string;
  installed_by?: string;
  status: string;
  granted_scopes: string[];
  config?: Record<string, unknown>;
  installed_at?: string;
  updated_at?: string;
  revoked_at?: string | null;
}

export interface DeveloperMarketplaceOAuthAuthorizeResponse {
  code: string;
  state?: string;
  redirect_uri: string;
  redirect_url: string;
  app_id: string;
  installation_id: string;
  granted_scopes: string[];
  expires_at: string;
  installation: DeveloperMarketplaceInstallation;
}

export interface DeveloperMarketplaceOAuthTokenRequest {
  grant_type: "authorization_code";
  code: string;
  redirect_uri: string;
  client_id: string;
  client_secret: string;
  code_verifier: string;
}

export interface DeveloperMarketplaceOAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  app_id: string;
  installation_id: string;
  expires_at: string;
}

export interface DeveloperMarketplaceOAuthRevokeRequest {
  token: string;
  client_id?: string;
  client_secret?: string;
}

export interface DeveloperMarketplaceOAuthRevokeResponse {
  revoked: boolean;
  status: "revoked" | "not_found";
}

export interface DeveloperMarketplaceListing {
  id?: string;
  tenant_id?: string;
  app_id: string;
  slug?: string;
  name: string;
  category: string;
  summary?: string;
  docs_url?: string;
  support_url?: string;
  icon_url?: string;
  status: "draft" | "published" | "unlisted" | "archived";
  review_state: "draft" | "submitted" | "approved" | "rejected";
  partner_level?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export type DeveloperMarketplaceListingInput = Partial<
  Omit<DeveloperMarketplaceListing, "id" | "tenant_id" | "app_id" | "created_at" | "updated_at">
> &
  Pick<DeveloperMarketplaceListing, "name" | "category" | "status" | "review_state">;

export interface DeveloperMarketplaceListingsResponse {
  items: DeveloperMarketplaceListing[];
}

export interface DeveloperMarketplaceInstallationsResponse {
  items: DeveloperMarketplaceInstallation[];
}

export type DeveloperMarketplaceInstallationInput = Partial<
  Omit<
    DeveloperMarketplaceInstallation,
    "id" | "tenant_id" | "app_id" | "installed_at" | "updated_at" | "revoked_at"
  >
>;

export interface DeveloperMarketplaceWebhookSubscription {
  id?: string;
  tenant_id?: string;
  app_id?: string;
  installation_id?: string;
  endpoint_url: string;
  topics: string[];
  signing_secret_ref?: string;
  status: string;
  failure_count?: number;
  last_delivery_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export type DeveloperMarketplaceWebhookSubscriptionInput = Partial<
  Omit<
    DeveloperMarketplaceWebhookSubscription,
    "id" | "tenant_id" | "app_id" | "created_at" | "updated_at" | "failure_count" | "last_delivery_at"
  >
> &
  Pick<DeveloperMarketplaceWebhookSubscription, "endpoint_url" | "topics" | "status">;

export interface DeveloperMarketplaceWebhookSubscriptionsResponse {
  items: DeveloperMarketplaceWebhookSubscription[];
}

export interface DeveloperMarketplaceTestAccount {
  id?: string;
  tenant_id?: string;
  app_id?: string;
  name: string;
  status: string;
  sandbox_tenant_id?: string;
  seeded_resources?: Record<string, unknown>;
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type DeveloperMarketplaceTestAccountInput = Partial<
  Omit<DeveloperMarketplaceTestAccount, "id" | "tenant_id" | "app_id" | "created_at" | "updated_at">
> &
  Pick<DeveloperMarketplaceTestAccount, "name">;

export interface DeveloperMarketplaceTestAccountsResponse {
  items: DeveloperMarketplaceTestAccount[];
}

export interface DeveloperMarketplaceAuditLog {
  id: number;
  tenant_id?: string;
  app_id?: string;
  actor?: string;
  action: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface DeveloperMarketplaceAuditLogsResponse {
  items: DeveloperMarketplaceAuditLog[];
}

export type DeveloperMarketplacePartnerProfileType =
  | "technology"
  | "agency"
  | "consultant"
  | "affiliate";

export type DeveloperMarketplacePartnerProfileStatus =
  | "draft"
  | "submitted"
  | "certified"
  | "suspended"
  | "archived";

export type DeveloperMarketplacePartnerLevel =
  | "registered"
  | "certified"
  | "premier"
  | "elite";

export interface DeveloperMarketplacePartnerProfile {
  id?: string;
  tenant_id?: string;
  organization_name: string;
  profile_type: DeveloperMarketplacePartnerProfileType;
  status: DeveloperMarketplacePartnerProfileStatus;
  certification_level: DeveloperMarketplacePartnerLevel;
  regions?: string[];
  verticals?: string[];
  services?: string[];
  listing_url?: string;
  contact_email?: string;
  metadata?: Record<string, unknown>;
  review_notes?: string;
  created_at?: string;
  updated_at?: string;
}

export type DeveloperMarketplacePartnerProfileInput = Partial<
  Omit<
    DeveloperMarketplacePartnerProfile,
    "id" | "tenant_id" | "created_at" | "updated_at"
  >
> &
  Pick<DeveloperMarketplacePartnerProfile, "organization_name">;

export interface DeveloperMarketplacePartnerProfilesResponse {
  items: DeveloperMarketplacePartnerProfile[];
}

export interface DeveloperMarketplaceReviewDecisionInput {
  tenant_id: string;
  decision: "approve" | "reject";
  notes?: string;
  partner_level?: DeveloperMarketplacePartnerLevel;
}

export interface DeveloperMarketplacePartnerProfileReviewDecisionInput {
  decision: "approve" | "reject";
  notes?: string;
  partner_level?: DeveloperMarketplacePartnerLevel;
}

export interface DeveloperMarketplaceReviewQueueQuery {
  kind?: "all" | "app" | "listing" | "partner_profile";
  state?: "pending" | "resolved" | "all";
  limit?: number;
}

export interface DeveloperMarketplaceReviewQueueResponse {
  schema_version: string;
  generated_at: string;
  filter: {
    kind: "all" | "app" | "listing" | "partner_profile";
    state: "pending" | "resolved" | "all";
    limit: number;
  };
  counts: {
    total: number;
    apps: number;
    listings: number;
    profiles: number;
    pending: number;
    resolved: number;
  };
  items: Array<{
    kind: "app" | "listing" | "partner_profile";
    tenant_id: string;
    app_id: string;
    listing_id?: string;
    profile_id?: string;
    name: string;
    slug: string;
    app_type: string;
    distribution: string;
    app_status: string;
    listing_status?: string;
    profile_type?: DeveloperMarketplacePartnerProfileType;
    profile_status?: DeveloperMarketplacePartnerProfileStatus;
    review_state?: string;
    partner_level?: string;
    submitted_at?: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

export interface DeveloperMarketplaceMonitoringStatusCounts {
  total: number;
  active?: number;
  installed?: number;
  published?: number;
  submitted?: number;
  paused?: number;
  suspended?: number;
  revoked?: number;
  expired?: number;
}

export interface DeveloperMarketplaceMonitoringCheck {
  key: string;
  label: string;
  status: "pass" | "fail";
  severity: "blocker" | "warning";
  message?: string;
}

export interface DeveloperMarketplaceAPIRevisionWarning {
  revision: string;
  status: string;
  severity: "blocker" | "warning";
  message: string;
  sunset_at?: string;
}

export interface DeveloperMarketplaceAppMonitoringReport {
  schema_version: string;
  generated_at: string;
  ready: boolean;
  status: "ready" | "warning" | "blocked";
  app: Record<string, unknown>;
  listing?: DeveloperMarketplaceListing;
  counts: {
    oauth_clients: DeveloperMarketplaceMonitoringStatusCounts;
    installations: DeveloperMarketplaceMonitoringStatusCounts;
    webhook_subscriptions: DeveloperMarketplaceMonitoringStatusCounts;
    test_accounts: DeveloperMarketplaceMonitoringStatusCounts;
    access_tokens: DeveloperMarketplaceMonitoringStatusCounts;
    webhook_failures: number;
    last_delivery_at?: string | null;
    last_token_used_at?: string | null;
  };
  checks: DeveloperMarketplaceMonitoringCheck[];
  blockers?: string[];
  warnings?: string[];
  api_revision_warnings?: DeveloperMarketplaceAPIRevisionWarning[];
}

export class DeveloperMarketplaceResource extends Resource {
  catalog(): Promise<DeveloperMarketplaceCatalog> {
    return this.client.request("GET", "/api/v1/developer-marketplace/catalog");
  }

  validateApp(input: DeveloperMarketplaceAppInput): Promise<DeveloperMarketplaceValidationResult> {
    return this.client.request("POST", "/api/v1/developer-marketplace/apps/validate", {
      body: input,
    });
  }

  listApps(status?: string): Promise<DeveloperMarketplaceAppsResponse> {
    return this.client.request("GET", "/api/v1/developer-marketplace/apps", {
      query: { status },
    });
  }

  createApp(input: DeveloperMarketplaceAppInput): Promise<DeveloperMarketplaceApp> {
    return this.client.request("POST", "/api/v1/developer-marketplace/apps", {
      body: input,
    });
  }

  getApp(appId: string): Promise<DeveloperMarketplaceApp> {
    return this.client.request(
      "GET",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}`,
    );
  }

  updateApp(
    appId: string,
    input: DeveloperMarketplaceAppInput,
  ): Promise<DeveloperMarketplaceApp> {
    return this.client.request(
      "PATCH",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}`,
      { body: input },
    );
  }

  submitAppReview(appId: string): Promise<DeveloperMarketplaceApp> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/submit-review`,
    );
  }

  monitoring(appId: string): Promise<DeveloperMarketplaceAppMonitoringReport> {
    return this.client.request(
      "GET",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/monitoring`,
    );
  }

  listOAuthClients(appId: string): Promise<DeveloperMarketplaceOAuthClientsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/oauth-clients`,
    );
  }

  createOAuthClient(
    appId: string,
    input: DeveloperMarketplaceOAuthClientInput,
  ): Promise<DeveloperMarketplaceOAuthClientResponse> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/oauth-clients`,
      { body: input },
    );
  }

  revokeOAuthClient(
    appId: string,
    clientId: string,
  ): Promise<DeveloperMarketplaceOAuthClient> {
    return this.client.request(
      "DELETE",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/oauth-clients/${encodeURIComponent(clientId)}`,
    );
  }

  listTestAccounts(appId: string): Promise<DeveloperMarketplaceTestAccountsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/test-accounts`,
    );
  }

  createTestAccount(
    appId: string,
    input: DeveloperMarketplaceTestAccountInput,
  ): Promise<DeveloperMarketplaceTestAccount> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/test-accounts`,
      { body: input },
    );
  }

  listListings(category?: string): Promise<DeveloperMarketplaceListingsResponse> {
    return this.client.request("GET", "/api/v1/developer-marketplace/listings", {
      query: { category },
    });
  }

  upsertListing(
    appId: string,
    input: DeveloperMarketplaceListingInput,
  ): Promise<DeveloperMarketplaceListing> {
    return this.client.request(
      "PUT",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/listing`,
      { body: input },
    );
  }

  submitListingReview(appId: string): Promise<DeveloperMarketplaceListing> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/listing/submit-review`,
    );
  }

  listInstallations(status?: string): Promise<DeveloperMarketplaceInstallationsResponse> {
    return this.client.request("GET", "/api/v1/developer-marketplace/installations", {
      query: { status },
    });
  }

  installApp(
    appId: string,
    input: DeveloperMarketplaceInstallationInput,
  ): Promise<DeveloperMarketplaceInstallation> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/installations`,
      { body: input },
    );
  }

  revokeInstallation(installationId: string): Promise<DeveloperMarketplaceInstallation> {
    return this.client.request(
      "DELETE",
      `/api/v1/developer-marketplace/installations/${encodeURIComponent(installationId)}`,
    );
  }

  listWebhookSubscriptions(
    appId: string,
  ): Promise<DeveloperMarketplaceWebhookSubscriptionsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/webhook-subscriptions`,
    );
  }

  createWebhookSubscription(
    appId: string,
    input: DeveloperMarketplaceWebhookSubscriptionInput,
  ): Promise<DeveloperMarketplaceWebhookSubscription> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/apps/${encodeURIComponent(appId)}/webhook-subscriptions`,
      { body: input },
    );
  }

  listPartnerProfiles(
    profileType?: DeveloperMarketplacePartnerProfileType,
  ): Promise<DeveloperMarketplacePartnerProfilesResponse> {
    return this.client.request(
      "GET",
      "/api/v1/developer-marketplace/partner-profiles",
      { query: { profile_type: profileType } },
    );
  }

  upsertPartnerProfile(
    input: DeveloperMarketplacePartnerProfileInput,
  ): Promise<DeveloperMarketplacePartnerProfile> {
    return this.client.request(
      "PUT",
      "/api/v1/developer-marketplace/partner-profile",
      { body: input },
    );
  }

  submitPartnerProfileReview(): Promise<DeveloperMarketplacePartnerProfile> {
    return this.client.request(
      "POST",
      "/api/v1/developer-marketplace/partner-profile/submit-review",
    );
  }

  reviewQueue(
    reviewSecret: string,
    query: DeveloperMarketplaceReviewQueueQuery = {},
  ): Promise<DeveloperMarketplaceReviewQueueResponse> {
    return this.client.request(
      "GET",
      "/api/v1/developer-marketplace/review/queue",
      {
        query: {
          kind: query.kind,
          state: query.state,
          limit: query.limit,
        },
        headers: reviewHeaders(reviewSecret),
      },
    );
  }

  reviewAppDecision(
    appId: string,
    input: DeveloperMarketplaceReviewDecisionInput,
    reviewSecret: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/review/apps/${encodeURIComponent(appId)}/decision`,
      { body: input, headers: reviewHeaders(reviewSecret) },
    );
  }

  reviewListingDecision(
    appId: string,
    input: DeveloperMarketplaceReviewDecisionInput,
    reviewSecret: string,
  ): Promise<DeveloperMarketplaceListing> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/review/apps/${encodeURIComponent(appId)}/listing/decision`,
      { body: input, headers: reviewHeaders(reviewSecret) },
    );
  }

  reviewPartnerProfileDecision(
    tenantId: string,
    input: DeveloperMarketplacePartnerProfileReviewDecisionInput,
    reviewSecret: string,
  ): Promise<DeveloperMarketplacePartnerProfile> {
    return this.client.request(
      "POST",
      `/api/v1/developer-marketplace/review/partner-profiles/${encodeURIComponent(tenantId)}/decision`,
      { body: input, headers: reviewHeaders(reviewSecret) },
    );
  }

  authorize(
    input: DeveloperMarketplaceOAuthAuthorizeInput,
  ): Promise<DeveloperMarketplaceOAuthAuthorizeResponse> {
    return this.client.request(
      "POST",
      "/api/v1/developer-marketplace/oauth/authorize",
      { body: input },
    );
  }

  token(
    input: DeveloperMarketplaceOAuthTokenRequest,
  ): Promise<DeveloperMarketplaceOAuthTokenResponse> {
    return this.client.request(
      "POST",
      "/api/v1/developer-marketplace/oauth/token",
      { body: input, idempotencyKey: null },
    );
  }

  revoke(
    input: DeveloperMarketplaceOAuthRevokeRequest,
  ): Promise<DeveloperMarketplaceOAuthRevokeResponse> {
    return this.client.request(
      "POST",
      "/api/v1/developer-marketplace/oauth/revoke",
      { body: input, idempotencyKey: null },
    );
  }

  listAuditLogs(appId?: string): Promise<DeveloperMarketplaceAuditLogsResponse> {
    return this.client.request("GET", "/api/v1/developer-marketplace/audit-logs", {
      query: { app_id: appId },
    });
  }
}

function reviewHeaders(reviewSecret: string): Record<string, string> {
  return { "X-Postwave-Review-Secret": reviewSecret };
}
