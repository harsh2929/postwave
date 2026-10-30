// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";

import { integrationTools } from "../../src/tools/integrations.js";

function nativeResource(opts: { includeRuns?: boolean } = {}) {
  const resource = {
    providers: vi.fn().mockResolvedValue({ items: [] }),
    list: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn().mockResolvedValue({ id: "conn_1" }),
    get: vi.fn().mockResolvedValue({ id: "conn_1" }),
    sync: vi.fn().mockResolvedValue({ status: "queued" }),
    backfill: vi.fn().mockResolvedValue({ status: "queued" }),
    ingest: vi.fn().mockResolvedValue({ status: "accepted" }),
    pause: vi.fn().mockResolvedValue({ status: "paused" }),
    disconnect: vi.fn().mockResolvedValue({ status: "deleted" }),
  };
  if (opts.includeRuns === false) return resource;
  return {
    ...resource,
    runs: vi
      .fn()
      .mockResolvedValue({ items: [{ id: "run_1", status: "succeeded" }] }),
  };
}

function makeClient() {
  const integrations = {
    catalog: vi.fn().mockResolvedValue({ items: [] }),
    connections: vi.fn().mockResolvedValue({ items: [] }),
  };
  const audienceDestinations = {
    providers: vi.fn().mockResolvedValue({ providers: ["meta", "google_ads"] }),
    list: vi
      .fn()
      .mockResolvedValue({ items: [{ id: "aud/1", provider: "meta" }] }),
    create: vi.fn().mockResolvedValue({ id: "aud/1", provider: "meta" }),
    get: vi.fn().mockResolvedValue({ id: "aud/1", provider: "meta" }),
    update: vi
      .fn()
      .mockResolvedValue({ id: "aud/1", provider: "meta", status: "paused" }),
    readiness: vi.fn().mockResolvedValue({ provider: "meta", ready: true }),
    preview: vi
      .fn()
      .mockResolvedValue({ destination_id: "aud/1", deliverable: 10 }),
    sync: vi.fn().mockResolvedValue({ status: "queued", job: { id: "job_1" } }),
    jobs: vi
      .fn()
      .mockResolvedValue({ items: [{ id: "job_1", status: "succeeded" }] }),
    jobDiagnostics: vi.fn().mockResolvedValue({
      diagnostics: { provider: "google_ads", external_job_id: "req_123" },
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const commerce = nativeResource({ includeRuns: false });
  const warehouse = nativeResource();
  const crm = nativeResource();
  const lead = nativeResource();
  const reviews = nativeResource();
  const loyalty = nativeResource();
  const support = nativeResource();
  const analytics = nativeResource();
  const marketing = nativeResource();
  return {
    client: {
      audienceDestinations,
      integrations,
      nativeIntegrations: {
        commerce,
        crm,
        lead,
        reviews,
        loyalty,
        subscriptions: nativeResource(),
        support,
        analytics,
        marketing,
        warehouse,
      },
    },
    analytics,
    audienceDestinations,
    commerce,
    crm,
    integrations,
    lead,
    loyalty,
    marketing,
    reviews,
    support,
    warehouse,
  };
}

describe("integrationTools", () => {
  it("exposes native and catalog tools with zod schemas", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = integrationTools(client as any);
    expect(tools.map((t) => t.name)).toEqual([
      "integrations_catalog",
      "integrations_connections",
      "audience_destination_providers",
      "audience_destination_list",
      "audience_destination_create",
      "audience_destination_get",
      "audience_destination_update",
      "audience_destination_readiness",
      "audience_destination_preview",
      "audience_destination_sync",
      "audience_destination_jobs",
      "audience_destination_job_diagnostics",
      "audience_destination_disconnect",
      "native_integration_providers",
      "native_integration_list",
      "native_integration_get",
      "native_integration_create",
      "native_integration_sync",
      "native_integration_backfill",
      "native_integration_ingest",
      "native_integration_pause",
      "native_integration_disconnect",
      "native_integration_runs",
    ]);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodObject);
    expect(
      tools.find((t) => t.name === "native_integration_providers")?.description,
    ).toContain("static release-held catalog");
    expect(
      tools.find((t) => t.name === "native_integration_list")?.description,
    ).toContain("minimized historical projection");
    expect(
      tools.find((t) => t.name === "native_integration_get")?.description,
    ).toContain("tenant-bound minimized historical projection");
    const readme = readFileSync(
      new URL("../../README.md", import.meta.url),
      "utf8",
    );
    expect(readme).toMatch(
      /Support provider discovery is static[\s\S]*limit` \(1–100, default 50\)[\s\S]*opaque `cursor`/u,
    );
    expect(readme).toMatch(
      /Support lifecycle and run-history tools fail locally with `support_integration_runtime_held` and send no SDK request/u,
    );
    const generated = JSON.parse(
      readFileSync(
        new URL(
          "../../../../apps/web/src/lib/mcp-tool-details.generated.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Array<{
      name: string;
      inputFields: Array<{
        name: string;
        kind: string;
        optional: boolean;
        description?: string;
        enumValues?: string[];
      }>;
    }>;
    expect(
      generated.find((tool) => tool.name === "native_integration_get")
        ?.inputFields,
    ).toEqual([
      {
        name: "family",
        kind: "enum",
        optional: false,
        enumValues: [
          "commerce",
          "crm",
          "lead",
          "reviews",
          "loyalty",
          "subscriptions",
          "support",
          "analytics",
          "marketing",
          "warehouse",
        ],
      },
      {
        name: "id",
        kind: "string",
        optional: false,
        description: "Lowercase canonical native-integration UUID",
      },
    ]);
  });

  it("forwards catalog filters to the SDK facade", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = integrationTools(c.client as any).find(
      (t) => t.name === "integrations_catalog",
    )!;

    await tool.handler({ q: "shopify", badge: "native", capability: "orders" });

    expect(c.integrations.catalog).toHaveBeenCalledWith({
      q: "shopify",
      badge: "native",
      capability: "orders",
    });
  });

  it("paginates support reads and rejects hostile or cross-family pagination", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = integrationTools(c.client as any).find(
      (candidate) => candidate.name === "native_integration_list",
    )!;
    const cursor = "opaque+/=?&%cursor";

    await tool.handler({ family: "support" });
    await tool.handler({ family: "support", limit: 17, cursor });

    expect(c.support.list.mock.calls).toEqual([[{}], [{ limit: 17, cursor }]]);
    for (const input of [
      { family: "support", limit: 0 },
      { family: "support", limit: 101 },
      { family: "support", limit: 1.5 },
      { family: "support", limit: "10" },
      { family: "support", cursor: "" },
      { family: "support", cursor: " surrounded" },
      { family: "support", cursor: "surrounded " },
      { family: "support", cursor: "opaque\u0000cursor" },
      { family: "support", cursor: "opaque\u202ecursor" },
      { family: "support", cursor: "x".repeat(4097) },
      { family: "support", cursor: 123 },
    ]) {
      expect(
        tool.schema.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
    }
    expect(
      tool.schema.safeParse({
        family: "support",
        limit: 100,
        cursor,
      }).success,
    ).toBe(true);
    await expect(
      tool.handler({ family: "crm", limit: 10, cursor }),
    ).rejects.toThrow(
      "native_integration_list: limit and cursor pagination are available only for family=support",
    );
    expect(c.crm.list).not.toHaveBeenCalled();
  });

  it("gets a minimized support detail only for an exact family and canonical UUID", async () => {
    const c = makeClient();
    const tool = integrationTools(c.client as any).find(
      (candidate) => candidate.name === "native_integration_get",
    )!;
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    const id = "22222222-2222-4222-8222-22222222222a";
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const projection = {
      tenantId,
      tenant_id: tenantId,
      id,
      provider: "zendesk",
      name: "Historical Zendesk record",
      status: "paused",
      runtime_status: "held",
      hold_code: "support_integration_runtime_held",
      credential_configured: false,
      created_at: "2026-08-25T10:00:00Z",
      updated_at: "2026-08-25T10:01:00Z",
    };
    c.support.get.mockResolvedValueOnce(projection);

    await expect(tool.handler({ family: "support", id })).resolves.toEqual(
      projection,
    );
    expect(c.support.get).toHaveBeenCalledWith(id);
    expect(c.support.list).not.toHaveBeenCalled();
    expect(c.support.create).not.toHaveBeenCalled();

    for (const input of [
      { family: "unknown", id },
      { family: "support", id: "conn_1" },
      { family: "support", id: id.toUpperCase() },
      { family: "support", id: ` ${id}` },
      { family: "support", id: `${id} ` },
      { family: "support", id: `${id}\n` },
      { family: "support", id: `${id}\u202e` },
      { family: "support", id, extra: true },
    ]) {
      expect(
        tool.schema.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
    }
    expect(tool.schema.safeParse({ family: "support", id }).success).toBe(
      true,
    );
  });

  it("dispatches native family payloads to commerce and warehouse SDK resources", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = integrationTools(c.client as any);
    const create = tools.find((t) => t.name === "native_integration_create")!;
    const sync = tools.find((t) => t.name === "native_integration_sync")!;
    const ingest = tools.find((t) => t.name === "native_integration_ingest")!;
    const runs = tools.find((t) => t.name === "native_integration_runs")!;

    await create.handler({
      family: "warehouse",
      provider: "snowflake",
      name: "Snowflake prod",
      credential_ref: "vault://warehouse/snowflake",
      objects: ["profiles", "events"],
      direction: "export",
      cadence: "daily",
      backfill_days: 365,
      config: { account: "acct" },
    });
    await sync.handler({
      family: "warehouse",
      id: "warehouse/1",
      cursor: "ignored_cursor",
      since: "2026-06-01T00:00:00Z",
      metadata: { unsupported: true },
      objects: ["profiles"],
      payload: {
        direction: "import",
        import_rows: [{ email: "ada@example.com", event_name: "Viewed" }],
      },
    });
    await sync.handler({
      family: "commerce",
      id: "commerce/1",
      cursor: "cur_1",
      objects: ["orders"],
    });
    await create.handler({
      family: "crm",
      provider: "hubspot",
      name: "HubSpot production",
      credential_ref: "vault://crm/hubspot",
      config: { portal_id: "123" },
    });
    await sync.handler({
      family: "crm",
      id: "crm/1",
      cursor: "crm_cursor_1",
      payload: {
        contacts: [{ email: "ada@example.com" }],
        events: [
          { email: "ada@example.com", event_name: "Deal Stage Changed" },
        ],
      },
    });
    await create.handler({
      family: "reviews",
      provider: "yotpo",
      name: "Yotpo reviews",
      credential_ref: "vault://reviews/yotpo",
      config: { store_id: "store_123" },
    });
    await sync.handler({
      family: "reviews",
      id: "review/1",
      cursor: "review_cursor_1",
      payload: {
        reviews: [
          { source_id: "r1", reviewer_email: "ada@example.com", rating: 5 },
        ],
      },
    });
    await create.handler({
      family: "loyalty",
      provider: "smile",
      name: "Smile loyalty",
      credential_ref: "vault://loyalty/smile",
      config: { shop_domain: "acme.myshopify.com" },
    });
    await sync.handler({
      family: "loyalty",
      id: "loyalty/1",
      cursor: "loyalty_cursor_1",
      payload: {
        members: [{ email: "vip@example.com", points_balance: 1200 }],
        events: [
          { email: "vip@example.com", event_name: "loyalty.points_earned" },
        ],
      },
    });
    await create.handler({
      family: "lead",
      provider: "typeform",
      name: "Typeform leads",
      credential_ref: "vault://lead/typeform",
      config: { form_id: "form_123" },
    });
    await sync.handler({
      family: "lead",
      id: "lead/1",
      cursor: "lead_cursor_1",
      payload: {
        submissions: [{ email: "ada@example.com", form_id: "form_123" }],
      },
    });
    await create.handler({
      family: "subscriptions",
      provider: "recharge",
      name: "Recharge production",
      credential_ref: "vault://subscriptions/recharge",
      config: { store_domain: "acme.myshopify.com" },
    });
    await sync.handler({
      family: "subscriptions",
      id: "subscription/1",
      cursor: "sub_cursor_1",
      payload: {
        subscriptions: [
          { email: "ada@example.com", subscription_id: "sub_123" },
        ],
        shipments: [{ email: "ada@example.com", tracking_number: "trk_123" }],
        events: [
          { email: "ada@example.com", event_name: "subscription.renewed" },
        ],
      },
    });
    await ingest.handler({
      family: "lead",
      id: "lead/1",
      payload: { email: "ada@example.com", source_id: "evt_1" },
    });
    await ingest.handler({
      family: "subscriptions",
      id: "subscription/1",
      payload: { email: "ada@example.com", event_name: "shipment.delivered" },
    });
    await create.handler({
      family: "analytics",
      provider: "segment",
      name: "Segment production",
      credential_ref: "vault://analytics/segment",
      config: { source_id: "src_123" },
    });
    await sync.handler({
      family: "analytics",
      id: "analytics/1",
      cursor: "cur_1",
      payload: {
        profiles: [{ email: "ada@example.com" }],
        events: [{ email: "ada@example.com", event_name: "Viewed" }],
      },
    });
    await create.handler({
      family: "marketing",
      provider: "mailerlite",
      name: "MailerLite production",
      credential_ref: "vault://marketing/mailerlite",
      config: { workspace_id: "workspace_123" },
    });
    await sync.handler({
      family: "marketing",
      id: "marketing/1",
      cursor: "mailerlite_cursor_1",
      metadata: { import_cursor: "subscribers:500" },
      payload: {
        run_mode: "retry",
      },
    });
    const out = await runs.handler({ family: "commerce", id: "commerce/1" });

    expect(c.warehouse.create).toHaveBeenCalledWith({
      provider: "snowflake",
      name: "Snowflake prod",
      config: { account: "acct" },
      credentials_ref: "vault://warehouse/snowflake",
      object_selection: ["profiles", "events"],
      direction: "export",
      cadence: "daily",
      backfill_days: 365,
    });
    expect(c.warehouse.sync).toHaveBeenCalledWith("warehouse/1", {
      direction: "import",
      import_rows: [{ email: "ada@example.com", event_name: "Viewed" }],
      object_selection: ["profiles"],
    });
    expect(c.commerce.sync).toHaveBeenCalledWith("commerce/1", {
      cursor: "cur_1",
    });
    expect(c.crm.create).toHaveBeenCalledWith({
      provider: "hubspot",
      name: "HubSpot production",
      settings: { portal_id: "123" },
      credentials_ref: "vault://crm/hubspot",
    });
    expect(c.crm.sync).toHaveBeenCalledWith("crm/1", {
      cursor: "crm_cursor_1",
      contacts: [{ email: "ada@example.com" }],
      events: [{ email: "ada@example.com", event_name: "Deal Stage Changed" }],
    });
    expect(c.reviews.create).toHaveBeenCalledWith({
      provider: "yotpo",
      name: "Yotpo reviews",
      settings: { store_id: "store_123" },
      credentials_ref: "vault://reviews/yotpo",
    });
    expect(c.reviews.sync).toHaveBeenCalledWith("review/1", {
      cursor: "review_cursor_1",
      reviews: [
        { source_id: "r1", reviewer_email: "ada@example.com", rating: 5 },
      ],
    });
    expect(c.loyalty.create).toHaveBeenCalledWith({
      provider: "smile",
      name: "Smile loyalty",
      settings: { shop_domain: "acme.myshopify.com" },
      credentials_ref: "vault://loyalty/smile",
    });
    expect(c.loyalty.sync).toHaveBeenCalledWith("loyalty/1", {
      cursor: "loyalty_cursor_1",
      members: [{ email: "vip@example.com", points_balance: 1200 }],
      events: [
        { email: "vip@example.com", event_name: "loyalty.points_earned" },
      ],
    });
    expect(c.lead.create).toHaveBeenCalledWith({
      provider: "typeform",
      name: "Typeform leads",
      settings: { form_id: "form_123" },
      credentials_ref: "vault://lead/typeform",
    });
    expect(c.lead.sync).toHaveBeenCalledWith("lead/1", {
      cursor: "lead_cursor_1",
      submissions: [{ email: "ada@example.com", form_id: "form_123" }],
    });
    expect(
      c.client.nativeIntegrations.subscriptions.create,
    ).toHaveBeenCalledWith({
      provider: "recharge",
      name: "Recharge production",
      settings: { store_domain: "acme.myshopify.com" },
      credentials_ref: "vault://subscriptions/recharge",
    });
    expect(c.client.nativeIntegrations.subscriptions.sync).toHaveBeenCalledWith(
      "subscription/1",
      {
        cursor: "sub_cursor_1",
        subscriptions: [
          { email: "ada@example.com", subscription_id: "sub_123" },
        ],
        shipments: [{ email: "ada@example.com", tracking_number: "trk_123" }],
        events: [
          { email: "ada@example.com", event_name: "subscription.renewed" },
        ],
      },
    );
    expect(c.lead.ingest).toHaveBeenCalledWith("lead/1", {
      email: "ada@example.com",
      source_id: "evt_1",
    });
    expect(
      c.client.nativeIntegrations.subscriptions.ingest,
    ).toHaveBeenCalledWith("subscription/1", {
      email: "ada@example.com",
      event_name: "shipment.delivered",
    });
    expect(c.analytics.create).toHaveBeenCalledWith({
      provider: "segment",
      name: "Segment production",
      settings: { source_id: "src_123" },
      credentials_ref: "vault://analytics/segment",
    });
    expect(c.analytics.sync).toHaveBeenCalledWith("analytics/1", {
      cursor: "cur_1",
      profiles: [{ email: "ada@example.com" }],
      events: [{ email: "ada@example.com", event_name: "Viewed" }],
    });
    expect(c.marketing.create).toHaveBeenCalledWith({
      provider: "mailerlite",
      name: "MailerLite production",
      settings: { workspace_id: "workspace_123" },
      credentials_ref: "vault://marketing/mailerlite",
    });
    expect(c.marketing.sync).toHaveBeenCalledWith("marketing/1", {
      run_mode: "retry",
      cursor: "mailerlite_cursor_1",
      metadata: { import_cursor: "subscribers:500" },
    });
    expect(out).toMatchObject({
      family: "commerce",
      id: "commerce/1",
      supported: false,
    });
  });

  it("release-holds every support effect and run tool before SDK access", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = integrationTools(c.client as any);
    const attempts: Array<[string, Record<string, unknown>]> = [
      [
        "native_integration_create",
        { family: "support", provider: "zendesk", name: "Zendesk" },
      ],
      ["native_integration_sync", { family: "support", id: "support/1" }],
      ["native_integration_backfill", { family: "support", id: "support/1" }],
      [
        "native_integration_ingest",
        { family: "support", id: "support/1", payload: { secret: "raw" } },
      ],
      ["native_integration_pause", { family: "support", id: "support/1" }],
      ["native_integration_disconnect", { family: "support", id: "support/1" }],
      ["native_integration_runs", { family: "support", id: "support/1" }],
    ];
    for (const [name, input] of attempts) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      await expect(tool.handler(input)).rejects.toThrow(
        `${name}: support_integration_runtime_held`,
      );
    }
    for (const call of [
      c.support.create,
      c.support.sync,
      c.support.backfill,
      c.support.ingest,
      c.support.pause,
      c.support.disconnect,
    ]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect("runs" in c.support).toBe(true);
    if ("runs" in c.support) expect(c.support.runs).not.toHaveBeenCalled();
    expect(c.support.list).not.toHaveBeenCalled();
  });

  it("dispatches audience destination tools to the SDK resource", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = integrationTools(c.client as any);
    const create = tools.find((t) => t.name === "audience_destination_create")!;
    const get = tools.find((t) => t.name === "audience_destination_get")!;
    const update = tools.find((t) => t.name === "audience_destination_update")!;
    const readiness = tools.find(
      (t) => t.name === "audience_destination_readiness",
    )!;
    const preview = tools.find(
      (t) => t.name === "audience_destination_preview",
    )!;
    const sync = tools.find((t) => t.name === "audience_destination_sync")!;
    const jobs = tools.find((t) => t.name === "audience_destination_jobs")!;
    const diagnostics = tools.find(
      (t) => t.name === "audience_destination_job_diagnostics",
    )!;
    const disconnect = tools.find(
      (t) => t.name === "audience_destination_disconnect",
    )!;

    await create.handler({
      provider: "meta",
      list_id: "list_123",
      external_audience_id: "audience_123",
      config: { access_token: "tok", audience_id: "audience_123" },
    });
    await get.handler({ id: "aud/1" });
    await update.handler({ id: "aud/1", status: "paused" });
    await readiness.handler({
      provider: "meta",
      config: { audience_id: "audience_123" },
    });
    await preview.handler({ id: "aud/1" });
    await sync.handler({ id: "aud/1" });
    await jobs.handler({ id: "aud/1" });
    await diagnostics.handler({ id: "aud/1", job_id: "job/1" });
    const deleted = await disconnect.handler({ id: "aud/1" });

    expect(c.audienceDestinations.create).toHaveBeenCalledWith({
      provider: "meta",
      list_id: "list_123",
      external_audience_id: "audience_123",
      config: { access_token: "tok", audience_id: "audience_123" },
    });
    expect(c.audienceDestinations.get).toHaveBeenCalledWith("aud/1");
    expect(c.audienceDestinations.update).toHaveBeenCalledWith("aud/1", {
      status: "paused",
    });
    expect(c.audienceDestinations.readiness).toHaveBeenCalledWith("meta", {
      audience_id: "audience_123",
    });
    expect(c.audienceDestinations.preview).toHaveBeenCalledWith("aud/1");
    expect(c.audienceDestinations.sync).toHaveBeenCalledWith("aud/1");
    expect(c.audienceDestinations.jobs).toHaveBeenCalledWith("aud/1");
    expect(c.audienceDestinations.jobDiagnostics).toHaveBeenCalledWith(
      "aud/1",
      "job/1",
    );
    expect(c.audienceDestinations.disconnect).toHaveBeenCalledWith("aud/1");
    expect(deleted).toEqual({ id: "aud/1", status: "deleted" });
  });

  it("wraps SDK errors with the tool name", async () => {
    const c = makeClient();
    c.integrations.connections.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = integrationTools(c.client as any).find(
      (t) => t.name === "integrations_connections",
    )!;

    await expect(tool.handler({})).rejects.toThrow(
      /integrations_connections: boom/,
    );
  });
});
