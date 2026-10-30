// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { developerMarketplaceTools } from "../../src/tools/developer-marketplace.js";

function makeClient() {
  const developerMarketplace = {
    catalog: vi.fn().mockResolvedValue({ schema_version: "developer_marketplace.v1" }),
    validateApp: vi.fn().mockResolvedValue({ valid: true }),
    listApps: vi.fn().mockResolvedValue({ items: [] }),
    createApp: vi.fn().mockResolvedValue({ id: "app_1" }),
    getApp: vi.fn().mockResolvedValue({ id: "app_1" }),
    updateApp: vi.fn().mockResolvedValue({ id: "app_1" }),
    submitAppReview: vi.fn().mockResolvedValue({ id: "app_1", status: "submitted" }),
    monitoring: vi.fn().mockResolvedValue({ ready: true, status: "ready" }),
    listOAuthClients: vi.fn().mockResolvedValue({ items: [] }),
    createOAuthClient: vi.fn().mockResolvedValue({ client: { id: "client_1" }, client_secret: "secret" }),
    revokeOAuthClient: vi.fn().mockResolvedValue({ id: "client_1", status: "revoked" }),
    listTestAccounts: vi.fn().mockResolvedValue({ items: [] }),
    createTestAccount: vi.fn().mockResolvedValue({ id: "test_1" }),
    listListings: vi.fn().mockResolvedValue({ items: [] }),
    upsertListing: vi.fn().mockResolvedValue({ id: "listing_1" }),
    submitListingReview: vi.fn().mockResolvedValue({ id: "listing_1", review_state: "submitted" }),
    listInstallations: vi.fn().mockResolvedValue({ items: [] }),
    installApp: vi.fn().mockResolvedValue({ id: "install_1" }),
    revokeInstallation: vi.fn().mockResolvedValue({ id: "install_1", status: "revoked" }),
    listWebhookSubscriptions: vi.fn().mockResolvedValue({ items: [] }),
    createWebhookSubscription: vi.fn().mockResolvedValue({ id: "wh_1" }),
    listPartnerProfiles: vi.fn().mockResolvedValue({ items: [] }),
    upsertPartnerProfile: vi.fn().mockResolvedValue({ id: "profile_1" }),
    submitPartnerProfileReview: vi.fn().mockResolvedValue({ id: "profile_1" }),
    reviewQueue: vi.fn().mockResolvedValue({ items: [] }),
    reviewAppDecision: vi.fn().mockResolvedValue({ ok: true }),
    reviewListingDecision: vi.fn().mockResolvedValue({ id: "listing_1" }),
    reviewPartnerProfileDecision: vi.fn().mockResolvedValue({ id: "profile_1" }),
    authorize: vi.fn().mockResolvedValue({ code: "code_1" }),
    token: vi.fn().mockResolvedValue({ access_token: "pw_at_1" }),
    revoke: vi.fn().mockResolvedValue({ revoked: true }),
    listAuditLogs: vi.fn().mockResolvedValue({ items: [] }),
  };
  return { client: { developerMarketplace }, developerMarketplace };
}

