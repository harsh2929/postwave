// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createClient } from "../src/lib/client.js";
import {
  integrationsAudienceCreate,
  integrationsAudienceDisconnect,
  integrationsAudienceGet,
  integrationsAudienceJobDiagnostics,
  integrationsAudienceJobs,
  integrationsAudienceList,
  integrationsAudiencePreview,
  integrationsAudienceProviders,
  integrationsAudienceReadiness,
  integrationsAudienceSyncRuns,
  integrationsAudienceSync,
  integrationsAudienceUpdate,
  integrationsNativeBackfill,
  integrationsChatCreate,
  integrationsChatDelete,
  integrationsChatList,
  integrationsChatUpdate,
  integrationsNativeCreate,
  integrationsNativeCrmOAuthAvailability,
  integrationsNativeCrmOAuthStartUrl,
  integrationsNativeDisconnect,
  integrationsNativeIngest,
  integrationsNativeList,
  integrationsNativePause,
  integrationsNativeProviders,
  integrationsNativeRuns,
  integrationsNativeSync,
  SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
} from "../src/commands/integrations.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

const SUPPORT_TENANT = "11111111-1111-4111-8111-111111111111";
const SUPPORT_AS_OF = "2026-08-25T10:00:00.123456789Z";

function supportProjection(
  index = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    tenantId: SUPPORT_TENANT,
    tenant_id: SUPPORT_TENANT,
    id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    provider: "zendesk",
    name: `Historical support connection ${index}`,
    status: "paused",
    runtime_status: "held",
    hold_code: SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
    credential_configured: false,
    created_at: "2026-08-24T08:00:00Z",
    updated_at: `2026-08-25T09:00:00.${String(100 - index).padStart(9, "0")}Z`,
    ...overrides,
  };
}

function supportListResponse(
  overrides: {
    items?: unknown[];
    hasMore?: boolean;
    nextCursor?: unknown;
    page?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
  } = {},
) {
  const hasMore = overrides.hasMore ?? false;
  return {
    tenantId: SUPPORT_TENANT,
    items: overrides.items ?? [],
    page: overrides.page ?? {
      has_more: hasMore,
      next_cursor: overrides.nextCursor ?? (hasMore ? "next-cursor" : null),
      as_of: SUPPORT_AS_OF,
      consistency: "mutable_window",
      may_reorder: true,
    },
    ...overrides.envelope,
  };
}

function nativeResource(
  opts: { includeRuns?: boolean; listResponse?: unknown } = {},
) {
  const resource = {
    providers: vi.fn(async () => ({
      items: [{ key: "hubspot", name: "HubSpot" }],
    })),
    list: vi.fn(async () => opts.listResponse ?? { items: [] }),
    create: vi.fn(async () => ({
      id: "conn/1",
      provider: "hubspot",
      status: "active",
    })),
    get: vi.fn(async () => ({
      id: "conn/1",
      provider: "hubspot",
      status: "active",
    })),
    sync: vi.fn(async () => ({
      id: "conn/1",
      action: "sync",
      status: "queued",
    })),
    backfill: vi.fn(async () => ({
      id: "conn/1",
      action: "backfill",
      status: "queued",
    })),
    ingest: vi.fn(async () => ({
      id: "conn/1",
      action: "ingest",
      status: "accepted",
    })),
    pause: vi.fn(async () => ({
      id: "conn/1",
      action: "pause",
      status: "paused",
    })),
    disconnect: vi.fn(async () => ({
      id: "conn/1",
      action: "disconnect",
      status: "deleted",
    })),
    oauthAvailability: vi.fn(async (provider: string) => ({
      provider,
      available: true,
      start_url: `/api/v1/crm/${provider}/oauth/start`,
    })),
    oauthStartUrl: vi.fn(
      (
        provider: string,
        query?: Record<string, string | number | boolean | null | undefined>,
      ) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query ?? {})) {
          if (value === undefined || value === null || value === "") continue;
          params.set(key, String(value));
        }
        const encoded = params.toString();
        return `/api/v1/crm/${provider}/oauth/start${encoded ? `?${encoded}` : ""}`;
      },
    ),
  };
  if (opts.includeRuns !== false) {
    return {
      ...resource,
      runs: vi.fn(async () => ({
        items: [{ id: "run_1", action: "sync", status: "succeeded" }],
      })),
    };
  }
  return resource;
}

