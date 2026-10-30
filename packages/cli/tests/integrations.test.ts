// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audienceDestinationCreateInputFromOptions,
  audienceDestinationUpdateInputFromOptions,
  chatIntegrationCreateInputFromOptions,
  chatIntegrationUpdateInputFromOptions,
  compactChatIntegrationRows,
  catalogQueryFromOptions,
  compactAudienceDestinationJobRows,
  compactAudienceDestinationRows,
  compactAudienceSyncRunRows,
  compactCatalogRows,
  compactConnectionRows,
  compactCoverageRows,
  compactNativeConnectionRows,
  compactNativeProviderRows,
  compactNativeRunRows,
  compactReadinessRows,
  compactRecipeRows,
  compactStackRows,
  nativeCreateInputFromOptions,
  nativeIngestInputFromOptions,
  nativeLifecycleInputFromOptions,
  normalizeBadge,
  normalizeChatProvider,
  normalizeCapability,
  normalizeIntegrationId,
  normalizeNativeFamily,
  recipeQueryFromOptions,
  supportsNativeIngest,
} from "../src/commands/integrations.js";
import type {
  IntegrationCatalogItem,
  IntegrationConnection,
  IntegrationRecipe,
  IntegrationCategoryCoverage,
  IntegrationCustomerStackCoverage,
  NativeIntegration,
  NativeIntegrationProviderSpec,
  NativeIntegrationRun,
} from "@postwave/sdk";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("integration option normalization", () => {
  it("builds catalog query params with validated badge and capability filters", () => {
    expect(
      catalogQueryFromOptions({
        query: "shopify",
        category: "ecommerce",
        badge: "native",
        capability: "orders",
      }),
    ).toEqual({
      q: "shopify",
      category: "ecommerce",
      badge: "native",
      capability: "orders",
    });
  });

  it("builds recipe query params and only sends available when explicitly true", () => {
    expect(
      recipeQueryFromOptions({
        query: "lead",
        source: "typeform",
        target: "inbound-webhook",
        provider: "Zapier",
        available: true,
      }),
    ).toEqual({
      q: "lead",
      source: "typeform",
      target: "inbound-webhook",
      provider: "Zapier",
      available: true,
    });

    expect(recipeQueryFromOptions({ available: false })).toEqual({});
  });

  it("rejects unknown badges and capabilities before calling the API", () => {
    expect(normalizeBadge("native")).toBe("native");
    expect(normalizeCapability("warehouse_export")).toBe("warehouse_export");
    expect(() => normalizeBadge("first_party")).toThrow(/Unsupported badge/);
    expect(() => normalizeCapability("orders_v2")).toThrow(
      /Unsupported capability/,
    );
  });

  it("accepts safe integration ids and slash-separated slugs", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(normalizeIntegrationId(" shopify ")).toBe("shopify");
    expect(normalizeIntegrationId("hubspot/crm")).toBe("hubspot/crm");
    expect(normalizeIntegrationId("recipe/a", "recipe id")).toBe("recipe/a");
    expect(normalizeIntegrationId("conn/1", "native integration id")).toBe(
      "conn/1",
    );
    expect(normalizeIntegrationId("")).toBeNull();
    expect(normalizeIntegrationId("../admin")).toBeNull();
    expect(normalizeIntegrationId("admin/")).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalled();
  });

  it("validates native managed integration families", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(normalizeNativeFamily("CRM")).toBe("crm");
    expect(normalizeNativeFamily("commerce")).toBe("commerce");
    expect(normalizeNativeFamily("marketing")).toBe("marketing");
    expect(normalizeNativeFamily("subscriptions")).toBe("subscriptions");
    expect(normalizeNativeFamily("warehouse")).toBe("warehouse");
    expect(supportsNativeIngest("marketing")).toBe(false);
    expect(normalizeNativeFamily("erp")).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported native integration family"),
    );
  });

  it("validates chat integration providers", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(normalizeChatProvider("Discord")).toBe("discord");
    expect(normalizeChatProvider("teams")).toBe("teams");
    expect(normalizeChatProvider("matrix")).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported chat integration provider"),
    );
  });

  it("builds native create and lifecycle payloads from CLI options", () => {
    expect(
      nativeCreateInputFromOptions({
        provider: "hubspot",
        name: "HubSpot production",
        config: '{"portal_id":"123","credentials_ref":"vault://crm/ignored"}',
        credentialRef: "vault://crm/hubspot",
        scopes: "profiles:read, events:write",
      }),
    ).toEqual({
      provider: "hubspot",
      name: "HubSpot production",
      credentials_ref: "vault://crm/hubspot",
      settings: { portal_id: "123" },
      scopes: ["profiles:read", "events:write"],
    });

    expect(
      nativeLifecycleInputFromOptions({
        cursor: "crm_cursor_1",
        payload:
          '{"contacts":[{"email":"ada@example.com"}],"events":[{"email":"ada@example.com","event_name":"Deal Stage Changed"}]}',
      }),
    ).toEqual({
      cursor: "crm_cursor_1",
      contacts: [{ email: "ada@example.com" }],
      events: [{ email: "ada@example.com", event_name: "Deal Stage Changed" }],
    });

    expect(nativeLifecycleInputFromOptions({ cursor: "crm_cursor_2" })).toEqual(
      {
        cursor: "crm_cursor_2",
      },
    );

    expect(
      nativeCreateInputFromOptions(
        {
          provider: "typeform",
          name: "Typeform",
          config: '{"form_id":"abc"}',
          credentialRef: "vault://lead/typeform",
        },
        "lead",
      ),
    ).toEqual({
      provider: "typeform",
      name: "Typeform",
      credentials_ref: "vault://lead/typeform",
      settings: { form_id: "abc" },
    });

    expect(() => nativeCreateInputFromOptions({})).toThrow(/--provider/);
    expect(() =>
      nativeCreateInputFromOptions({ provider: "hubspot", config: "[]" }),
    ).toThrow(/JSON object/);

    expect(
      nativeCreateInputFromOptions(
        {
          provider: "segment",
          name: "Segment production",
          credentialRef: "vault://analytics/segment",
          config:
            '{"source_id":"src_123","credentials_ref":"vault://analytics/ignored"}',
        },
        "analytics",
      ),
    ).toEqual({
      provider: "segment",
      name: "Segment production",
      credentials_ref: "vault://analytics/segment",
      settings: { source_id: "src_123" },
    });

    expect(
      nativeLifecycleInputFromOptions(
        {
          cursor: "cur_1",
          payload:
            '{"profiles":[{"email":"ada@example.com"}],"events":[{"email":"ada@example.com","event_name":"Viewed"}]}',
        },
        "analytics",
      ),
    ).toEqual({
      cursor: "cur_1",
      profiles: [{ email: "ada@example.com" }],
      events: [{ email: "ada@example.com", event_name: "Viewed" }],
    });

    expect(
      nativeLifecycleInputFromOptions(
        { cursor: "analytics_cursor_2" },
        "analytics",
      ),
    ).toEqual({ cursor: "analytics_cursor_2" });

    expect(
      nativeCreateInputFromOptions(
        {
          provider: "klaviyo",
          name: "Klaviyo production",
          credentialRef: "vault://marketing/klaviyo",
          config:
            '{"account_id":"acct_123","credentials_ref":"vault://marketing/ignored"}',
        },
        "marketing",
      ),
    ).toEqual({
      provider: "klaviyo",
      name: "Klaviyo production",
      credentials_ref: "vault://marketing/klaviyo",
      settings: { account_id: "acct_123" },
    });

    expect(
      nativeLifecycleInputFromOptions(
        {
          cursor: "klaviyo_cursor_1",
          metadata: '{"source_event_job_id":"job_123"}',
        },
        "marketing",
      ),
    ).toEqual({
      cursor: "klaviyo_cursor_1",
      metadata: { source_event_job_id: "job_123" },
    });
  });

  it("builds native ingest payloads only from JSON objects", () => {
    expect(
      nativeIngestInputFromOptions({ payload: '{"email":"ada@example.com"}' }),
    ).toEqual({
      email: "ada@example.com",
    });
    expect(supportsNativeIngest("lead")).toBe(true);
    expect(supportsNativeIngest("crm")).toBe(false);
    expect(supportsNativeIngest("warehouse")).toBe(false);
    expect(() => nativeIngestInputFromOptions({})).toThrow(/--payload/);
    expect(() => nativeIngestInputFromOptions({ payload: "[]" })).toThrow(
      /JSON object/,
    );
  });

  it("builds audience destination payloads for ad-network connectors", () => {
    expect(
      audienceDestinationCreateInputFromOptions({
        provider: "meta",
        listId: "list_123",
        externalAudienceId: "aud_123",
        config:
          '{"credentials_ref":"vault://ads/meta","audience_id":"aud_123"}',
      }),
    ).toEqual({
      provider: "meta",
      list_id: "list_123",
      external_audience_id: "aud_123",
      config: { credentials_ref: "vault://ads/meta", audience_id: "aud_123" },
    });

    expect(() =>
      audienceDestinationCreateInputFromOptions({
        provider: "meta",
        listId: "list_123",
        config: '{"access_token":"tok","audience_id":"aud_123"}',
      }),
    ).toThrow(/credential references/);
    expect(() =>
      audienceDestinationCreateInputFromOptions({
        provider: "meta",
        listId: "list_123",
        config: '{"oauth":{"access_token":"tok"},"audience_id":"aud_123"}',
      }),
    ).toThrow(/oauth\.access_token/);
    expect(() =>
      audienceDestinationCreateInputFromOptions({
        provider: "meta",
        listId: "list_123",
        config:
          '{"credentials_ref":"vault://ads/meta","audience_id":"aud_123","api_base":"https://example.invalid"}',
      }),
    ).toThrow(/api_base/);

    expect(
      audienceDestinationUpdateInputFromOptions({
        status: "paused",
        config: '{"audience_id":"aud_456"}',
      }),
    ).toEqual({
      status: "paused",
      config: { audience_id: "aud_456" },
    });

    expect(() =>
      audienceDestinationCreateInputFromOptions({ provider: "meta" }),
    ).toThrow(/--list-id or --segment-id/);
    expect(() => audienceDestinationUpdateInputFromOptions({})).toThrow(
      /--status/,
    );
  });

  it("builds chat integration create and update payloads", () => {
    expect(
      chatIntegrationCreateInputFromOptions({
        url: "https://discord.com/api/webhooks/123/token",
        channelHint: "#growth",
        events: "subscriber.created, campaign.sent",
      }),
    ).toEqual({
      url: "https://discord.com/api/webhooks/123/token",
      channel_hint: "#growth",
      events: ["subscriber.created", "campaign.sent"],
    });

    expect(
      chatIntegrationUpdateInputFromOptions({
        events: "campaign.sent",
        enabled: "false",
      }),
    ).toEqual({
      events: ["campaign.sent"],
      enabled: false,
    });

    expect(() =>
      chatIntegrationCreateInputFromOptions({ events: "subscriber.created" }),
    ).toThrow(/--url/);
    expect(() =>
      chatIntegrationCreateInputFromOptions({ url: "https://example.invalid" }),
    ).toThrow(/--events/);
    expect(() =>
      chatIntegrationUpdateInputFromOptions({ enabled: "maybe" }),
    ).toThrow(/--enabled/);
  });

  it("builds commerce native payloads with credential references", () => {
    expect(
      nativeCreateInputFromOptions(
        {
          provider: "bigcommerce",
          shopDomain: "store-123",
          config:
            '{"store_hash":"abc123","credential_ref":"vault://commerce/bigcommerce"}',
          scopes: "orders:read, products:read",
        },
        "commerce",
      ),
    ).toEqual({
      provider: "bigcommerce",
      shop_domain: "store-123",
      credential_ref: "vault://commerce/bigcommerce",
      scopes: ["orders:read", "products:read"],
      settings: { store_hash: "abc123" },
    });

    expect(
      nativeLifecycleInputFromOptions(
        {
          cursor: "commerce_cursor_1",
          payload:
            '{"orders":[{"source_id":"order_1","customer_email":"ada@example.com"}]}',
        },
        "commerce",
      ),
    ).toEqual({
      cursor: "commerce_cursor_1",
      orders: [{ source_id: "order_1", customer_email: "ada@example.com" }],
    });

    expect(() =>
      nativeCreateInputFromOptions(
        { provider: "bigcommerce", credentials: '{"access_token":"secret"}' },
        "commerce",
      ),
    ).toThrow(/credential references/);
  });

  it("builds warehouse native payloads with object selection and supported run fields", () => {
    expect(
      nativeCreateInputFromOptions(
        {
          provider: "snowflake",
          name: "Snowflake prod",
          credentialRef: "vault://warehouse/snowflake",
          direction: "export",
          cadence: "daily",
          backfillDays: 365,
          objects: "profiles, events, catalog",
          config:
            '{"account":"acct","warehouse":"COMPUTE_WH","database":"POSTWAVE","schema":"PUBLIC"}',
        },
        "warehouse",
      ),
    ).toEqual({
      provider: "snowflake",
      name: "Snowflake prod",
      credentials_ref: "vault://warehouse/snowflake",
      direction: "export",
      cadence: "daily",
      backfill_days: 365,
      object_selection: ["profiles", "events", "catalog"],
      config: {
        account: "acct",
        warehouse: "COMPUTE_WH",
        database: "POSTWAVE",
        schema: "PUBLIC",
      },
    });

    expect(
      nativeLifecycleInputFromOptions(
        {
          objects: "profiles,events",
          payload:
            '{"direction":"import","input_uri":"s3://postwave/imports/events.jsonl","import_rows":[{"email":"ada@example.com","event_name":"viewed"}]}',
        },
        "warehouse",
      ),
    ).toEqual({
      direction: "import",
      input_uri: "s3://postwave/imports/events.jsonl",
      import_rows: [{ email: "ada@example.com", event_name: "viewed" }],
      object_selection: ["profiles", "events"],
    });
    expect(() =>
      nativeLifecycleInputFromOptions({ since: "2026-06-01" }, "warehouse"),
    ).toThrow(/do not accept --cursor/);
    expect(() =>
      nativeLifecycleInputFromOptions(
        { metadata: '{"ticket":"ops-42"}' },
        "warehouse",
      ),
    ).toThrow(/metrics are server-generated/);

    expect(() =>
      nativeCreateInputFromOptions({ provider: "snowflake" }, "warehouse"),
    ).toThrow(/--name/);
    expect(() =>
      nativeCreateInputFromOptions(
        { provider: "snowflake", name: "Snowflake", backfillDays: 5000 },
        "warehouse",
      ),
    ).toThrow(/--backfill-days/);
  });
});

