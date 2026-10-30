import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NativeIntegrationsResource", () => {
  it("routes native subscription calls with canonical lifecycle payloads", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: "conn/1", status: "ok", items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.subscriptions.providers();
    await pw.nativeIntegrations.subscriptions.list();
    await pw.nativeIntegrations.subscriptions.create({
      provider: "recharge",
      name: "Recharge production",
      credentials_ref: "vault://subscriptions/recharge",
      settings: { store_domain: "acme.myshopify.com" },
    });
    await pw.nativeIntegrations.subscriptions.get("subscription/1");
    await pw.nativeIntegrations.subscriptions.sync("subscription/1", {
      cursor: "sub_cursor_1",
      subscriptions: [{ email: "ada@example.com", subscription_id: "sub_123" }],
      shipments: [{ email: "ada@example.com", tracking_number: "trk_123" }],
      events: [
        { email: "ada@example.com", event_name: "subscription.renewed" },
      ],
    });
    await pw.nativeIntegrations.subscriptions.backfill("subscription/1", {
      subscriptions: [{ email: "lin@example.com", subscription_id: "sub_456" }],
    });
    await pw.nativeIntegrations.subscriptions.ingest("subscription/1", {
      email: "grace@example.com",
      event_name: "shipment.delivered",
    });
    await pw.nativeIntegrations.subscriptions.pause("subscription/1");
    await pw.nativeIntegrations.subscriptions.disconnect("subscription/1");
    await pw.nativeIntegrations.subscriptions.acknowledgeProviderCleanup(
      "subscription/1",
      {
        completed_actions: ["api_token_revoked_or_rotated"],
        notes: "Verified in Recharge console.",
      },
    );
    await pw.nativeIntegrations.subscriptions.runs("subscription/1", 10);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations",
        method: "POST",
        body: {
          provider: "recharge",
          name: "Recharge production",
          credentials_ref: "vault://subscriptions/recharge",
          settings: { store_domain: "acme.myshopify.com" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/sync",
        method: "POST",
        body: {
          cursor: "sub_cursor_1",
          subscriptions: [
            { email: "ada@example.com", subscription_id: "sub_123" },
          ],
          shipments: [{ email: "ada@example.com", tracking_number: "trk_123" }],
          events: [
            { email: "ada@example.com", event_name: "subscription.renewed" },
          ],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/backfill",
        method: "POST",
        body: {
          subscriptions: [
            { email: "lin@example.com", subscription_id: "sub_456" },
          ],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/ingest",
        method: "POST",
        body: { email: "grace@example.com", event_name: "shipment.delivered" },
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/provider-cleanup/acknowledge",
        method: "POST",
        body: {
          completed_actions: ["api_token_revoked_or_rotated"],
          notes: "Verified in Recharge console.",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/runs?limit=10",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("routes native marketing calls without ingest support", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: "marketing/1", status: "partial", items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.marketing.providers();
    await pw.nativeIntegrations.marketing.list();
    await pw.nativeIntegrations.marketing.klaviyoOAuthAvailability();
    const klaviyoOAuthStart =
      pw.nativeIntegrations.marketing.klaviyoOAuthStartUrl({
        name: "Klaviyo production",
        redirect_to: "/app/integrations",
        klaviyo_webhook_managed_by_postwave: true,
      });
    await pw.nativeIntegrations.marketing.create({
      provider: "mailerlite",
      name: "MailerLite production",
      credentials_ref: "vault://marketing/mailerlite",
      settings: { workspace_id: "workspace_123" },
    });
    await pw.nativeIntegrations.marketing.get("marketing/1");
    await pw.nativeIntegrations.marketing.sync("marketing/1", {
      cursor: "mailerlite_cursor_1",
      metadata: { import_cursor: "subscribers:500" },
    });
    await pw.nativeIntegrations.marketing.backfill("marketing/1", {
      run_mode: "backfill",
    });
    expect(() =>
      pw.nativeIntegrations.marketing.ingest("marketing/1", {
        email: "ada@example.com",
      }),
    ).toThrow(/does not support ingest/);
    await pw.nativeIntegrations.marketing.pause("marketing/1");
    await pw.nativeIntegrations.marketing.disconnect("marketing/1");
    await pw.nativeIntegrations.marketing.acknowledgeProviderCleanup(
      "marketing/1",
      {
        completed_actions: ["private_api_key_revoked_or_rotated"],
        notes: "Verified in Klaviyo",
      },
    );
    await pw.nativeIntegrations.marketing.runs("marketing/1", 10);

    expect(klaviyoOAuthStart).toBe(
      "/api/v1/marketing-integrations/klaviyo/oauth/start?name=Klaviyo+production&redirect_to=%2Fapp%2Fintegrations&klaviyo_webhook_managed_by_postwave=true",
    );
    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/klaviyo/oauth/availability",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations",
        method: "POST",
        body: {
          provider: "mailerlite",
          name: "MailerLite production",
          credentials_ref: "vault://marketing/mailerlite",
          settings: { workspace_id: "workspace_123" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/marketing%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/marketing%2F1/sync",
        method: "POST",
        body: {
          cursor: "mailerlite_cursor_1",
          metadata: { import_cursor: "subscribers:500" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/marketing%2F1/backfill",
        method: "POST",
        body: { run_mode: "backfill" },
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/marketing%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/marketing%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/marketing%2F1/provider-cleanup/acknowledge",
        method: "POST",
        body: {
          completed_actions: ["private_api_key_revoked_or_rotated"],
          notes: "Verified in Klaviyo",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/marketing-integrations/marketing%2F1/runs?limit=10",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("routes native lead calls with canonical submission payloads", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: "lead/1", status: "completed", items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.lead.providers();
    await pw.nativeIntegrations.lead.list();
    await pw.nativeIntegrations.lead.create({
      provider: "typeform",
      name: "Typeform leads",
      credentials_ref: "vault://lead/typeform",
      settings: { form_id: "form_123" },
    });
    await pw.nativeIntegrations.lead.get("lead/1");
    await pw.nativeIntegrations.lead.sync("lead/1", {
      cursor: "lead_cursor_1",
      submissions: [{ email: "ada@example.com", form_id: "form_123" }],
    });
    await pw.nativeIntegrations.lead.backfill("lead/1", {
      submissions: [{ email: "lin@example.com", form_id: "form_123" }],
    });
    await pw.nativeIntegrations.lead.ingest("lead/1", {
      email: "grace@example.com",
      source_id: "evt_1",
    });
    await pw.nativeIntegrations.lead.pause("lead/1");
    await pw.nativeIntegrations.lead.disconnect("lead/1");
    await pw.nativeIntegrations.lead.runs("lead/1", 10);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations",
        method: "POST",
        body: {
          provider: "typeform",
          name: "Typeform leads",
          credentials_ref: "vault://lead/typeform",
          settings: { form_id: "form_123" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1/sync",
        method: "POST",
        body: {
          cursor: "lead_cursor_1",
          submissions: [{ email: "ada@example.com", form_id: "form_123" }],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1/backfill",
        method: "POST",
        body: {
          submissions: [{ email: "lin@example.com", form_id: "form_123" }],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1/ingest",
        method: "POST",
        body: { email: "grace@example.com", source_id: "evt_1" },
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1/runs?limit=10",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("routes native lead provider pulls with empty payloads", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ integration_id: "lead/1", status: "completed" });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.lead.sync("lead/1", {
      cursor: "webflow_cursor_1",
    });
    await pw.nativeIntegrations.lead.backfill("lead/1", {});

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1/sync",
        method: "POST",
        body: { cursor: "webflow_cursor_1" },
      },
      {
        url: "https://api.moosewave.com/api/v1/lead-integrations/lead%2F1/backfill",
        method: "POST",
        body: {},
      },
    ]);
  });

  it("routes native CRM calls with canonical import payloads", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (
        url === "https://api.moosewave.com/api/v1/crm/integrations/crm%2F1" &&
        init?.method === "DELETE"
      ) {
        return json({
          ok: true,
          provider_cleanup: {
            provider: "hubspot",
            status: "operator_action_required",
            postwave_status: "disconnected",
            provider_cleanup_posture:
              "mixed_postwave_oauth_operator_hubspot_console",
            managed_provider_cleanup: false,
            webhook_cleanup_status:
              "app_level_webhook_subscription_shared_no_per_tenant_cleanup",
            credential_cleanup_status:
              "operator_revoke_or_rotate_hubspot_private_app_token_if_no_longer_used",
          },
        });
      }
      return json({ id: "crm/1", status: "completed", items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.crm.providers();
    await pw.nativeIntegrations.crm.list();
    await pw.nativeIntegrations.crm.oauthAvailability("salesforce");
    const salesforceOAuthStart = pw.nativeIntegrations.crm.oauthStartUrl(
      "salesforce",
      {
        name: "Salesforce production",
        sync_tasks: false,
        redirect_to: "/app/integrations",
      },
    );
    await pw.nativeIntegrations.crm.create({
      provider: "hubspot",
      name: "HubSpot production",
      credentials_ref: "vault://crm/hubspot",
      settings: { portal_id: "123" },
    });
    await pw.nativeIntegrations.crm.get("crm/1");
    await pw.nativeIntegrations.crm.sync("crm/1", {
      cursor: "after-1",
      contacts: [{ email: "ada@example.com", first_name: "Ada" }],
      events: [{ email: "ada@example.com", event_name: "Deal Stage Changed" }],
    });
    await pw.nativeIntegrations.crm.backfill("crm/1", {
      contacts: [{ email: "lin@example.com" }],
    });
    await pw.nativeIntegrations.crm.pause("crm/1");
    const disconnect = await pw.nativeIntegrations.crm.disconnect("crm/1");
    await pw.nativeIntegrations.crm.runs("crm/1", 10);

    expect(disconnect.provider_cleanup?.provider_cleanup_posture).toBe(
      "mixed_postwave_oauth_operator_hubspot_console",
    );
    expect(salesforceOAuthStart).toBe(
      "/api/v1/crm/salesforce/oauth/start?name=Salesforce+production&sync_tasks=false&redirect_to=%2Fapp%2Fintegrations",
    );

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/crm/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/salesforce/oauth/availability",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations",
        method: "POST",
        body: {
          provider: "hubspot",
          name: "HubSpot production",
          credentials_ref: "vault://crm/hubspot",
          settings: { portal_id: "123" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations/crm%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations/crm%2F1/sync",
        method: "POST",
        body: {
          cursor: "after-1",
          contacts: [{ email: "ada@example.com", first_name: "Ada" }],
          events: [
            { email: "ada@example.com", event_name: "Deal Stage Changed" },
          ],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations/crm%2F1/backfill",
        method: "POST",
        body: { contacts: [{ email: "lin@example.com" }] },
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations/crm%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations/crm%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/crm/integrations/crm%2F1/runs?limit=10",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("rejects CRM OAuth provider slugs outside the gateway allowlist", () => {
    const fetch = vi.fn();
    const pw = new PostwaveClient({ apiKey: "k", fetch });

    expect(() =>
      pw.nativeIntegrations.crm.oauthAvailability("../../admin" as never),
    ).toThrow(/Unsupported CRM OAuth provider/);
    expect(() =>
      pw.nativeIntegrations.crm.oauthStartUrl("close" as never),
    ).toThrow(/Unsupported CRM OAuth provider/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps support catalog/list/detail reads while holding runtime and run effects before fetch", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    const id = "11111111-1111-4111-8111-111111111111";
    const cursor = "opaque+/=?&%cursor";
    await pw.nativeIntegrations.support.providers();
    await pw.nativeIntegrations.support.list();
    await pw.nativeIntegrations.support.list({ limit: 17, cursor });
    await pw.nativeIntegrations.support.get(id);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/support-integrations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/support-integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/support-integrations?limit=17&cursor=opaque%2B%2F%3D%3F%26%25cursor",
        method: "GET",
        body: undefined,
      },
      {
        url: `https://api.moosewave.com/api/v1/support-integrations/${id}`,
        method: "GET",
        body: undefined,
      },
    ]);

    const effects = [
      () => pw.nativeIntegrations.support.create({ provider: "zendesk" }),
      () => pw.nativeIntegrations.support.sync(id, {}),
      () => pw.nativeIntegrations.support.backfill(id, {}),
      () =>
        pw.nativeIntegrations.support.ingest(id, {
          email: "private@example.com",
          event_name: "support.ticket_updated",
        }),
      () => pw.nativeIntegrations.support.pause(id),
      () => pw.nativeIntegrations.support.disconnect(id),
      () => pw.nativeIntegrations.support.runs(id, 10),
      () => pw.nativeIntegrations.support.runs("private-run-id", 0),
    ];
    for (const effect of effects) {
      await expect(effect()).rejects.toMatchObject({
        status: 503,
        code: "support_integration_runtime_held",
      });
    }
    expect(fetch).toHaveBeenCalledTimes(4);

    await expect(
      pw.nativeIntegrations.support.get("support/1"),
    ).rejects.toThrow(/canonical UUID/u);
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: "10" },
      { cursor: "" },
      { cursor: " surrounded" },
      { cursor: "surrounded " },
      { cursor: "opaque\u0000cursor" },
      { cursor: "opaque\tcursor" },
      { cursor: "opaque\ncursor" },
      { cursor: "opaque\rcursor" },
      { cursor: "opaque\u0085cursor" },
      { cursor: "opaque\u061ccursor" },
      { cursor: "opaque\u200bcursor" },
      { cursor: "opaque\u202ecursor" },
      { cursor: "opaque\u2066cursor" },
      { cursor: "opaque\ufeffcursor" },
      { cursor: "x".repeat(4097) },
      { cursor: 123 },
    ]) {
      await expect(
        pw.nativeIntegrations.support.list(options as never),
      ).rejects.toThrow(/limit|cursor/u);
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("routes provider pulls only for released review, loyalty, and subscription families", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ integration_id: "conn/1", status: "completed" });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.reviews.sync("review/1", {
      cursor: "yotpo_cursor_1",
    });
    await pw.nativeIntegrations.reviews.backfill("review/1", {});
    await pw.nativeIntegrations.loyalty.sync("loyalty/1", {
      cursor: "smile_cursor_1",
    });
    await pw.nativeIntegrations.loyalty.backfill("loyalty/1", {});
    await pw.nativeIntegrations.subscriptions.sync("subscription/1", {
      cursor: "recharge_cursor_1",
    });
    await pw.nativeIntegrations.subscriptions.backfill("subscription/1", {});

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/sync",
        method: "POST",
        body: { cursor: "yotpo_cursor_1" },
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/backfill",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1/sync",
        method: "POST",
        body: { cursor: "smile_cursor_1" },
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1/backfill",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/sync",
        method: "POST",
        body: { cursor: "recharge_cursor_1" },
      },
      {
        url: "https://api.moosewave.com/api/v1/subscription-integrations/subscription%2F1/backfill",
        method: "POST",
        body: {},
      },
    ]);
  });

  it("routes native review calls with canonical review payloads", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: "review/1", status: "completed", items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.reviews.providers();
    await pw.nativeIntegrations.reviews.list();
    await pw.nativeIntegrations.reviews.create({
      provider: "yotpo",
      name: "Yotpo reviews",
      credentials_ref: "vault://reviews/yotpo",
      settings: { store_id: "store_123" },
    });
    await pw.nativeIntegrations.reviews.get("review/1");
    await pw.nativeIntegrations.reviews.sync("review/1", {
      cursor: "after-1",
      reviews: [
        { source_id: "r1", reviewer_email: "ada@example.com", rating: 5 },
      ],
    });
    await pw.nativeIntegrations.reviews.backfill("review/1", {
      reviews: [{ source_id: "r0", rating: 4 }],
    });
    await pw.nativeIntegrations.reviews.ingest("review/1", {
      source_id: "r2",
      reviewer_email: "lin@example.com",
      rating: 5,
      title: "Great",
    });
    await pw.nativeIntegrations.reviews.pause("review/1");
    await pw.nativeIntegrations.reviews.disconnect("review/1");
    await pw.nativeIntegrations.reviews.acknowledgeProviderCleanup("review/1", {
      completed_actions: ["app_secret_or_api_credentials_rotated"],
      notes: "Verified in Yotpo console.",
    });
    await pw.nativeIntegrations.reviews.runs("review/1", 10);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations",
        method: "POST",
        body: {
          provider: "yotpo",
          name: "Yotpo reviews",
          credentials_ref: "vault://reviews/yotpo",
          settings: { store_id: "store_123" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/sync",
        method: "POST",
        body: {
          cursor: "after-1",
          reviews: [
            { source_id: "r1", reviewer_email: "ada@example.com", rating: 5 },
          ],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/backfill",
        method: "POST",
        body: { reviews: [{ source_id: "r0", rating: 4 }] },
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/ingest",
        method: "POST",
        body: {
          source_id: "r2",
          reviewer_email: "lin@example.com",
          rating: 5,
          title: "Great",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/provider-cleanup/acknowledge",
        method: "POST",
        body: {
          completed_actions: ["app_secret_or_api_credentials_rotated"],
          notes: "Verified in Yotpo console.",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/review-integrations/review%2F1/runs?limit=10",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("routes native loyalty calls with canonical loyalty payloads", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: "loyalty/1", status: "completed", items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.loyalty.providers();
    await pw.nativeIntegrations.loyalty.list();
    await pw.nativeIntegrations.loyalty.create({
      provider: "smile",
      name: "Smile loyalty",
      credentials_ref: "vault://loyalty/smile",
      settings: { shop_domain: "acme.myshopify.com" },
    });
    await pw.nativeIntegrations.loyalty.get("loyalty/1");
    await pw.nativeIntegrations.loyalty.sync("loyalty/1", {
      cursor: "after-1",
      members: [
        { source_id: "m1", email: "vip@example.com", points_balance: 1200 },
      ],
      events: [
        {
          source_id: "e1",
          email: "vip@example.com",
          event_name: "loyalty.points_earned",
        },
      ],
    });
    await pw.nativeIntegrations.loyalty.backfill("loyalty/1", {
      members: [{ source_id: "m0", email: "lin@example.com" }],
    });
    await pw.nativeIntegrations.loyalty.ingest("loyalty/1", {
      source_id: "e2",
      email: "vip@example.com",
      event_name: "loyalty.reward_redeemed",
    });
    await pw.nativeIntegrations.loyalty.pause("loyalty/1");
    await pw.nativeIntegrations.loyalty.disconnect("loyalty/1");
    await pw.nativeIntegrations.loyalty.runs("loyalty/1", 10);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations",
        method: "POST",
        body: {
          provider: "smile",
          name: "Smile loyalty",
          credentials_ref: "vault://loyalty/smile",
          settings: { shop_domain: "acme.myshopify.com" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1/sync",
        method: "POST",
        body: {
          cursor: "after-1",
          members: [
            { source_id: "m1", email: "vip@example.com", points_balance: 1200 },
          ],
          events: [
            {
              source_id: "e1",
              email: "vip@example.com",
              event_name: "loyalty.points_earned",
            },
          ],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1/backfill",
        method: "POST",
        body: { members: [{ source_id: "m0", email: "lin@example.com" }] },
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1/ingest",
        method: "POST",
        body: {
          source_id: "e2",
          email: "vip@example.com",
          event_name: "loyalty.reward_redeemed",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/loyalty-integrations/loyalty%2F1/runs?limit=10",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("routes native analytics calls with the canonical analytics payload shape", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: "analytics/1", status: "completed", items: [] });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.analytics.providers();
    await pw.nativeIntegrations.analytics.list();
    await pw.nativeIntegrations.analytics.create({
      provider: "segment",
      name: "Segment production",
      credentials_ref: "vault://analytics/segment",
      settings: { source_id: "src_123" },
    });
    await pw.nativeIntegrations.analytics.get("analytics/1");
    await pw.nativeIntegrations.analytics.sync("analytics/1", {
      cursor: "cur_1",
      profiles: [{ email: "ada@example.com", traits: { plan: "pro" } }],
      events: [{ email: "ada@example.com", event_name: "Product Viewed" }],
    });
    await pw.nativeIntegrations.analytics.backfill("analytics/1", {
      profiles: [{ email: "lin@example.com" }],
    });
    await pw.nativeIntegrations.analytics.ingest("analytics/1", {
      email: "ada@example.com",
      event_name: "Checkout Started",
    });
    await pw.nativeIntegrations.analytics.pause("analytics/1");
    await pw.nativeIntegrations.analytics.disconnect("analytics/1");
    await pw.nativeIntegrations.analytics.runs("analytics/1", 10);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations",
        method: "POST",
        body: {
          provider: "segment",
          name: "Segment production",
          credentials_ref: "vault://analytics/segment",
          settings: { source_id: "src_123" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/analytics%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/analytics%2F1/sync",
        method: "POST",
        body: {
          cursor: "cur_1",
          profiles: [{ email: "ada@example.com", traits: { plan: "pro" } }],
          events: [{ email: "ada@example.com", event_name: "Product Viewed" }],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/analytics%2F1/backfill",
        method: "POST",
        body: { profiles: [{ email: "lin@example.com" }] },
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/analytics%2F1/ingest",
        method: "POST",
        body: { email: "ada@example.com", event_name: "Checkout Started" },
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/analytics%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/analytics%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/analytics-integrations/analytics%2F1/runs?limit=10",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("guards empty native integration IDs before fetch", async () => {
    const fetch = vi.fn(async () => json({}));
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    expect(() =>
      pw.nativeIntegrations.crm.sync(" ", {
        contacts: [{ email: "ada@example.com" }],
      }),
    ).toThrow(/CRM import integration id is required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes native commerce lifecycle calls to commerce endpoints", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (
        init?.method === "DELETE" &&
        String(url).includes("/api/v1/commerce/integrations/")
      ) {
        return json({
          ok: true,
          provider_cleanup: {
            provider: "stripe",
            status: "operator_action_required",
            postwave_status: "disconnected",
            provider_cleanup_posture: "operator_managed_stripe_dashboard",
            managed_provider_cleanup: false,
            provider_scope_type: "stripe_account_id",
            provider_scope_id: "acct_123",
            credential_ref_present: true,
            webhook_secret_ref_present: true,
            webhook_cleanup_status:
              "operator_delete_or_disable_stripe_webhook_endpoint",
            credential_cleanup_status:
              "operator_revoke_or_rotate_stripe_restricted_key",
          },
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({
        id: "commerce/1",
        provider: "bigcommerce",
        status: "active",
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.commerce.providers();
    await pw.nativeIntegrations.commerce.list();
    await pw.nativeIntegrations.commerce.create({
      provider: "bigcommerce",
      settings: { store_hash: "abc", credential_ref: "vault://commerce" },
    });
    await pw.nativeIntegrations.commerce.get("commerce/1");
    await pw.nativeIntegrations.commerce.sync("commerce/1", {
      cursor: "cur_1",
      orders: [{ source_id: "order_1", customer_email: "buyer@example.com" }],
      product_deletions: [{ source_id: "square://product/item_deleted" }],
    });
    await pw.nativeIntegrations.commerce.backfill("commerce/1", {
      products: [{ source_id: "product_1", title: "Desk lamp" }],
      provider_events: [
        {
          event_type: "refund_created",
          source_id: "paypal://transaction/RFND123",
        },
      ],
    });
    await pw.nativeIntegrations.commerce.pause("commerce/1");
    const disconnect =
      await pw.nativeIntegrations.commerce.disconnect("commerce/1");
    expect(disconnect.ok).toBe(true);
    expect(disconnect.provider_cleanup?.provider_cleanup_posture).toBe(
      "operator_managed_stripe_dashboard",
    );
    expect(disconnect.provider_cleanup?.credential_ref_present).toBe(true);
    expect(disconnect.provider_cleanup?.webhook_cleanup_status).toBe(
      "operator_delete_or_disable_stripe_webhook_endpoint",
    );

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/commerce/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations",
        method: "POST",
        body: {
          provider: "bigcommerce",
          settings: { store_hash: "abc", credential_ref: "vault://commerce" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations/commerce%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations/commerce%2F1/sync",
        method: "POST",
        body: {
          cursor: "cur_1",
          orders: [
            { source_id: "order_1", customer_email: "buyer@example.com" },
          ],
          product_deletions: [{ source_id: "square://product/item_deleted" }],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations/commerce%2F1/backfill",
        method: "POST",
        body: {
          products: [{ source_id: "product_1", title: "Desk lamp" }],
          provider_events: [
            {
              event_type: "refund_created",
              source_id: "paypal://transaction/RFND123",
            },
          ],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations/commerce%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations/commerce%2F1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("routes native commerce provider pulls with empty payloads", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({
        customers_upserted: 0,
        products_upserted: 0,
        orders_upserted: 0,
        cursor: "bigcommerce:next",
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.commerce.sync("commerce/1", {
      cursor: "bigcommerce_cursor_1",
    });
    await pw.nativeIntegrations.commerce.backfill("commerce/1", {});

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations/commerce%2F1/sync",
        method: "POST",
        body: { cursor: "bigcommerce_cursor_1" },
      },
      {
        url: "https://api.moosewave.com/api/v1/commerce/integrations/commerce%2F1/backfill",
        method: "POST",
        body: {},
      },
    ]);
  });

  it("routes native warehouse lifecycle calls to warehouse connection endpoints", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).includes("/health")) {
        return json({
          connection_id: "warehouse/1",
          provider: "snowflake",
          status: "active",
          health: "needs_attention",
          provider_runtime_status: "partial",
          provider_driver_attachment: "manifest_worker",
          provider_health: {
            provider: "snowflake",
            state: "ready",
            executable: true,
            statements: [
              {
                order: 1,
                phase: "health_check",
                sql: "SELECT 1",
                executable: true,
              },
            ],
          },
        });
      }
      return json({
        id: "warehouse/1",
        provider: "snowflake",
        status: "active",
        items: [],
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.nativeIntegrations.warehouse.providers();
    await pw.nativeIntegrations.warehouse.list();
    await pw.nativeIntegrations.warehouse.list("disconnected");
    await pw.nativeIntegrations.warehouse.create({
      name: "Snowflake",
      provider: "snowflake",
      object_selection: ["profiles"],
    });
    await pw.nativeIntegrations.warehouse.get("warehouse/1");
    const health = await pw.nativeIntegrations.warehouse.health("warehouse/1");
    expect(health).toMatchObject({
      connection_id: "warehouse/1",
      health: "needs_attention",
      provider_runtime_status: "partial",
      provider_driver_attachment: "manifest_worker",
    });
    const providerHealth = await pw.nativeIntegrations.warehouse.health(
      "warehouse/1",
      { provider_check: true },
    );
    expect(providerHealth.provider_health).toMatchObject({
      provider: "snowflake",
      state: "ready",
      executable: true,
    });
    await pw.nativeIntegrations.warehouse.sync("warehouse/1", {
      object_selection: ["profiles"],
    });
    await pw.nativeIntegrations.warehouse.backfill("warehouse/1", {
      object_selection: ["profiles", "events"],
    });
    await pw.nativeIntegrations.warehouse.pause("warehouse/1");
    await pw.nativeIntegrations.warehouse.disconnect("warehouse/1");
    await pw.nativeIntegrations.warehouse.acknowledgeProviderCleanup(
      "warehouse/1",
      {
        completed_actions: ["snowflake_roles_or_grants_removed"],
        notes: "Verified in Snowflake console.",
      },
    );
    await pw.nativeIntegrations.warehouse.runs("warehouse/1", 5);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/warehouse/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections?status=disconnected",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections",
        method: "POST",
        body: {
          name: "Snowflake",
          provider: "snowflake",
          object_selection: ["profiles"],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1/health",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1/health?provider_check=true",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1/runs",
        method: "POST",
        body: { object_selection: ["profiles"], run_mode: "manual" },
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1/runs",
        method: "POST",
        body: {
          object_selection: ["profiles", "events"],
          run_mode: "backfill",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1/pause",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1/provider-cleanup/acknowledge",
        method: "POST",
        body: {
          completed_actions: ["snowflake_roles_or_grants_removed"],
          notes: "Verified in Snowflake console.",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/warehouse/connections/warehouse%2F1/runs?limit=5",
        method: "GET",
        body: undefined,
      },
    ]);
  });
});