function mockClient() {
  const crm = nativeResource();
  const lead = nativeResource();
  const reviews = nativeResource();
  const loyalty = nativeResource();
  const subscriptions = nativeResource();
  const support = nativeResource({
    listResponse: supportListResponse(),
  });
  const analytics = nativeResource();
  const marketing = nativeResource();
  const commerce = nativeResource({ includeRuns: false, listResponse: [] });
  const warehouse = nativeResource();
  const audienceDestinations = {
    providers: vi.fn(async () => ({ providers: ["meta", "google_ads"] })),
    list: vi.fn(async () => ({
      items: [{ id: "aud/1", provider: "meta", status: "active" }],
    })),
    create: vi.fn(async () => ({
      id: "aud/1",
      provider: "meta",
      status: "active",
    })),
    get: vi.fn(async () => ({
      id: "aud/1",
      provider: "meta",
      status: "active",
    })),
    update: vi.fn(async () => ({
      id: "aud/1",
      provider: "meta",
      status: "paused",
    })),
    readiness: vi.fn(async () => ({
      provider: "meta",
      ready: true,
      status: "configured",
    })),
    preview: vi.fn(async () => ({ destination_id: "aud/1", deliverable: 10 })),
    sync: vi.fn(async () => ({ status: "queued", job: { id: "job_1" } })),
    jobs: vi.fn(async () => ({
      items: [
        {
          id: "job_1",
          destination_id: "aud/1",
          status: "succeeded",
          members_synced: 10,
        },
      ],
    })),
    jobDiagnostics: vi.fn(async () => ({
      diagnostics: { provider: "google_ads", provider_status: "PROCESSING" },
    })),
    disconnect: vi.fn(async () => undefined),
  };
  const audienceSyncs = {
    runs: vi.fn(async () => ({
      items: [
        {
          id: "run_1",
          sync_id: "sync/1",
          status: "succeeded",
          rows_exported: 10,
          batches_sent: 1,
          excluded_count: 0,
        },
      ],
    })),
  };
  const chatProvider = {
    list: vi.fn(async () => [
      {
        id: "chat/1",
        channel_hint: "#growth",
        events: ["subscriber.created"],
        enabled: true,
      },
    ]),
    create: vi.fn(async () => ({
      id: "chat/1",
      channel_hint: "#growth",
      enabled: true,
    })),
    update: vi.fn(async () => ({
      id: "chat/1",
      channel_hint: "#growth",
      enabled: false,
    })),
    delete: vi.fn(async () => ({ ok: true })),
  };
  const chatIntegrations = {
    forProvider: vi.fn(() => chatProvider),
    slack: chatProvider,
    discord: chatProvider,
    teams: chatProvider,
  };
  vi.mocked(createClient).mockReturnValue({
    audienceDestinations,
    audienceSyncs,
    chatIntegrations,
    nativeIntegrations: {
      commerce,
      crm,
      lead,
      reviews,
      loyalty,
      subscriptions,
      support,
      analytics,
      marketing,
      warehouse,
    },
  } as unknown as ReturnType<typeof createClient>);
  return {
    analytics,
    audienceDestinations,
    audienceSyncs,
    chatIntegrations,
    chatProvider,
    commerce,
    crm,
    lead,
    loyalty,
    marketing,
    reviews,
    subscriptions,
    support,
    warehouse,
  };
}

