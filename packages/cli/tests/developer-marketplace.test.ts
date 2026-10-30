// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/lib/client.js";
import {
  developerMarketplaceAppCreate,
  developerMarketplaceAppGet,
  developerMarketplaceAppMonitoring,
  developerMarketplaceAppSubmitReview,
  developerMarketplaceAppUpdate,
  developerMarketplaceAppValidate,
  developerMarketplaceAppsList,
  developerMarketplaceAuditLogsList,
  developerMarketplaceCatalog,
  developerMarketplaceInstallApp,
  developerMarketplaceInstallationRevoke,
  developerMarketplaceInstallationsList,
  developerMarketplaceListingSubmitReview,
  developerMarketplaceListingUpsert,
  developerMarketplaceListingsList,
  developerMarketplaceOAuthAuthorize,
  developerMarketplaceOAuthClientCreate,
  developerMarketplaceOAuthClientRevoke,
  developerMarketplaceOAuthClientsList,
  developerMarketplaceOAuthRevoke,
  developerMarketplaceOAuthToken,
  developerMarketplacePartnerProfileSubmitReview,
  developerMarketplacePartnerProfileUpsert,
  developerMarketplacePartnerProfilesList,
  developerMarketplaceReviewAppDecision,
  developerMarketplaceReviewListingDecision,
  developerMarketplaceReviewPartnerProfileDecision,
  developerMarketplaceReviewQueue,
  developerMarketplaceTestAccountCreate,
  developerMarketplaceTestAccountsList,
  developerMarketplaceWebhookCreate,
  developerMarketplaceWebhooksList,
  reviewQueueQueryFromOptions,
} from "../src/commands/developer-marketplace.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

function marketplaceResource() {
  return {
    catalog: vi.fn(async () => ({ schema_version: "developer_marketplace.v1" })),
    validateApp: vi.fn(async () => ({ valid: true })),
    listApps: vi.fn(async () => ({ items: [appFixture()] })),
    createApp: vi.fn(async () => appFixture()),
    getApp: vi.fn(async () => appFixture()),
    updateApp: vi.fn(async () => appFixture()),
    submitAppReview: vi.fn(async () => ({ ...appFixture(), status: "submitted" })),
    monitoring: vi.fn(async () => ({
      schema_version: "developer_marketplace.monitoring.v1",
      generated_at: "2026-06-17T00:00:00Z",
      ready: true,
      status: "ready",
      app: appFixture(),
      counts: {
        oauth_clients: { total: 1 },
        installations: { total: 1 },
        webhook_subscriptions: { total: 1 },
        test_accounts: { total: 1 },
        access_tokens: { total: 1 },
        webhook_failures: 0,
      },
      checks: [],
    })),
    listOAuthClients: vi.fn(async () => ({ items: [{ id: "oauth_client_1", status: "active", redirect_uris: [], scopes: [] }] })),
    createOAuthClient: vi.fn(async () => ({ client: { id: "oauth_client_1", status: "active", redirect_uris: [], scopes: [] }, client_secret: "secret" })),
    revokeOAuthClient: vi.fn(async () => ({ id: "oauth_client_1", status: "revoked", redirect_uris: [], scopes: [] })),
    listTestAccounts: vi.fn(async () => ({ items: [{ id: "test_1", name: "Sandbox", status: "active" }] })),
    createTestAccount: vi.fn(async () => ({ id: "test_1", name: "Sandbox", status: "active" })),
    listListings: vi.fn(async () => ({ items: [listingFixture()] })),
    upsertListing: vi.fn(async () => listingFixture()),
    submitListingReview: vi.fn(async () => ({ ...listingFixture(), review_state: "submitted" })),
    listInstallations: vi.fn(async () => ({ items: [{ id: "install_1", app_id: "app_1", status: "installed", granted_scopes: [] }] })),
    installApp: vi.fn(async () => ({ id: "install_1", app_id: "app_1", status: "installed", granted_scopes: [] })),
    revokeInstallation: vi.fn(async () => ({ id: "install_1", app_id: "app_1", status: "revoked", granted_scopes: [] })),
    listWebhookSubscriptions: vi.fn(async () => ({ items: [{ id: "wh_1", endpoint_url: "https://example.invalid/hook", topics: ["profile.created"], status: "active" }] })),
    createWebhookSubscription: vi.fn(async () => ({ id: "wh_1", endpoint_url: "https://example.invalid/hook", topics: ["profile.created"], status: "active" })),
    listPartnerProfiles: vi.fn(async () => ({ items: [profileFixture()] })),
    upsertPartnerProfile: vi.fn(async () => profileFixture()),
    submitPartnerProfileReview: vi.fn(async () => ({ ...profileFixture(), status: "submitted" })),
    reviewQueue: vi.fn(async () => ({ items: [{ kind: "app", app_id: "app_1", tenant_id: "tenant_1", name: "Inventory", app_status: "submitted", updated_at: "2026-06-17T00:00:00Z" }] })),
    reviewAppDecision: vi.fn(async () => ({ ok: true })),
    reviewListingDecision: vi.fn(async () => listingFixture()),
    reviewPartnerProfileDecision: vi.fn(async () => profileFixture()),
    authorize: vi.fn(async () => ({ code: "code_1", redirect_url: "https://partner.example/callback?code=code_1" })),
    token: vi.fn(async () => ({ access_token: "pw_at_1", token_type: "Bearer", expires_in: 3600, scope: "read:subscribers" })),
    revoke: vi.fn(async () => ({ revoked: true, status: "revoked" })),
    listAuditLogs: vi.fn(async () => ({ items: [{ id: 1, app_id: "app_1", action: "app.created", created_at: "2026-06-17T00:00:00Z" }] })),
  };
}

