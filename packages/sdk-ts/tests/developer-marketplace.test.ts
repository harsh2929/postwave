import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DeveloperMarketplaceResource", () => {
  it("routes OAuth runtime calls to the canonical marketplace endpoints", async () => {
    const seen: Array<{
      url: string;
      method?: string;
      body?: unknown;
      reviewSecret?: string;
      idempotencyKey?: string;
    }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        reviewSecret: headers?.["X-Postwave-Review-Secret"],
        idempotencyKey: headers?.["Idempotency-Key"],
      });
      return json({
        code: "pw_code_123",
        redirect_uri: "https://partner.example/oauth/callback",
        redirect_url: "https://partner.example/oauth/callback?code=pw_code_123",
        app_id: "app_123",
        installation_id: "inst_123",
        granted_scopes: ["profiles:read"],
        expires_at: "2026-06-16T00:00:00Z",
        installation: {
          app_id: "app_123",
          status: "installed",
          granted_scopes: ["profiles:read"],
        },
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.developerMarketplace.catalog();
    await pw.developerMarketplace.validateApp({
      name: "Inventory Sync",
      slug: "inventory-sync",
      app_type: "public",
      distribution: "marketplace",
      status: "draft",
      scopes: ["read:subscribers"],
      redirect_uris: ["https://partner.example/oauth/callback"],
      api_revisions: ["2026-05-29"],
      webhook_topics: ["profile.created"],
      test_mode: true,
    });
    await pw.developerMarketplace.listApps("draft");
    await pw.developerMarketplace.createApp({
      name: "Inventory Sync",
      slug: "inventory-sync",
      app_type: "public",
      distribution: "marketplace",
      status: "draft",
      scopes: ["read:subscribers"],
      redirect_uris: ["https://partner.example/oauth/callback"],
      api_revisions: ["2026-05-29"],
      webhook_topics: ["profile.created"],
      test_mode: true,
    });
    await pw.developerMarketplace.getApp("app/123");
    await pw.developerMarketplace.updateApp("app/123", {
      name: "Inventory Sync",
      app_type: "public",
      distribution: "marketplace",
      status: "draft",
      scopes: ["read:subscribers"],
      redirect_uris: ["https://partner.example/oauth/callback"],
      api_revisions: ["2026-05-29"],
      webhook_topics: ["profile.created"],
      test_mode: true,
    });
    await pw.developerMarketplace.submitAppReview("app/123");
    await pw.developerMarketplace.monitoring("app/123");
    await pw.developerMarketplace.listOAuthClients("app/123");
    await pw.developerMarketplace.createOAuthClient("app/123", {
      redirect_uris: ["https://partner.example/oauth/callback"],
      scopes: ["read:subscribers"],
    });
    await pw.developerMarketplace.revokeOAuthClient("app/123", "client/123");
    await pw.developerMarketplace.listTestAccounts("app/123");
    await pw.developerMarketplace.createTestAccount("app/123", {
      name: "Partner sandbox",
      status: "active",
    });
    await pw.developerMarketplace.listListings("ecommerce");
    await pw.developerMarketplace.upsertListing("app/123", {
      name: "Inventory Sync",
      category: "ecommerce",
      status: "draft",
      review_state: "draft",
    });
    await pw.developerMarketplace.submitListingReview("app/123");
    await pw.developerMarketplace.listInstallations("installed");
    await pw.developerMarketplace.installApp("app/123", {
      installed_by: "ada@example.com",
      status: "installed",
      granted_scopes: ["read:subscribers"],
    });
    await pw.developerMarketplace.revokeInstallation("install/123");
    await pw.developerMarketplace.listWebhookSubscriptions("app/123");
    await pw.developerMarketplace.createWebhookSubscription("app/123", {
      endpoint_url: "https://partner.example/postwave",
      topics: ["profile.created"],
      status: "active",
    });
    await pw.developerMarketplace.listPartnerProfiles("agency");
    await pw.developerMarketplace.upsertPartnerProfile({
      organization_name: "Example Agency",
      profile_type: "agency",
    });
    await pw.developerMarketplace.submitPartnerProfileReview();
    await pw.developerMarketplace.reviewQueue("review-secret", {
      kind: "partner_profile",
      limit: 25,
    });
    await pw.developerMarketplace.reviewAppDecision(
      "app/123",
      {
        tenant_id: "00000000-0000-0000-0000-000000000000",
        decision: "approve",
      },
      "review-secret",
    );
    await pw.developerMarketplace.reviewListingDecision(
      "app/123",
      {
        tenant_id: "00000000-0000-0000-0000-000000000000",
        decision: "approve",
        partner_level: "certified",
      },
      "review-secret",
    );
    await pw.developerMarketplace.reviewPartnerProfileDecision(
      "tenant/123",
      {
        decision: "approve",
        partner_level: "premier",
      },
      "review-secret",
    );
    await pw.developerMarketplace.listAuditLogs("app/123");
    await pw.developerMarketplace.authorize({
      response_type: "code",
      client_id: "pw_oac_123",
      redirect_uri: "https://partner.example/oauth/callback",
      state: "st_123",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    });
    await pw.developerMarketplace.token({
      grant_type: "authorization_code",
      code: "pw_code_123",
      redirect_uri: "https://partner.example/oauth/callback",
      client_id: "pw_oac_123",
      client_secret: "pw_oas_secret",
      code_verifier: "verifier",
    });
    await pw.developerMarketplace.revoke({
      token: "pw_at_123",
      client_id: "pw_oac_123",
      client_secret: "pw_oas_secret",
    });

    const routeMap = seen.map(({ idempotencyKey: _idempotencyKey, ...entry }) => entry);
    expect(routeMap).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/catalog",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/validate",
        method: "POST",
        body: {
          name: "Inventory Sync",
          slug: "inventory-sync",
          app_type: "public",
          distribution: "marketplace",
          status: "draft",
          scopes: ["read:subscribers"],
          redirect_uris: ["https://partner.example/oauth/callback"],
          api_revisions: ["2026-05-29"],
          webhook_topics: ["profile.created"],
          test_mode: true,
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps?status=draft",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps",
        method: "POST",
        body: {
          name: "Inventory Sync",
          slug: "inventory-sync",
          app_type: "public",
          distribution: "marketplace",
          status: "draft",
          scopes: ["read:subscribers"],
          redirect_uris: ["https://partner.example/oauth/callback"],
          api_revisions: ["2026-05-29"],
          webhook_topics: ["profile.created"],
          test_mode: true,
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123",
        method: "PATCH",
        body: {
          name: "Inventory Sync",
          app_type: "public",
          distribution: "marketplace",
          status: "draft",
          scopes: ["read:subscribers"],
          redirect_uris: ["https://partner.example/oauth/callback"],
          api_revisions: ["2026-05-29"],
          webhook_topics: ["profile.created"],
          test_mode: true,
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/submit-review",
        method: "POST",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/monitoring",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/oauth-clients",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/oauth-clients",
        method: "POST",
        body: {
          redirect_uris: ["https://partner.example/oauth/callback"],
          scopes: ["read:subscribers"],
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/oauth-clients/client%2F123",
        method: "DELETE",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/test-accounts",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/test-accounts",
        method: "POST",
        body: {
          name: "Partner sandbox",
          status: "active",
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/listings?category=ecommerce",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/listing",
        method: "PUT",
        body: {
          name: "Inventory Sync",
          category: "ecommerce",
          status: "draft",
          review_state: "draft",
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/listing/submit-review",
        method: "POST",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/installations?status=installed",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/installations",
        method: "POST",
        body: {
          installed_by: "ada@example.com",
          status: "installed",
          granted_scopes: ["read:subscribers"],
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/installations/install%2F123",
        method: "DELETE",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/webhook-subscriptions",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/apps/app%2F123/webhook-subscriptions",
        method: "POST",
        body: {
          endpoint_url: "https://partner.example/postwave",
          topics: ["profile.created"],
          status: "active",
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/partner-profiles?profile_type=agency",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/partner-profile",
        method: "PUT",
        body: {
          organization_name: "Example Agency",
          profile_type: "agency",
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/partner-profile/submit-review",
        method: "POST",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/review/queue?kind=partner_profile&limit=25",
        method: "GET",
        body: undefined,
        reviewSecret: "review-secret",
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/review/apps/app%2F123/decision",
        method: "POST",
        body: {
          tenant_id: "00000000-0000-0000-0000-000000000000",
          decision: "approve",
        },
        reviewSecret: "review-secret",
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/review/apps/app%2F123/listing/decision",
        method: "POST",
        body: {
          tenant_id: "00000000-0000-0000-0000-000000000000",
          decision: "approve",
          partner_level: "certified",
        },
        reviewSecret: "review-secret",
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/review/partner-profiles/tenant%2F123/decision",
        method: "POST",
        body: {
          decision: "approve",
          partner_level: "premier",
        },
        reviewSecret: "review-secret",
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/audit-logs?app_id=app%2F123",
        method: "GET",
        body: undefined,
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/oauth/authorize",
        method: "POST",
        body: {
          response_type: "code",
          client_id: "pw_oac_123",
          redirect_uri: "https://partner.example/oauth/callback",
          state: "st_123",
          code_challenge: "challenge",
          code_challenge_method: "S256",
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/oauth/token",
        method: "POST",
        body: {
          grant_type: "authorization_code",
          code: "pw_code_123",
          redirect_uri: "https://partner.example/oauth/callback",
          client_id: "pw_oac_123",
          client_secret: "pw_oas_secret",
          code_verifier: "verifier",
        },
        reviewSecret: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/developer-marketplace/oauth/revoke",
        method: "POST",
        body: {
          token: "pw_at_123",
          client_id: "pw_oac_123",
          client_secret: "pw_oas_secret",
        },
        reviewSecret: undefined,
      },
    ]);
    expect(seen.at(-2)?.idempotencyKey).toBeUndefined();
    expect(seen.at(-1)?.idempotencyKey).toBeUndefined();
  });
});