describe("developerMarketplaceTools", () => {
  it("exposes the developer marketplace MCP tool surface", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = developerMarketplaceTools(client as any);
    expect(tools.map((t) => t.name)).toEqual([
      "developer_marketplace_catalog",
      "developer_marketplace_app_validate",
      "developer_marketplace_app_list",
      "developer_marketplace_app_create",
      "developer_marketplace_app_get",
      "developer_marketplace_app_update",
      "developer_marketplace_app_submit_review",
      "developer_marketplace_app_monitoring",
      "developer_marketplace_oauth_client_list",
      "developer_marketplace_oauth_client_create",
      "developer_marketplace_oauth_client_revoke",
      "developer_marketplace_test_account_list",
      "developer_marketplace_test_account_create",
      "developer_marketplace_listing_list",
      "developer_marketplace_listing_upsert",
      "developer_marketplace_listing_submit_review",
      "developer_marketplace_installation_list",
      "developer_marketplace_installation_create",
      "developer_marketplace_installation_revoke",
      "developer_marketplace_webhook_list",
      "developer_marketplace_webhook_create",
      "developer_marketplace_partner_profile_list",
      "developer_marketplace_partner_profile_upsert",
      "developer_marketplace_partner_profile_submit_review",
      "developer_marketplace_review_queue",
      "developer_marketplace_review_app_decision",
      "developer_marketplace_review_listing_decision",
      "developer_marketplace_review_partner_profile_decision",
      "developer_marketplace_oauth_authorize",
      "developer_marketplace_oauth_token",
      "developer_marketplace_oauth_revoke",
      "developer_marketplace_audit_logs_list",
    ]);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodObject);
  });

  it("dispatches marketplace app, listing, install, webhook, partner, review, OAuth, and audit tools", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = developerMarketplaceTools(c.client as any);
    const find = (name: string) => tools.find((t) => t.name === name)!;

    await find("developer_marketplace_catalog").handler({});
    await find("developer_marketplace_app_validate").handler({ payload: { name: "Inventory" } });
    await find("developer_marketplace_app_list").handler({ status: "draft" });
    await find("developer_marketplace_app_create").handler({ payload: { name: "Inventory" } });
    await find("developer_marketplace_app_get").handler({ app_id: "app/1" });
    await find("developer_marketplace_app_update").handler({ app_id: "app/1", payload: { status: "draft" } });
    await find("developer_marketplace_app_submit_review").handler({ app_id: "app/1" });
    await find("developer_marketplace_app_monitoring").handler({ app_id: "app/1" });
    await find("developer_marketplace_oauth_client_list").handler({ app_id: "app/1" });
    await find("developer_marketplace_oauth_client_create").handler({ app_id: "app/1", payload: { redirect_uris: ["https://partner.example/callback"], scopes: ["read:subscribers"] } });
    await find("developer_marketplace_oauth_client_revoke").handler({ app_id: "app/1", client_id: "client/1" });
    await find("developer_marketplace_test_account_list").handler({ app_id: "app/1" });
    await find("developer_marketplace_test_account_create").handler({ app_id: "app/1", payload: { name: "Sandbox" } });
    await find("developer_marketplace_listing_list").handler({ category: "ecommerce" });
    await find("developer_marketplace_listing_upsert").handler({ app_id: "app/1", payload: { name: "Inventory" } });
    await find("developer_marketplace_listing_submit_review").handler({ app_id: "app/1" });
    await find("developer_marketplace_installation_list").handler({ status: "installed" });
    await find("developer_marketplace_installation_create").handler({ app_id: "app/1", payload: { status: "installed" } });
    await find("developer_marketplace_installation_revoke").handler({ installation_id: "install/1" });
    await find("developer_marketplace_webhook_list").handler({ app_id: "app/1" });
    await find("developer_marketplace_webhook_create").handler({ app_id: "app/1", payload: { endpoint_url: "https://example.invalid/hook", topics: ["profile.created"], status: "active" } });
    await find("developer_marketplace_partner_profile_list").handler({ profile_type: "agency" });
    await find("developer_marketplace_partner_profile_upsert").handler({ payload: { organization_name: "Example Agency" } });
    await find("developer_marketplace_partner_profile_submit_review").handler({});
    await find("developer_marketplace_review_queue").handler({ review_secret: "review-secret", kind: "app", limit: 25 });
    await find("developer_marketplace_review_app_decision").handler({ review_secret: "review-secret", app_id: "app/1", tenant_id: "tenant_1", decision: "approve" });
    await find("developer_marketplace_review_listing_decision").handler({ review_secret: "review-secret", app_id: "app/1", tenant_id: "tenant_1", decision: "reject", notes: "Missing docs" });
    await find("developer_marketplace_review_partner_profile_decision").handler({ review_secret: "review-secret", tenant_id: "tenant_1", decision: "approve", partner_level: "premier" });
    await find("developer_marketplace_oauth_authorize").handler({ payload: { response_type: "code", client_id: "client_1" } });
    await find("developer_marketplace_oauth_token").handler({ payload: { grant_type: "authorization_code", code: "code_1" } });
    await find("developer_marketplace_oauth_revoke").handler({ payload: { token: "pw_at_1" } });
    await find("developer_marketplace_audit_logs_list").handler({ app_id: "app/1" });

    expect(c.developerMarketplace.catalog).toHaveBeenCalledTimes(1);
    expect(c.developerMarketplace.validateApp).toHaveBeenCalledWith({ name: "Inventory" });
    expect(c.developerMarketplace.listApps).toHaveBeenCalledWith("draft");
    expect(c.developerMarketplace.createApp).toHaveBeenCalledWith({ name: "Inventory" });
    expect(c.developerMarketplace.getApp).toHaveBeenCalledWith("app/1");
    expect(c.developerMarketplace.updateApp).toHaveBeenCalledWith("app/1", { status: "draft" });
    expect(c.developerMarketplace.submitAppReview).toHaveBeenCalledWith("app/1");
    expect(c.developerMarketplace.monitoring).toHaveBeenCalledWith("app/1");
    expect(c.developerMarketplace.createOAuthClient).toHaveBeenCalledWith("app/1", { redirect_uris: ["https://partner.example/callback"], scopes: ["read:subscribers"] });
    expect(c.developerMarketplace.revokeOAuthClient).toHaveBeenCalledWith("app/1", "client/1");
    expect(c.developerMarketplace.createTestAccount).toHaveBeenCalledWith("app/1", { name: "Sandbox" });
    expect(c.developerMarketplace.listListings).toHaveBeenCalledWith("ecommerce");
    expect(c.developerMarketplace.upsertListing).toHaveBeenCalledWith("app/1", { name: "Inventory" });
    expect(c.developerMarketplace.installApp).toHaveBeenCalledWith("app/1", { status: "installed" });
    expect(c.developerMarketplace.revokeInstallation).toHaveBeenCalledWith("install/1");
    expect(c.developerMarketplace.createWebhookSubscription).toHaveBeenCalledWith("app/1", { endpoint_url: "https://example.invalid/hook", topics: ["profile.created"], status: "active" });
    expect(c.developerMarketplace.listPartnerProfiles).toHaveBeenCalledWith("agency");
    expect(c.developerMarketplace.upsertPartnerProfile).toHaveBeenCalledWith({ organization_name: "Example Agency" });
    expect(c.developerMarketplace.reviewQueue).toHaveBeenCalledWith("review-secret", { kind: "app", state: undefined, limit: 25 });
    expect(c.developerMarketplace.reviewAppDecision).toHaveBeenCalledWith("app/1", { tenant_id: "tenant_1", decision: "approve" }, "review-secret");
    expect(c.developerMarketplace.reviewListingDecision).toHaveBeenCalledWith("app/1", { tenant_id: "tenant_1", decision: "reject", notes: "Missing docs" }, "review-secret");
    expect(c.developerMarketplace.reviewPartnerProfileDecision).toHaveBeenCalledWith("tenant_1", { decision: "approve", partner_level: "premier" }, "review-secret");
    expect(c.developerMarketplace.authorize).toHaveBeenCalledWith({ response_type: "code", client_id: "client_1" });
    expect(c.developerMarketplace.token).toHaveBeenCalledWith({ grant_type: "authorization_code", code: "code_1" });
    expect(c.developerMarketplace.revoke).toHaveBeenCalledWith({ token: "pw_at_1" });
    expect(c.developerMarketplace.listAuditLogs).toHaveBeenCalledWith("app/1");
  });
});