function appFixture() {
  return {
    id: "app_1",
    name: "Inventory Sync",
    slug: "inventory-sync",
    app_type: "public",
    distribution: "marketplace",
    status: "draft",
    scopes: ["read:subscribers"],
    redirect_uris: ["https://partner.example/callback"],
    api_revisions: ["2026-05-29"],
    webhook_topics: ["profile.created"],
    test_mode: true,
    updated_at: "2026-06-17T00:00:00Z",
  };
}

function listingFixture() {
  return {
    id: "listing_1",
    app_id: "app_1",
    name: "Inventory Sync",
    category: "ecommerce",
    status: "draft",
    review_state: "draft",
  };
}

function profileFixture() {
  return {
    id: "profile_1",
    tenant_id: "tenant_1",
    organization_name: "Example Agency",
    profile_type: "agency",
    status: "draft",
    certification_level: "registered",
  };
}

function mockClient() {
  const developerMarketplace = marketplaceResource();
  vi.mocked(createClient).mockReturnValue({
    developerMarketplace,
  } as unknown as ReturnType<typeof createClient>);
  return developerMarketplace;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env.POSTWAVE_MARKETPLACE_REVIEW_SECRET;
});

describe("developer marketplace CLI commands", () => {
  it("dispatches app, listing, installation, webhook, and audit commands", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dm = mockClient();
    const appPayload = '{"name":"Inventory Sync","app_type":"public","distribution":"marketplace","status":"draft"}';

    await developerMarketplaceCatalog({ output: "json" });
    await developerMarketplaceAppsList({ status: "draft", output: "json" });
    await developerMarketplaceAppValidate({ payload: appPayload, output: "json" });
    await developerMarketplaceAppCreate({ payload: appPayload, output: "json" });
    await developerMarketplaceAppGet("app/1", { output: "json" });
    await developerMarketplaceAppUpdate("app/1", { payload: appPayload, output: "json" });
    await developerMarketplaceAppSubmitReview("app/1", { output: "json" });
    await developerMarketplaceAppMonitoring("app/1", { output: "json" });
    await developerMarketplaceListingsList({ category: "ecommerce", output: "json" });
    await developerMarketplaceListingUpsert("app/1", {
      payload: '{"name":"Inventory Sync","category":"ecommerce","status":"draft","review_state":"draft"}',
      output: "json",
    });
    await developerMarketplaceListingSubmitReview("app/1", { output: "json" });
    await developerMarketplaceInstallationsList({ status: "installed", output: "json" });
    await developerMarketplaceInstallApp("app/1", {
      payload: '{"status":"installed","granted_scopes":["read:subscribers"]}',
      output: "json",
    });
    await developerMarketplaceInstallationRevoke("install/1", { output: "json" });
    await developerMarketplaceWebhooksList("app/1", { output: "json" });
    await developerMarketplaceWebhookCreate("app/1", {
      payload: '{"endpoint_url":"https://example.invalid/hook","topics":["profile.created"],"status":"active"}',
      output: "json",
    });
    await developerMarketplaceAuditLogsList("app/1", { output: "json" });

    expect(dm.catalog).toHaveBeenCalledTimes(1);
    expect(dm.listApps).toHaveBeenCalledWith("draft");
    expect(dm.validateApp).toHaveBeenCalledWith({
      name: "Inventory Sync",
      app_type: "public",
      distribution: "marketplace",
      status: "draft",
    });
    expect(dm.createApp).toHaveBeenCalledWith({
      name: "Inventory Sync",
      app_type: "public",
      distribution: "marketplace",
      status: "draft",
    });
    expect(dm.getApp).toHaveBeenCalledWith("app/1");
    expect(dm.updateApp).toHaveBeenCalledWith("app/1", {
      name: "Inventory Sync",
      app_type: "public",
      distribution: "marketplace",
      status: "draft",
    });
    expect(dm.submitAppReview).toHaveBeenCalledWith("app/1");
    expect(dm.monitoring).toHaveBeenCalledWith("app/1");
    expect(dm.listListings).toHaveBeenCalledWith("ecommerce");
    expect(dm.upsertListing).toHaveBeenCalledWith("app/1", {
      name: "Inventory Sync",
      category: "ecommerce",
      status: "draft",
      review_state: "draft",
    });
    expect(dm.submitListingReview).toHaveBeenCalledWith("app/1");
    expect(dm.listInstallations).toHaveBeenCalledWith("installed");
    expect(dm.installApp).toHaveBeenCalledWith("app/1", {
      status: "installed",
      granted_scopes: ["read:subscribers"],
    });
    expect(dm.revokeInstallation).toHaveBeenCalledWith("install/1");
    expect(dm.listWebhookSubscriptions).toHaveBeenCalledWith("app/1");
    expect(dm.createWebhookSubscription).toHaveBeenCalledWith("app/1", {
      endpoint_url: "https://example.invalid/hook",
      topics: ["profile.created"],
      status: "active",
    });
    expect(dm.listAuditLogs).toHaveBeenCalledWith("app/1");
  });

  it("dispatches OAuth clients, partner profiles, review, and OAuth runtime commands", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dm = mockClient();

    await developerMarketplaceOAuthClientsList("app/1", { output: "json" });
    await developerMarketplaceOAuthClientCreate("app/1", {
      payload: '{"redirect_uris":["https://partner.example/callback"],"scopes":["read:subscribers"]}',
      output: "json",
    });
    await developerMarketplaceOAuthClientRevoke("app/1", "client/1", { output: "json" });
    await developerMarketplaceTestAccountsList("app/1", { output: "json" });
    await developerMarketplaceTestAccountCreate("app/1", {
      payload: '{"name":"Sandbox","status":"active"}',
      output: "json",
    });
    await developerMarketplacePartnerProfilesList({ profileType: "agency", output: "json" });
    await developerMarketplacePartnerProfileUpsert({
      payload: '{"organization_name":"Example Agency","profile_type":"agency"}',
      output: "json",
    });
    await developerMarketplacePartnerProfileSubmitReview({ output: "json" });
    await developerMarketplaceReviewQueue({
      reviewSecret: "review-secret",
      kind: "partner_profile",
      limit: 25,
      output: "json",
    });
    await developerMarketplaceReviewAppDecision("app/1", {
      reviewSecret: "review-secret",
      tenantId: "tenant_1",
      decision: "approve",
      output: "json",
    });
    await developerMarketplaceReviewListingDecision("app/1", {
      reviewSecret: "review-secret",
      tenantId: "tenant_1",
      decision: "reject",
      notes: "Missing docs",
      output: "json",
    });
    await developerMarketplaceReviewPartnerProfileDecision("tenant_1", {
      reviewSecret: "review-secret",
      decision: "approve",
      partnerLevel: "premier",
      output: "json",
    });
    await developerMarketplaceOAuthAuthorize({
      payload: '{"response_type":"code","client_id":"client_1","redirect_uri":"https://partner.example/callback","state":"s","code_challenge":"c","code_challenge_method":"S256"}',
      output: "json",
    });
    await developerMarketplaceOAuthToken({
      payload: '{"grant_type":"authorization_code","code":"code_1","redirect_uri":"https://partner.example/callback","client_id":"client_1","client_secret":"secret","code_verifier":"verifier"}',
      output: "json",
    });
    await developerMarketplaceOAuthRevoke({
      payload: '{"token":"pw_at_1","client_id":"client_1","client_secret":"secret"}',
      output: "json",
    });

    expect(dm.listOAuthClients).toHaveBeenCalledWith("app/1");
    expect(dm.createOAuthClient).toHaveBeenCalledWith("app/1", {
      redirect_uris: ["https://partner.example/callback"],
      scopes: ["read:subscribers"],
    });
    expect(dm.revokeOAuthClient).toHaveBeenCalledWith("app/1", "client/1");
    expect(dm.listTestAccounts).toHaveBeenCalledWith("app/1");
    expect(dm.createTestAccount).toHaveBeenCalledWith("app/1", {
      name: "Sandbox",
      status: "active",
    });
    expect(dm.listPartnerProfiles).toHaveBeenCalledWith("agency");
    expect(dm.upsertPartnerProfile).toHaveBeenCalledWith({
      organization_name: "Example Agency",
      profile_type: "agency",
    });
    expect(dm.submitPartnerProfileReview).toHaveBeenCalledTimes(1);
    expect(dm.reviewQueue).toHaveBeenCalledWith("review-secret", {
      kind: "partner_profile",
      limit: 25,
    });
    expect(dm.reviewAppDecision).toHaveBeenCalledWith("app/1", {
      tenant_id: "tenant_1",
      decision: "approve",
    }, "review-secret");
    expect(dm.reviewListingDecision).toHaveBeenCalledWith("app/1", {
      tenant_id: "tenant_1",
      decision: "reject",
      notes: "Missing docs",
    }, "review-secret");
    expect(dm.reviewPartnerProfileDecision).toHaveBeenCalledWith("tenant_1", {
      decision: "approve",
      partner_level: "premier",
    }, "review-secret");
    expect(dm.authorize).toHaveBeenCalledWith({
      response_type: "code",
      client_id: "client_1",
      redirect_uri: "https://partner.example/callback",
      state: "s",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
    expect(dm.token).toHaveBeenCalledWith({
      grant_type: "authorization_code",
      code: "code_1",
      redirect_uri: "https://partner.example/callback",
      client_id: "client_1",
      client_secret: "secret",
      code_verifier: "verifier",
    });
    expect(dm.revoke).toHaveBeenCalledWith({
      token: "pw_at_1",
      client_id: "client_1",
      client_secret: "secret",
    });
  });

  it("builds review query filters and supports review secret from the environment", async () => {
    expect(reviewQueueQueryFromOptions({ kind: "app", state: "all", limit: "50" })).toEqual({
      kind: "app",
      state: "all",
      limit: 50,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.POSTWAVE_MARKETPLACE_REVIEW_SECRET = "env-review-secret";
    const dm = mockClient();

    await developerMarketplaceReviewQueue({ output: "json" });

    expect(dm.reviewQueue).toHaveBeenCalledWith("env-review-secret", {});
  });
});