describe("integration table rows", () => {
  it("compacts catalog items for table output without losing badge honesty", () => {
    const items: IntegrationCatalogItem[] = [
      {
        slug: "shopify",
        name: "Shopify",
        category: "ecommerce",
        badge: "native",
        runtime_status: "available",
        summary: "Commerce sync",
        capabilities: ["profiles", "orders", "products", "events", "segments"],
        native: true,
      },
    ];

    expect(compactCatalogRows(items)).toEqual([
      {
        slug: "shopify",
        name: "Shopify",
        category: "ecommerce",
        badge: "native",
        status: "available",
        native: true,
        capabilities: "profiles,orders,products,events +1",
      },
    ]);
  });

  it("compacts connection, recipe, coverage, and stack rows", () => {
    const connections: IntegrationConnection[] = [
      {
        slug: "hubspot",
        name: "HubSpot",
        category: "crm",
        badge: "native",
        runtime_status: "available",
        connected: true,
        status: "healthy",
        count: 1,
        primary_connection_id: "crm_1",
        last_sync_at: null,
        health_state: "ok",
        health_message: "Ready",
      },
    ];
    const recipes: IntegrationRecipe[] = [
      {
        id: "typeform-leads-inbound-webhook",
        name: "Typeform leads to Moosewave",
        provider: "Webhook",
        source_slug: "typeform",
        target_slug: "inbound-webhook",
        summary: "Capture leads",
        badge: "webhook",
        available: true,
        estimated_minutes: 10,
        capabilities: ["profiles", "events"],
        steps: [],
        blueprint: {
          trigger: "form.completed",
          destination: "Moosewave inbound webhook",
          postwave_surface: "inbound_webhooks",
        },
      },
    ];
    const coverage: IntegrationCategoryCoverage[] = [
      {
        key: "ecommerce",
        label: "Ecommerce",
        total: 40,
        native_managed: 8,
        native_verified: 3,
        native_partial: 4,
        native_delegated: 1,
        bridge_ready: 20,
        planned: 12,
        available_recipes: 16,
        maturity: "depth-building",
      },
    ];
    const stacks: IntegrationCustomerStackCoverage[] = [
      {
        key: "newsletter-commerce",
        name: "Newsletter plus commerce",
        segment: "commerce",
        summary: "Core DTC stack",
        status: "covered",
        coverage_pct: 92,
        required_covered: 11,
        required_total: 12,
        optional_covered: 7,
        optional_total: 10,
        native_managed: 8,
        bridge_ready: 9,
        components: [],
        next_actions: [],
      },
    ];

    expect(compactConnectionRows(connections)[0]).toMatchObject({
      slug: "hubspot",
      connected: true,
      primary_connection_id: "crm_1",
    });
    expect(compactRecipeRows(recipes)[0]).toMatchObject({
      id: "typeform-leads-inbound-webhook",
      provider: "Webhook",
      available: true,
    });
    expect(compactCoverageRows(coverage)[0]).toMatchObject({
      category: "ecommerce",
      native: 8,
      verified: 3,
      partial: 4,
      delegated: 1,
      maturity: "depth-building",
    });
    expect(compactStackRows(stacks)[0]).toMatchObject({
      key: "newsletter-commerce",
      coverage_pct: 92,
      required: "11/12",
    });
  });

  it("compacts readiness report checks for table output", () => {
    expect(
      compactReadinessRows({
        schema_version: "2026-06.integrations.readiness.v1",
        ready: true,
        marketable_public_claim: true,
        public_claim:
          "350+ integrations, including 60 native Moosewave-managed connectors.",
        public_entries: 350,
        target_public_entries: 350,
        native_managed: 60,
        target_native_managed: 60,
        native_verified: 60,
        target_native_verified: 60,
        native_partial: 0,
        native_delegated: 0,
        bridge_ready: 220,
        available_recipes: 180,
        public_parity: true,
        native_parity: true,
        native_verification_parity: true,
        issue_counts: {},
        issues: [],
        recommendations: [],
        checks: [
          {
            key: "public_catalog_parity",
            label: "Public catalog parity",
            state: "pass",
            severity: "ok",
            count: 350,
            message: "350/350 visible integrations cataloged.",
          },
        ],
      }),
    ).toEqual([
      {
        check: "public_catalog_parity",
        state: "pass",
        severity: "ok",
        count: 350,
        message: "350/350 visible integrations cataloged.",
      },
    ]);
  });

  it("compacts native provider, connection, and run rows", () => {
    const providers: NativeIntegrationProviderSpec[] = [
      {
        key: "hubspot",
        name: "HubSpot",
        category: "crm",
        auth_modes: ["oauth", "api_key"],
        sync_objects: ["profiles", "events", "lists", "segments", "deals"],
        webhook_topics: ["contact.created"],
      },
    ];
    const connections: NativeIntegration[] = [
      {
        id: "conn/1",
        provider: "hubspot",
        name: "HubSpot production",
        status: "active",
        health_state: "ok",
        last_sync_at: "2026-06-17T00:00:00Z",
      },
    ];
    const runs: NativeIntegrationRun[] = [
      {
        id: "run_1",
        integration_id: "conn/1",
        provider: "hubspot",
        action: "sync",
        status: "succeeded",
        attempts: 1,
        started_at: "2026-06-17T00:00:00Z",
        completed_at: "2026-06-17T00:01:00Z",
      },
    ];

    expect(compactNativeProviderRows(providers)).toEqual([
      {
        key: "hubspot",
        name: "HubSpot",
        category: "crm",
        auth_modes: "oauth,api_key",
        sync_objects: "profiles,events,lists,segments +1",
        webhook_topics: "contact.created",
      },
    ]);
    expect(compactNativeConnectionRows(connections)[0]).toMatchObject({
      id: "conn/1",
      provider: "hubspot",
      health: "ok",
    });
    expect(compactNativeRunRows(runs)[0]).toMatchObject({
      id: "run_1",
      action: "sync",
      status: "succeeded",
      attempts: 1,
    });
  });

  it("compacts audience destination and job rows", () => {
    expect(
      compactAudienceDestinationRows([
        {
          id: "aud_1",
          provider: "meta",
          list_id: "list_1",
          segment_id: null,
          external_audience_id: "external_1",
          status: "active",
          last_synced_at: null,
          updated_at: "2026-06-17T00:00:00Z",
        },
      ]),
    ).toEqual([
      {
        id: "aud_1",
        provider: "meta",
        status: "active",
        list_id: "list_1",
        segment_id: "",
        external_audience_id: "external_1",
        last_synced_at: "",
        updated_at: "2026-06-17T00:00:00Z",
      },
    ]);

    expect(
      compactAudienceDestinationJobRows([
        {
          id: "job_1",
          destination_id: "aud_1",
          status: "succeeded",
          members_synced: 42,
          external_job_id: "req_123",
          external_audience_id: "external_1",
          provider_message: "accepted",
          provider_status: "PROCESSING",
          provider_checked_at: "2026-06-17T00:05:00Z",
          provider_next_check_at: "2026-06-17T00:10:00Z",
          provider_poll_attempts: 2,
          started_at: "2026-06-17T00:00:00Z",
          finished_at: null,
          error: "",
        },
      ]),
    ).toEqual([
      {
        id: "job_1",
        destination_id: "aud_1",
        status: "succeeded",
        members_synced: 42,
        external_job_id: "req_123",
        external_audience_id: "external_1",
        provider_message: "accepted",
        provider_status: "PROCESSING",
        provider_checked_at: "2026-06-17T00:05:00Z",
        provider_next_check_at: "2026-06-17T00:10:00Z",
        provider_poll_attempts: 2,
        started_at: "2026-06-17T00:00:00Z",
        finished_at: "",
        error: "",
      },
    ]);

    expect(
      compactAudienceSyncRunRows([
        {
          id: "run_1",
          sync_id: "sync_1",
          status: "succeeded",
          rows_exported: 42,
          batches_sent: 1,
          external_job_id: "req_123",
          external_audience_id: "external_1",
          provider_message: "accepted",
          provider_status: "PROCESSING",
          provider_checked_at: "2026-06-17T00:05:00Z",
          provider_next_check_at: "2026-06-17T00:10:00Z",
          provider_poll_attempts: 2,
          excluded_count: 3,
          started_at: "2026-06-17T00:00:00Z",
          finished_at: null,
          error: "",
        },
      ]),
    ).toEqual([
      {
        id: "run_1",
        sync_id: "sync_1",
        status: "succeeded",
        rows_exported: 42,
        batches_sent: 1,
        external_job_id: "req_123",
        external_audience_id: "external_1",
        provider_message: "accepted",
        provider_status: "PROCESSING",
        provider_checked_at: "2026-06-17T00:05:00Z",
        provider_next_check_at: "2026-06-17T00:10:00Z",
        provider_poll_attempts: 2,
        excluded_count: 3,
        started_at: "2026-06-17T00:00:00Z",
        finished_at: "",
        error: "",
      },
    ]);
  });

  it("compacts chat integration rows", () => {
    expect(
      compactChatIntegrationRows([
        {
          id: "discord_1",
          channel_hint: "#growth",
          events: [
            "subscriber.created",
            "campaign.sent",
            "subscriber.unsubscribed",
            "sms.replied",
            "sms.failed",
          ],
          enabled: true,
          last_delivery_status: "success",
          last_delivery_at: null,
          last_delivery_error: "",
          updated_at: "2026-06-17T00:00:00Z",
        },
      ]),
    ).toEqual([
      {
        id: "discord_1",
        channel_hint: "#growth",
        events:
          "subscriber.created,campaign.sent,subscriber.unsubscribed,sms.replied +1",
        enabled: true,
        last_delivery_status: "success",
        last_delivery_at: "",
        last_delivery_error: "",
        updated_at: "2026-06-17T00:00:00Z",
      },
    ]);
  });
});