function runsMock(resource: ReturnType<typeof nativeResource>) {
  if (!("runs" in resource)) throw new Error("expected runs mock");
  return resource.runs;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("native integration CLI commands", () => {
  it("dispatches provider and run commands to the requested native family", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { crm } = mockClient();

    await integrationsNativeProviders("crm", { output: "json" });
    await integrationsNativeRuns("crm", "conn/1", {
      limit: 10,
      output: "json",
    });

    expect(crm.providers).toHaveBeenCalledTimes(1);
    expect(runsMock(crm)).toHaveBeenCalledWith("conn/1", 10);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("passes first-page and opaque next-page options only to support list reads", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { support } = mockClient();
    const cursor = "opaque+/=?&%cursor";
    support.list
      .mockResolvedValueOnce(
        supportListResponse({
          items: [supportProjection()],
          hasMore: true,
          nextCursor: cursor,
        }),
      )
      .mockResolvedValueOnce(supportListResponse());

    await integrationsNativeList("support", { limit: "1" });
    await integrationsNativeList("support", {
      cursor,
      limit: "1",
    });

    expect(support.list.mock.calls).toEqual([
      [{ limit: 1 }],
      [{ cursor, limit: 1 }],
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(error.mock.calls).toEqual([
      [
        `Support page: has_more=true; page.next_cursor=${JSON.stringify(cursor)}. Continue with --cursor using this exact value.`,
      ],
      ["Support page: has_more=false; no next page."],
    ]);
  });

  it("rejects hostile support pagination and non-support pagination before client access", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { crm, support } = mockClient();
    vi.mocked(createClient).mockClear();

    const hostileOptions = [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: "1e2" },
      { limit: "01" },
      { limit: "1e2.5" },
      { cursor: "" },
      { cursor: " surrounded" },
      { cursor: "surrounded " },
      { cursor: "opaque\u0000cursor" },
      { cursor: "opaque\tcursor" },
      { cursor: "opaque\ncursor" },
      { cursor: "opaque\rcursor" },
      { cursor: "opaque\u0085cursor" },
      { cursor: "opaque\u200bcursor" },
      { cursor: "opaque\u202ecursor" },
      { cursor: "x".repeat(4097) },
      { cursor: "😀".repeat(1025) },
      { cursor: "opaque\ud800cursor" },
      { cursor: 123 },
    ];
    for (const opts of hostileOptions) {
      await integrationsNativeList("support", opts as never);
    }
    await integrationsNativeList("crm", { cursor: "opaque", limit: 10 });

    expect(createClient).not.toHaveBeenCalled();
    expect(support.list).not.toHaveBeenCalled();
    expect(crm.list).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(hostileOptions.length + 1);
    expect(process.exitCode).toBe(1);
  });

  it("writes zero stdout when a support table envelope, row, or cursor is malformed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { support } = mockClient();
    support.list
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce(
        supportListResponse({
          page: {
            has_more: "true",
            next_cursor: "opaque",
            as_of: SUPPORT_AS_OF,
            consistency: "mutable_window",
            may_reorder: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        supportListResponse({
          hasMore: true,
          nextCursor: "opaque\u202ecursor",
        }),
      )
      .mockResolvedValueOnce(
        supportListResponse({
          items: [supportProjection(1, { name: "Recorded\nstatus: active" })],
        }),
      )
      .mockResolvedValueOnce(
        supportListResponse({
          items: [supportProjection(1, { tenant_id: "33333333-3333-4333-8333-333333333333" })],
        }),
      )
      .mockResolvedValueOnce(
        supportListResponse({
          items: [supportProjection(1, { updated_at: "0001-01-01T00:00:00Z" })],
        }),
      );

    for (let index = 0; index < 6; index += 1) {
      await integrationsNativeList("support");
    }

    expect(support.list).toHaveBeenCalledTimes(6);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(6);
    expect(error).toHaveBeenCalledWith(
      "Support list response failed its bounded tenant projection contract; no output was written.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("validates JSON support envelopes too and preserves only verified raw pagination", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { support } = mockClient();
    support.list
      .mockResolvedValueOnce(
        supportListResponse({ items: [supportProjection()] }),
      )
      .mockResolvedValueOnce(
        supportListResponse({
          items: [supportProjection(1, { extra_secret: "unsafe" })],
        }),
      );

    await integrationsNativeList("support", { output: "json" });
    await integrationsNativeList("support", { output: "json" });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(
      supportListResponse({ items: [supportProjection()] }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Support list response failed its bounded tenant projection contract; no output was written.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("dispatches CRM OAuth helper commands", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { crm } = mockClient();

    await integrationsNativeCrmOAuthAvailability("salesforce", {
      output: "json",
    });
    integrationsNativeCrmOAuthStartUrl("salesforce", {
      output: "json",
      name: "Salesforce production",
      redirectTo: "/app/integrations",
      config: '{"org_id":"00Dxx","sync_tasks":false}',
    });

    expect(crm.oauthAvailability).toHaveBeenCalledWith("salesforce");
    expect(crm.oauthStartUrl).toHaveBeenCalledWith("salesforce", {
      name: "Salesforce production",
      redirect_to: "/app/integrations",
      org_id: "00Dxx",
      sync_tasks: false,
    });
    expect(log.mock.calls.length).toBeGreaterThan(1);
    const startOutput = log.mock.calls[1]?.[0];
    expect(JSON.parse(String(startOutput))).toEqual({
      provider: "salesforce",
      start_url:
        "/api/v1/crm/salesforce/oauth/start?name=Salesforce+production&redirect_to=%2Fapp%2Fintegrations&org_id=00Dxx&sync_tasks=false",
    });
  });

  it("dispatches create and sync commands with parsed payloads", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const {
      analytics,
      commerce,
      crm,
      lead,
      loyalty,
      marketing,
      reviews,
      subscriptions,
      warehouse,
    } = mockClient();

    await integrationsNativeCreate("crm", {
      provider: "hubspot",
      name: "HubSpot production",
      config: '{"portal_id":"123"}',
      credentialRef: "vault://crm/hubspot",
      output: "json",
    });
    await integrationsNativeSync("crm", "conn/1", {
      cursor: "crm_cursor_1",
      payload:
        '{"contacts":[{"email":"ada@example.com"}],"events":[{"email":"ada@example.com","event_name":"Deal Stage Changed"}]}',
      output: "json",
    });
    await integrationsNativeCreate("reviews", {
      provider: "yotpo",
      name: "Yotpo reviews",
      credentialRef: "vault://reviews/yotpo",
      config: '{"store_id":"store_123"}',
      output: "json",
    });
    await integrationsNativeSync("reviews", "review/1", {
      cursor: "review_cursor_1",
      payload:
        '{"reviews":[{"source_id":"r1","reviewer_email":"ada@example.com","rating":5}]}',
      output: "json",
    });
    await integrationsNativeCreate("loyalty", {
      provider: "smile",
      name: "Smile loyalty",
      credentialRef: "vault://loyalty/smile",
      config: '{"shop_domain":"acme.myshopify.com"}',
      output: "json",
    });
    await integrationsNativeSync("loyalty", "loyalty/1", {
      cursor: "loyalty_cursor_1",
      payload:
        '{"members":[{"email":"vip@example.com","points_balance":1200}],"events":[{"email":"vip@example.com","event_name":"loyalty.points_earned"}]}',
      output: "json",
    });
    await integrationsNativeCreate("lead", {
      provider: "typeform",
      name: "Typeform leads",
      credentialRef: "vault://lead/typeform",
      config: '{"form_id":"form_123"}',
      output: "json",
    });
    await integrationsNativeSync("lead", "lead/1", {
      cursor: "lead_cursor_1",
      payload:
        '{"submissions":[{"email":"ada@example.com","form_id":"form_123"}]}',
      output: "json",
    });
    await integrationsNativeCreate("subscriptions", {
      provider: "recharge",
      name: "Recharge production",
      credentialRef: "vault://subscriptions/recharge",
      config: '{"store_domain":"acme.myshopify.com"}',
      output: "json",
    });
    await integrationsNativeSync("subscriptions", "subscription/1", {
      cursor: "sub_cursor_1",
      payload:
        '{"subscriptions":[{"email":"ada@example.com","subscription_id":"sub_123"}],"shipments":[{"email":"ada@example.com","tracking_number":"trk_123"}],"events":[{"email":"ada@example.com","event_name":"subscription.renewed"}]}',
      output: "json",
    });
    await integrationsNativeSync("commerce", "commerce/1", {
      cursor: "commerce_cursor_1",
      objects: "orders",
      payload:
        '{"orders":[{"source_id":"order_1","customer_email":"buyer@example.com","total_cents":2500}]}',
      output: "json",
    });
    await integrationsNativeCreate("warehouse", {
      provider: "snowflake",
      name: "Snowflake prod",
      credentialRef: "vault://warehouse/snowflake",
      direction: "export",
      cadence: "daily",
      backfillDays: 365,
      objects: "profiles,events",
      config: '{"account":"acct","warehouse":"COMPUTE_WH"}',
      output: "json",
    });
    await integrationsNativeRuns("warehouse", "warehouse/1", {
      limit: 5,
      output: "json",
    });
    await integrationsNativeIngest("lead", "lead/1", {
      payload: '{"email":"ada@example.com"}',
      output: "json",
    });
    await integrationsNativeIngest("subscriptions", "subscription/1", {
      payload: '{"email":"ada@example.com","event_name":"shipment.delivered"}',
      output: "json",
    });
    await integrationsNativeCreate("analytics", {
      provider: "segment",
      name: "Segment production",
      credentialRef: "vault://analytics/segment",
      config: '{"source_id":"src_123"}',
      output: "json",
    });
    await integrationsNativeSync("analytics", "analytics/1", {
      cursor: "cur_1",
      payload:
        '{"profiles":[{"email":"ada@example.com"}],"events":[{"email":"ada@example.com","event_name":"Viewed"}]}',
      output: "json",
    });
    await integrationsNativeCreate("marketing", {
      provider: "mailerlite",
      name: "MailerLite production",
      credentialRef: "vault://marketing/mailerlite",
      config: '{"workspace_id":"workspace_123"}',
      output: "json",
    });
    await integrationsNativeSync("marketing", "marketing/1", {
      cursor: "mailerlite_cursor_1",
      metadata: '{"import_cursor":"subscribers:500"}',
      payload: '{"run_mode":"retry"}',
      output: "json",
    });

    expect(crm.create).toHaveBeenCalledWith({
      provider: "hubspot",
      name: "HubSpot production",
      credentials_ref: "vault://crm/hubspot",
      settings: { portal_id: "123" },
    });
    expect(crm.sync).toHaveBeenCalledWith("conn/1", {
      cursor: "crm_cursor_1",
      contacts: [{ email: "ada@example.com" }],
      events: [{ email: "ada@example.com", event_name: "Deal Stage Changed" }],
    });
    expect(reviews.create).toHaveBeenCalledWith({
      provider: "yotpo",
      name: "Yotpo reviews",
      credentials_ref: "vault://reviews/yotpo",
      settings: { store_id: "store_123" },
    });
    expect(reviews.sync).toHaveBeenCalledWith("review/1", {
      cursor: "review_cursor_1",
      reviews: [
        { source_id: "r1", reviewer_email: "ada@example.com", rating: 5 },
      ],
    });
    expect(loyalty.create).toHaveBeenCalledWith({
      provider: "smile",
      name: "Smile loyalty",
      credentials_ref: "vault://loyalty/smile",
      settings: { shop_domain: "acme.myshopify.com" },
    });
    expect(loyalty.sync).toHaveBeenCalledWith("loyalty/1", {
      cursor: "loyalty_cursor_1",
      members: [{ email: "vip@example.com", points_balance: 1200 }],
      events: [
        { email: "vip@example.com", event_name: "loyalty.points_earned" },
      ],
    });
    expect(lead.create).toHaveBeenCalledWith({
      provider: "typeform",
      name: "Typeform leads",
      credentials_ref: "vault://lead/typeform",
      settings: { form_id: "form_123" },
    });
    expect(lead.sync).toHaveBeenCalledWith("lead/1", {
      cursor: "lead_cursor_1",
      submissions: [{ email: "ada@example.com", form_id: "form_123" }],
    });
    expect(subscriptions.create).toHaveBeenCalledWith({
      provider: "recharge",
      name: "Recharge production",
      credentials_ref: "vault://subscriptions/recharge",
      settings: { store_domain: "acme.myshopify.com" },
    });
    expect(subscriptions.sync).toHaveBeenCalledWith("subscription/1", {
      cursor: "sub_cursor_1",
      subscriptions: [{ email: "ada@example.com", subscription_id: "sub_123" }],
      shipments: [{ email: "ada@example.com", tracking_number: "trk_123" }],
      events: [
        { email: "ada@example.com", event_name: "subscription.renewed" },
      ],
    });
    expect(commerce.sync).toHaveBeenCalledWith("commerce/1", {
      cursor: "commerce_cursor_1",
      orders: [
        {
          source_id: "order_1",
          customer_email: "buyer@example.com",
          total_cents: 2500,
        },
      ],
    });
    expect(warehouse.create).toHaveBeenCalledWith({
      provider: "snowflake",
      name: "Snowflake prod",
      credentials_ref: "vault://warehouse/snowflake",
      direction: "export",
      cadence: "daily",
      backfill_days: 365,
      object_selection: ["profiles", "events"],
      config: {
        account: "acct",
        warehouse: "COMPUTE_WH",
      },
    });
    expect(runsMock(warehouse)).toHaveBeenCalledWith("warehouse/1", 5);
    expect(lead.ingest).toHaveBeenCalledWith("lead/1", {
      email: "ada@example.com",
    });
    expect(subscriptions.ingest).toHaveBeenCalledWith("subscription/1", {
      email: "ada@example.com",
      event_name: "shipment.delivered",
    });
    expect(analytics.create).toHaveBeenCalledWith({
      provider: "segment",
      name: "Segment production",
      credentials_ref: "vault://analytics/segment",
      settings: { source_id: "src_123" },
    });
    expect(analytics.sync).toHaveBeenCalledWith("analytics/1", {
      cursor: "cur_1",
      profiles: [{ email: "ada@example.com" }],
      events: [{ email: "ada@example.com", event_name: "Viewed" }],
    });
    expect(marketing.create).toHaveBeenCalledWith({
      provider: "mailerlite",
      name: "MailerLite production",
      credentials_ref: "vault://marketing/mailerlite",
      settings: { workspace_id: "workspace_123" },
    });
    expect(marketing.sync).toHaveBeenCalledWith("marketing/1", {
      run_mode: "retry",
      cursor: "mailerlite_cursor_1",
      metadata: { import_cursor: "subscribers:500" },
    });
  });

  it("reports unsupported run history for native families without runs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { commerce } = mockClient();

    await integrationsNativeRuns("commerce", "commerce/1", { output: "json" });

    expect(commerce.providers).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "Run history is not available for commerce integrations.",
    );
  });

  it("allows commerce provider pulls without canonical rows", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { commerce } = mockClient();

    await integrationsNativeSync("commerce", "commerce/1", {
      cursor: "commerce_cursor_1",
      output: "json",
    });

    expect(commerce.sync).toHaveBeenCalledWith("commerce/1", {
      cursor: "commerce_cursor_1",
    });
    await integrationsNativeBackfill("commerce", "commerce/1", {
      cursor: "commerce_backfill_cursor_1",
      output: "json",
    });
    expect(commerce.backfill).toHaveBeenCalledWith("commerce/1", {
      cursor: "commerce_backfill_cursor_1",
    });
    expect(process.exitCode).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it("allows CRM and lead provider pulls without canonical rows", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { crm, lead } = mockClient();

    await integrationsNativeSync("crm", "crm/1", {
      cursor: "crm_cursor_1",
      output: "json",
    });
    expect(crm.sync).toHaveBeenCalledWith("crm/1", {
      cursor: "crm_cursor_1",
    });
    expect(process.exitCode).toBeUndefined();
    expect(error).not.toHaveBeenCalled();

    await integrationsNativeSync("lead", "lead/1", {
      cursor: "lead_cursor_1",
      output: "json",
    });
    expect(lead.sync).toHaveBeenCalledWith("lead/1", {
      cursor: "lead_cursor_1",
    });
    await integrationsNativeBackfill("lead", "lead/1", {
      cursor: "lead_backfill_cursor_1",
      output: "json",
    });
    expect(lead.backfill).toHaveBeenCalledWith("lead/1", {
      cursor: "lead_backfill_cursor_1",
    });
    expect(process.exitCode).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it("allows provider pulls for review, loyalty, and subscription families", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const client = mockClient();
    const cases = [
      {
        family: "reviews",
        id: "review/1",
        sync: client.reviews.sync,
        backfill: client.reviews.backfill,
      },
      {
        family: "loyalty",
        id: "loyalty/1",
        sync: client.loyalty.sync,
        backfill: client.loyalty.backfill,
      },
      {
        family: "subscriptions",
        id: "subscription/1",
        sync: client.subscriptions.sync,
        backfill: client.subscriptions.backfill,
      },
    ] as const;

    for (const tc of cases) {
      await integrationsNativeSync(tc.family, tc.id, {
        cursor: "cursor_1",
        output: "json",
      });
      expect(tc.sync).toHaveBeenCalledWith(tc.id, { cursor: "cursor_1" });
      await integrationsNativeBackfill(tc.family, tc.id, {
        cursor: "backfill_cursor_1",
        output: "json",
      });
      expect(tc.backfill).toHaveBeenCalledWith(tc.id, {
        cursor: "backfill_cursor_1",
      });
    }
    expect(process.exitCode).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it("holds every support runtime command locally without constructing a client", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { support } = mockClient();
    vi.mocked(createClient).mockClear();

    await integrationsNativeCreate("support", {
      credentials: '{"token":"must-not-be-parsed"}',
    });
    await integrationsNativeSync("support", " ", { cursor: "c1" });
    await integrationsNativeBackfill("support", " ", {
      cursor: "c2",
    });
    await integrationsNativeIngest("support", " ", {
      payload: "not-json",
    });
    await integrationsNativePause("support", " ");
    await integrationsNativeDisconnect("support", " ");
    await integrationsNativeRuns("support", " ", { limit: 0 });

    expect(createClient).not.toHaveBeenCalled();
    const runtimeMethods = [
      support.create,
      support.sync,
      support.backfill,
      support.ingest,
      support.pause,
      support.disconnect,
      ...("runs" in support ? [support.runs] : []),
    ];
    expect(runtimeMethods).toHaveLength(7);
    for (const method of runtimeMethods) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(support.list).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(7);
    for (const [message] of error.mock.calls) {
      expect(String(message)).toContain(SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE);
    }
    expect(process.exitCode).toBe(1);
  });

  it("qualifies native help with support read-only projections and runtime holds", () => {
    const helpSource = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );

    expect(helpSource).toMatch(
      /integrations native providers <family>[\s\S]*support is static catalog only/,
    );
    expect(helpSource).toMatch(
      /integrations native list <family>[\s\S]*support is minimized\/read-only/,
    );
    expect(helpSource).toMatch(
      /integrations native list <family>[\s\S]*--limit <n>[\s\S]*server default 50[\s\S]*--cursor <cursor>[\s\S]*Opaque support-list next-page cursor/,
    );
    expect(helpSource).toMatch(
      /integrations native get <family> <id>[\s\S]*support is minimized\/read-only/,
    );
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    const normalizedReadme = readme.replace(/\s+/gu, " ");
    expect(normalizedReadme).toMatch(
      /native list support[\s\S]*--limit 1\.\.100[\s\S]*server default `50`[\s\S]*page\.has_more[\s\S]*page\.next_cursor[\s\S]*--output json/,
    );
    expect(normalizedReadme).toMatch(
      /Every output mode first validates the bounded tenant envelope[\s\S]*malformed or terminal-unsafe responses exit nonzero without writing stdout[\s\S]*complete verified response envelope/,
    );
    expect(normalizedReadme).toMatch(
      /Support create, sync, backfill, ingest, pause, disconnect, and run-history commands fail locally[\s\S]*support_integration_runtime_held[\s\S]*send no HTTP request/,
    );
    for (const command of [
      "create",
      "sync",
      "backfill",
      "ingest",
      "pause",
      "disconnect",
      "runs",
    ]) {
      const start = helpSource.indexOf(`integrations native ${command}`);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(helpSource.slice(start, start + 240)).toContain(
        SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
      );
    }
  });

  it("allows the server to dispatch configured analytics provider pullers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const client = mockClient();

    await integrationsNativeSync("analytics", "analytics/1", {
      cursor: "cursor_1",
      output: "json",
    });
    expect(client.analytics.sync).toHaveBeenCalledWith("analytics/1", {
      cursor: "cursor_1",
    });

    await integrationsNativeBackfill("analytics", "analytics/1", {
      cursor: "backfill_cursor_1",
      output: "json",
    });
    expect(client.analytics.backfill).toHaveBeenCalledWith("analytics/1", {
      cursor: "backfill_cursor_1",
    });
    expect(process.exitCode).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it("reports unsupported ingest families before calling the SDK", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { crm } = mockClient();

    await integrationsNativeIngest("crm", "conn/1", {
      payload: "{}",
      output: "json",
    });

    expect(crm.ingest).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "Native crm integrations do not support ingest.",
    );
  });

  it("dispatches audience destination commands to the first-party SDK resource", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { audienceDestinations, audienceSyncs } = mockClient();

    await integrationsAudienceProviders({ output: "json" });
    await integrationsAudienceList({ provider: "meta", output: "json" });
    await integrationsAudienceCreate({
      provider: "meta",
      listId: "list_123",
      externalAudienceId: "audience_123",
      config:
        '{"credentials_ref":"vault://ads/meta","audience_id":"audience_123"}',
      output: "json",
    });
    await integrationsAudienceGet("aud/1", { output: "json" });
    await integrationsAudienceUpdate("aud/1", {
      status: "paused",
      config: '{"audience_id":"audience_456"}',
      output: "json",
    });
    await integrationsAudienceReadiness("meta", {
      config: '{"audience_id":"audience_123"}',
      output: "json",
    });
    await integrationsAudiencePreview("aud/1", { output: "json" });
    await integrationsAudienceSync("aud/1", { output: "json" });
    await integrationsAudienceJobs("aud/1", { output: "json" });
    await integrationsAudienceJobDiagnostics("aud/1", "job/1", {
      output: "json",
    });
    await integrationsAudienceSyncRuns("sync/1", { output: "json" });
    await integrationsAudienceDisconnect("aud/1", { output: "json" });

    expect(audienceDestinations.providers).toHaveBeenCalledTimes(1);
    expect(audienceDestinations.list).toHaveBeenCalledWith("meta");
    expect(audienceDestinations.create).toHaveBeenCalledWith({
      provider: "meta",
      list_id: "list_123",
      external_audience_id: "audience_123",
      config: {
        credentials_ref: "vault://ads/meta",
        audience_id: "audience_123",
      },
    });
    expect(audienceDestinations.get).toHaveBeenCalledWith("aud/1");
    expect(audienceDestinations.update).toHaveBeenCalledWith("aud/1", {
      status: "paused",
      config: { audience_id: "audience_456" },
    });
    expect(audienceDestinations.readiness).toHaveBeenCalledWith("meta", {
      audience_id: "audience_123",
    });
    expect(audienceDestinations.preview).toHaveBeenCalledWith("aud/1");
    expect(audienceDestinations.sync).toHaveBeenCalledWith("aud/1");
    expect(audienceDestinations.jobs).toHaveBeenCalledWith("aud/1");
    expect(audienceDestinations.jobDiagnostics).toHaveBeenCalledWith(
      "aud/1",
      "job/1",
    );
    expect(audienceSyncs.runs).toHaveBeenCalledWith("sync/1");
    expect(audienceDestinations.disconnect).toHaveBeenCalledWith("aud/1");
  });

  it("rejects raw audience destination credentials before dispatch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { audienceDestinations } = mockClient();

    await integrationsAudienceCreate({
      provider: "meta",
      listId: "list_123",
      config: '{"access_token":"tok","audience_id":"audience_123"}',
      output: "json",
    });

    expect(audienceDestinations.create).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("dispatches chat integration commands to the requested provider resource", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { chatIntegrations, chatProvider } = mockClient();

    await integrationsChatList("discord", { output: "json" });
    await integrationsChatCreate("discord", {
      url: "https://discord.com/api/webhooks/123/token",
      channelHint: "#growth",
      events: "subscriber.created,campaign.sent",
      output: "json",
    });
    await integrationsChatUpdate("teams", "teams/1", {
      enabled: "false",
      events: "campaign.sent",
      output: "json",
    });
    await integrationsChatDelete("slack", "slack/1", {
      output: "json",
      yes: true,
    });

    expect(chatIntegrations.forProvider).toHaveBeenNthCalledWith(1, "discord");
    expect(chatIntegrations.forProvider).toHaveBeenNthCalledWith(2, "discord");
    expect(chatIntegrations.forProvider).toHaveBeenNthCalledWith(3, "teams");
    expect(chatIntegrations.forProvider).toHaveBeenNthCalledWith(4, "slack");
    expect(chatProvider.list).toHaveBeenCalledTimes(1);
    expect(chatProvider.create).toHaveBeenCalledWith({
      url: "https://discord.com/api/webhooks/123/token",
      channel_hint: "#growth",
      events: ["subscriber.created", "campaign.sent"],
    });
    expect(chatProvider.update).toHaveBeenCalledWith("teams/1", {
      events: ["campaign.sent"],
      enabled: false,
    });
    expect(chatProvider.delete).toHaveBeenCalledWith("slack/1");
  });
});
