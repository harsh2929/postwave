// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { migrationTools } from "../../src/tools/migration.js";

interface FakeMigrations {
  start: ReturnType<typeof vi.fn>;
  credentials: ReturnType<typeof vi.fn>;
  discover: ReturnType<typeof vi.fn>;
  dryRun: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  refreshSourceSession: ReturnType<typeof vi.fn>;
  verification: ReturnType<typeof vi.fn>;
  deltaImport: ReturnType<typeof vi.fn>;
  shadowCheck: ReturnType<typeof vi.fn>;
  startShadowMonitor: ReturnType<typeof vi.fn>;
  shadowMonitor: ReturnType<typeof vi.fn>;
  stopShadowMonitor: ReturnType<typeof vi.fn>;
  startSourceEvents: ReturnType<typeof vi.fn>;
  sourceEvents: ReturnType<typeof vi.fn>;
  stopSourceEvents: ReturnType<typeof vi.fn>;
  automationRebuilds: ReturnType<typeof vi.fn>;
  updateAutomationRebuild: ReturnType<typeof vi.fn>;
  rollbackRehearsal: ReturnType<typeof vi.fn>;
  pilotAcceptance: ReturnType<typeof vi.fn>;
  recordCutoverEvidence: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  rollbackStatus: ReturnType<typeof vi.fn>;
}

function makeClient(): {
  client: {
    migrations: FakeMigrations;
    request: ReturnType<typeof vi.fn>;
  };
  m: FakeMigrations;
  request: ReturnType<typeof vi.fn>;
} {
  const m: FakeMigrations = {
    start: vi.fn().mockResolvedValue({
      authorize_url: "https://example.invalid/auth",
      state: "st_abc",
    }),
    credentials: vi.fn().mockResolvedValue({
      job_id: "job_credentials",
      account_id: "pub_primary",
    }),
    discover: vi.fn().mockResolvedValue({ subscribers: 0, lists: 0 }),
    dryRun: vi.fn().mockResolvedValue({ job_id: "job_001" }),
    commit: vi.fn().mockResolvedValue({ job_id: "job_001" }),
    get: vi.fn().mockResolvedValue({
      id: "job_001",
      source: "activecampaign",
      status: "completed",
    }),
    refreshSourceSession: vi.fn().mockResolvedValue({
      id: "job_001",
      source: "activecampaign",
      status: "completed",
      source_session_expires_at: "2026-07-16T12:00:00Z",
    }),
    verification: vi.fn().mockResolvedValue({ subscribers_imported: 100 }),
    deltaImport: vi
      .fn()
      .mockResolvedValue({ job_id: "job_001", mode: "delta_import" }),
    shadowCheck: vi.fn().mockResolvedValue({
      job_id: "job_001",
      source: "activecampaign",
      needs_delta_import: false,
      deltas: [],
    }),
    startShadowMonitor: vi.fn().mockResolvedValue({
      monitor: { job_id: "job_001", enabled: true },
      history: [],
    }),
    shadowMonitor: vi.fn().mockResolvedValue({
      monitor: { job_id: "job_001", enabled: true },
      history: [],
    }),
    stopShadowMonitor: vi
      .fn()
      .mockResolvedValue({ job_id: "job_001", enabled: false }),
    startSourceEvents: vi.fn().mockResolvedValue({
      monitor: {
        job_id: "job_001",
        source: "hubspot",
        enabled: true,
        interval_seconds: 900,
      },
      events: [],
    }),
    sourceEvents: vi.fn().mockResolvedValue({
      monitor: {
        job_id: "job_001",
        source: "hubspot",
        enabled: true,
        interval_seconds: 900,
      },
      events: [],
    }),
    stopSourceEvents: vi
      .fn()
      .mockResolvedValue({ job_id: "job_001", enabled: false }),
    automationRebuilds: vi.fn().mockResolvedValue({
      items: [
        {
          rank: 1,
          name: "Welcome series",
          status: "not_started",
        },
      ],
    }),
    updateAutomationRebuild: vi.fn().mockResolvedValue({
      rank: 1,
      name: "Welcome series",
      status: "test_passed",
      test_evidence: "ticket-42",
    }),
    rollbackRehearsal: vi.fn().mockResolvedValue({
      job_id: "job_001",
      status: "pass",
    }),
    pilotAcceptance: vi.fn().mockResolvedValue({
      job_id: "job_001",
      source: "activecampaign",
      status: "pass",
      blockers: 0,
    }),
    recordCutoverEvidence: vi.fn().mockResolvedValue({
      job_id: "job_001",
      source: "activecampaign",
      status: "pass",
      blockers: 0,
    }),
    rollback: vi
      .fn()
      .mockResolvedValue({ job_id: "job_001", state: "running" }),
    rollbackStatus: vi.fn().mockResolvedValue({
      state: "running",
      subscribers_deleted: 10,
      subscribers_total: 100,
      started_at: "2026-07-15T09:00:00Z",
    }),
  };
  const request = vi.fn().mockResolvedValue({
    authorize_url: "https://example.invalid/reconnect",
    state: "st_reconnect",
  });
  return { client: { migrations: m, request }, m, request };
}

describe("migrationTools", () => {
  it("exposes exactly 23 tools with unique names", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    expect(tools).toHaveLength(23);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "migrate_automation_rebuild_list",
      "migrate_automation_rebuild_update",
      "migrate_commit",
      "migrate_credentials",
      "migrate_cutover_evidence",
      "migrate_delta_import",
      "migrate_discover",
      "migrate_dry_run",
      "migrate_pilot_acceptance",
      "migrate_rollback",
      "migrate_rollback_rehearsal",
      "migrate_rollback_status",
      "migrate_shadow_check",
      "migrate_shadow_monitor_start",
      "migrate_shadow_monitor_status",
      "migrate_shadow_monitor_stop",
      "migrate_source_events_start",
      "migrate_source_events_status",
      "migrate_source_events_stop",
      "migrate_source_session_refresh",
      "migrate_start",
      "migrate_status",
      "migrate_verification",
    ]);
  });

  it("each tool has a zod object schema and a description", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.schema).toBeInstanceOf(z.ZodObject);
    }
  });

  it("keeps ActiveCampaign automation rebuild wording in migration tool descriptions", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const credentials = tools.find((x) => x.name === "migrate_credentials")!;
    const discover = tools.find((x) => x.name === "migrate_discover")!;
    const dryRun = tools.find((x) => x.name === "migrate_dry_run")!;

    expect(credentials.description).toContain(
      "only through the direct API/SDK",
    );
    expect(credentials.description).toContain(
      "not a Moosewave-managed migration OAuth flow",
    );
    expect(credentials.description).toContain(
      "second job for the same tenant/account",
    );
    expect(credentials.description).toContain(
      "Customer.io requires an App API key",
    );
    expect(discover.description).toContain("ActiveCampaign");
    expect(discover.description).toContain("selected_audience_ids");
    expect(discover.description).toContain("informative scoped inventory");
    expect(discover.description).toContain("authoritative reviewed scope");
    expect(discover.description).toContain("Customer Journeys");
    expect(discover.description).toContain("rebuild-review evidence");
    expect(discover.description).toContain("HubSpot");
    expect(discover.description).toContain(
      "filter predicates are deliberately not requested or persisted",
    );
    expect(discover.description).toContain(
      "sensitive property and integration-event literals",
    );
    expect(discover.description).toContain(
      "segments_count combines exact list snapshots",
    );
    expect(discover.description).toContain(
      "subscription_channels_count separately reports active definitions",
    );
    expect(discover.description).toContain(
      "Eleven unconditional HubSpot unsupported/rule-boundary rows",
    );
    expect(discover.description).toContain("14 scope-review rows total");
    expect(discover.description).toContain("conservative import eligibility");
    expect(discover.description).toContain("1,000,000 contacts");
    expect(discover.description).toContain("64 MiB");
    expect(discover.description).toContain("Beehiiv");
    expect(discover.description).toContain("does not promise Stripe billing");
    expect(discover.description).toContain("stable Get Profiles");
    expect(discover.description).toContain("immutable cio_id profiles");
    expect(discover.description).toContain(
      'at least one explicit language="" content',
    );
    expect(discover.description).toContain(
      "lowest stable ID represents a multi-default/A-B set",
    );
    expect(discover.description).toContain("all variants remain evidence");
    expect(discover.description).toContain(
      "translations are never silently selected",
    );
    expect(discover.description).toContain("not provider-rendered output");
    expect(discover.description).toContain(
      "never treats GET /customers as a global list",
    );
    expect(discover.description).toContain("secondary email identifiers");
    expect(discover.description).toContain("multi-email manual-review record");
    expect(discover.description).toContain("10 requests/second");
    expect(discover.description).toContain("150 requests/minute");
    expect(discover.description).toContain("Klaviyo list <id>");
    expect(discover.description).toContain("Klaviyo segment <id>");
    expect(discover.description).toContain(
      "send-targetable list/segment projection",
    );
    expect(discover.description).toContain(
      "does not expose a separate raw Klaviyo membership count",
    );
    expect(discover.description).toContain(
      "Draft campaign-message definitions and flow definitions may be null",
    );
    expect(discover.description).toContain("provider IDs only");
    expect(discover.description).toContain(
      "Eight static product-area source-archive rows are emitted unconditionally",
    );
    expect(discover.description).toContain("not detected source inventory");
    expect(dryRun.description).toContain(
      "ActiveCampaign automation rebuild-review evidence",
    );
    expect(dryRun.description).toContain(
      "HubSpot exact identity/property/preference inventory",
    );
    expect(dryRun.description).toContain("14-row CRM-bridge scope review");
    expect(dryRun.description).toContain(
      "explicit empty-language/lowest-stable-A-B newsletter selection",
    );
    expect(dryRun.description).toContain(
      "exact-source Design Studio fidelity warnings",
    );
    expect(dryRun.description).toContain("awaiting_confirmation");
    expect(dryRun.description).toContain("explicit no-Stripe-billing boundary");
  });

  it("migrate_start handler calls migrations.start", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = migrationTools(client as any).find(
      (x) => x.name === "migrate_start",
    )!;
    const out = await t.handler({ source: "mailchimp" });
    expect(m.start).toHaveBeenCalledWith("mailchimp");
    expect(out).toMatchObject({ authorize_url: expect.any(String) });
  });

  it("limits migrate_start to OAuth sources", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const start = migrationTools(client as any).find(
      (item) => item.name === "migrate_start",
    )!;

    expect(() => start.schema.parse({ source: "beehiiv" })).toThrow();
    expect(start.schema.parse({ source: "mailchimp" })).toMatchObject({
      source: "mailchimp",
    });
  });

  it("migrate_start binds an OAuth reconnect to the existing job", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = migrationTools(client as any).find(
      (x) => x.name === "migrate_start",
    )!;

    const out = await t.handler({
      source: "mailchimp",
      job_id: "job_existing",
    });

    expect(m.start).toHaveBeenCalledWith("mailchimp", "job_existing");
    expect(out).toMatchObject({ authorize_url: expect.any(String) });
  });

  it("binds Beehiiv credentials to one explicit publication", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = migrationTools(client as any).find(
      (item) => item.name === "migrate_credentials",
    )!;

    await expect(
      tool.handler({
        source: "beehiiv",
        api_key: "beehiiv-secret",
        account_id: "pub_primary",
      }),
    ).resolves.toMatchObject({ job_id: "job_credentials" });
    expect(m.credentials).toHaveBeenCalledWith("beehiiv", {
      api_key: "beehiiv-secret",
      account_id: "pub_primary",
      extra: { publication_id: "pub_primary" },
    });
  });

  it("rejects Beehiiv credential handoff without a publication ID", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = migrationTools(client as any).find(
      (item) => item.name === "migrate_credentials",
    )!;

    await expect(
      tool.handler({ source: "beehiiv", api_key: "beehiiv-secret" }),
    ).rejects.toThrow("requires an explicit publication ID");
    expect(m.credentials).not.toHaveBeenCalled();
  });

  it("rejects a malformed Beehiiv publication ID", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = migrationTools(client as any).find(
      (item) => item.name === "migrate_credentials",
    )!;

    await expect(
      tool.handler({
        source: "beehiiv",
        api_key: "beehiiv-secret",
        account_id: "publication-primary",
      }),
    ).rejects.toThrow("must use the documented pub_ prefix");
    expect(m.credentials).not.toHaveBeenCalled();
  });

  it("migrate_discover passes source + session_id", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = migrationTools(client as any).find(
      (x) => x.name === "migrate_discover",
    )!;
    await t.handler({ source: "csv", session_id: "sess_001" });
    expect(m.discover).toHaveBeenCalledWith("csv", "sess_001", undefined);
  });

  it("migrate_discover preserves the exact Customer.io subscription-channel count", async () => {
    const { client, m } = makeClient();
    m.discover.mockResolvedValueOnce({
      source: "customerio",
      subscription_channels_count: 3,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = migrationTools(client as any).find(
      (item) => item.name === "migrate_discover",
    )!;

    await expect(
      tool.handler({ source: "customerio", session_id: "job_customerio" }),
    ).resolves.toMatchObject({ subscription_channels_count: 3 });
    expect(m.discover).toHaveBeenCalledWith(
      "customerio",
      "job_customerio",
      undefined,
    );
  });

  it("forwards explicit Mailchimp audience scope through discover, dry-run, and commit", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const input = {
      source: "mailchimp",
      session_id: "sess_mc",
      selected_audience_ids: ["aud_a", "aud_b"],
    };
    await tools.find((x) => x.name === "migrate_discover")!.handler(input);
    await tools.find((x) => x.name === "migrate_dry_run")!.handler(input);
    await tools.find((x) => x.name === "migrate_commit")!.handler(input);

    expect(m.discover).toHaveBeenCalledWith("mailchimp", "sess_mc", [
      "aud_a",
      "aud_b",
    ]);
    expect(m.dryRun).toHaveBeenCalledWith("mailchimp", "sess_mc", [
      "aud_a",
      "aud_b",
    ]);
    expect(m.commit).toHaveBeenCalledWith("mailchimp", "sess_mc", [
      "aud_a",
      "aud_b",
    ]);
  });

  it("migrate_dry_run + migrate_commit forward correctly", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    await tools
      .find((x) => x.name === "migrate_dry_run")!
      .handler({ source: "beehiiv", session_id: "sess_002" });
    await tools
      .find((x) => x.name === "migrate_commit")!
      .handler({ source: "beehiiv", session_id: "sess_002" });
    expect(m.dryRun).toHaveBeenCalledWith("beehiiv", "sess_002", undefined);
    expect(m.commit).toHaveBeenCalledWith("beehiiv", "sess_002", undefined);
  });

  it("fails closed when Mailchimp dry-run or commit omits audience scope", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);

    await expect(
      tools
        .find((x) => x.name === "migrate_dry_run")!
        .handler({ source: "mailchimp", session_id: "sess_mc" }),
    ).rejects.toThrow(
      "Mailchimp dry-run requires at least one selected audience ID",
    );
    await expect(
      tools
        .find((x) => x.name === "migrate_commit")!
        .handler({ source: "mailchimp", session_id: "sess_mc" }),
    ).rejects.toThrow(
      "Mailchimp commit requires at least one selected audience ID",
    );
    expect(m.dryRun).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });

  it("polls migration and asynchronous rollback status", async () => {
    const { client, m } = makeClient();
    m.get.mockResolvedValueOnce({
      id: "job_001",
      source: "customerio",
      status: "completed",
      verification_report: {
        source_archive_by_resource: {
          customerio_subscription_channel: 3,
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const status = await tools
      .find((x) => x.name === "migrate_status")!
      .handler({ job_id: "job_001" });
    expect(m.get).toHaveBeenCalledWith("job_001");
    expect(status).toMatchObject({
      id: "job_001",
      verification_report: {
        source_archive_by_resource: {
          customerio_subscription_channel: 3,
        },
      },
    });

    const rb = await tools
      .find((x) => x.name === "migrate_rollback")!
      .handler({ job_id: "job_001" });
    expect(m.rollback).toHaveBeenCalledWith("job_001");
    expect(rb).toEqual({ job_id: "job_001", state: "running" });

    const rollbackStatus = await tools
      .find((x) => x.name === "migrate_rollback_status")!
      .handler({ job_id: "job_001" });
    expect(m.rollbackStatus).toHaveBeenCalledWith("job_001");
    expect(rollbackStatus).toMatchObject({
      state: "running",
      subscribers_deleted: 10,
      subscribers_total: 100,
    });
  });

  it("rejects invalid source enum at the schema layer", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = migrationTools(client as any).find(
      (x) => x.name === "migrate_start",
    )!;
    const r = t.schema.safeParse({ source: "not_a_real_source" });
    expect(r.success).toBe(false);
  });

  it("rejects empty migration IDs at the schema layer", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    expect(
      tools
        .find((x) => x.name === "migrate_discover")!
        .schema.safeParse({
          source: "mailchimp",
          session_id: "   ",
        }).success,
    ).toBe(false);
    expect(
      tools
        .find((x) => x.name === "migrate_status")!
        .schema.safeParse({
          job_id: "",
        }).success,
    ).toBe(false);
  });

  it("routes supported sources through the correct handoff schema", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const start = tools.find((x) => x.name === "migrate_start")!;
    const credentials = tools.find((x) => x.name === "migrate_credentials")!;
    const discover = tools.find((x) => x.name === "migrate_discover")!;
    for (const source of ["mailchimp", "convertkit"]) {
      expect(start.schema.safeParse({ source }).success).toBe(true);
    }
    for (const source of [
      "activecampaign",
      "klaviyo",
      "customerio",
      "hubspot",
      "beehiiv",
      "brevo",
      "mailerlite",
    ]) {
      expect(
        credentials.schema.safeParse({
          source,
          api_key: "source-secret",
          ...(source === "beehiiv" ? { account_id: "pub_primary" } : {}),
        }).success,
      ).toBe(true);
    }
    for (const source of [
      "mailchimp",
      "activecampaign",
      "klaviyo",
      "customerio",
      "hubspot",
      "convertkit",
      "brevo",
      "substack",
      "beehiiv",
      "mailerlite",
      "sendy",
      "csv",
    ]) {
      expect(
        discover.schema.safeParse({ source, session_id: "job_1" }).success,
      ).toBe(true);
    }
  });

  it("hands Klaviyo credentials to the encrypted credential endpoint", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credentials = migrationTools(client as any).find(
      (tool) => tool.name === "migrate_credentials",
    )!;

    expect(
      credentials.schema.safeParse({
        source: "klaviyo",
        api_key: "klaviyo-secret",
        account_id: "account_123",
      }).success,
    ).toBe(true);
    await expect(
      credentials.handler({
        source: "klaviyo",
        api_key: "klaviyo-secret",
        account_id: "account_123",
      }),
    ).resolves.toMatchObject({ job_id: "job_credentials" });
    expect(m.credentials).toHaveBeenCalledWith("klaviyo", {
      api_key: "klaviyo-secret",
      account_id: "account_123",
    });
  });

  it("hands regional Customer.io App API credentials to an exact workspace", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credentials = migrationTools(client as any).find(
      (tool) => tool.name === "migrate_credentials",
    )!;

    const input = {
      source: "customerio" as const,
      api_key: "cio_app_key",
      account_id: "9001",
      region: "eu" as const,
    };
    expect(credentials.schema.safeParse(input).success).toBe(true);
    expect(
      credentials.schema.safeParse({
        ...input,
        account_id: "9".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      credentials.schema.safeParse({
        ...input,
        account_id: "9".repeat(65),
      }).success,
    ).toBe(false);
    await expect(credentials.handler(input)).resolves.toMatchObject({
      job_id: "job_credentials",
    });
    expect(m.credentials).toHaveBeenCalledWith("customerio", {
      api_key: "cio_app_key",
      account_id: "9001",
      extra: { region: "eu" },
    });

    await expect(
      credentials.handler({
        source: "customerio",
        api_key: "cio_app_key",
        account_id: "workspace-name",
        region: "us",
      }),
    ).rejects.toThrow("workspace ID must be numeric");
  });

  it("binds HubSpot credentials to an optional numeric Hub ID", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credentials = migrationTools(client as any).find(
      (tool) => tool.name === "migrate_credentials",
    )!;
    const input = {
      source: "hubspot" as const,
      api_key: "hubspot-private-app-token",
      account_id: "12345678",
      region: "us" as const,
    };

    expect(credentials.schema.safeParse(input).success).toBe(true);
    await expect(credentials.handler(input)).resolves.toMatchObject({
      job_id: "job_credentials",
    });
    expect(m.credentials).toHaveBeenCalledWith("hubspot", {
      api_key: "hubspot-private-app-token",
      account_id: "12345678",
      extra: { hub_id: "12345678" },
    });
    await expect(
      credentials.handler({
        source: "hubspot",
        api_key: "hubspot-private-app-token",
        account_id: "portal-name",
        region: "us",
      }),
    ).rejects.toThrow("hub ID must be numeric");
  });

  it("publishes reconnect and callback job ID semantics in its schemas", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const start = tools.find((x) => x.name === "migrate_start")!;
    const discover = tools.find((x) => x.name === "migrate_discover")!;
    const startShape = (start.schema as z.ZodObject<z.ZodRawShape>).shape;
    const discoverShape = (discover.schema as z.ZodObject<z.ZodRawShape>).shape;

    expect(
      start.schema.safeParse({
        source: "mailchimp",
        job_id: "job_existing",
      }).success,
    ).toBe(true);
    expect(startShape.job_id!.description).toContain("reconnect");
    expect(discoverShape.session_id!.description).toContain("OAuth callback");
    expect(discoverShape.session_id!.description).toContain(
      "not the OAuth state token",
    );
  });

  it("forwards the complete post-commit lifecycle through source-bound SDK methods", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const bound = { source: "activecampaign", job_id: "job_001" };

    const refreshed = await tools
      .find((x) => x.name === "migrate_source_session_refresh")!
      .handler({
        ...bound,
        api_key: "secret-token",
        account_id: "https://tenant.api-us1.com",
        confirm: true,
      });
    await tools.find((x) => x.name === "migrate_verification")!.handler(bound);
    await tools
      .find((x) => x.name === "migrate_delta_import")!
      .handler({ ...bound, confirm: true });
    await tools.find((x) => x.name === "migrate_shadow_check")!.handler(bound);
    await tools
      .find((x) => x.name === "migrate_shadow_monitor_start")!
      .handler({ ...bound, interval_seconds: 900, confirm: true });
    await tools
      .find((x) => x.name === "migrate_shadow_monitor_status")!
      .handler(bound);
    await tools
      .find((x) => x.name === "migrate_shadow_monitor_stop")!
      .handler({ ...bound, confirm: true });
    await tools
      .find((x) => x.name === "migrate_automation_rebuild_list")!
      .handler(bound);
    await tools
      .find((x) => x.name === "migrate_automation_rebuild_update")!
      .handler({
        ...bound,
        rank: 1,
        name: "Welcome series",
        status: "test_passed",
        test_evidence: "ticket-42",
        confirm: true,
      });
    await tools
      .find((x) => x.name === "migrate_rollback_rehearsal")!
      .handler({ ...bound, confirm: true });
    await tools
      .find((x) => x.name === "migrate_pilot_acceptance")!
      .handler(bound);
    await tools
      .find((x) => x.name === "migrate_cutover_evidence")!
      .handler({
        ...bound,
        key: "activecampaign_automation_rebuild_review",
        status: "pass",
        detail: "Reviewed after final delta",
        evidence: ["ticket-42"],
        confirm: true,
      });

    expect(m.get).toHaveBeenCalledTimes(12);
    expect(m.get).toHaveBeenCalledWith("job_001");
    expect(m.refreshSourceSession).toHaveBeenCalledWith("job_001", {
      api_key: "secret-token",
      account_id: "https://tenant.api-us1.com",
      extra: { api_url: "https://tenant.api-us1.com" },
    });
    expect(JSON.stringify(refreshed)).not.toContain("secret-token");
    expect(m.verification).toHaveBeenCalledWith("job_001");
    expect(m.deltaImport).toHaveBeenCalledWith("activecampaign", "job_001");
    expect(m.shadowCheck).toHaveBeenCalledWith("activecampaign", "job_001");
    expect(m.startShadowMonitor).toHaveBeenCalledWith(
      "activecampaign",
      "job_001",
      900,
    );
    expect(m.shadowMonitor).toHaveBeenCalledWith("job_001");
    expect(m.stopShadowMonitor).toHaveBeenCalledWith("job_001");
    expect(m.automationRebuilds).toHaveBeenCalledWith("job_001");
    expect(m.updateAutomationRebuild).toHaveBeenCalledWith("job_001", {
      rank: 1,
      name: "Welcome series",
      status: "test_passed",
      test_evidence: "ticket-42",
    });
    expect(m.rollbackRehearsal).toHaveBeenCalledWith("job_001");
    expect(m.pilotAcceptance).toHaveBeenCalledWith("job_001");
    expect(m.recordCutoverEvidence).toHaveBeenCalledWith("job_001", {
      key: "activecampaign_automation_rebuild_review",
      status: "pass",
      detail: "Reviewed after final delta",
      evidence: ["ticket-42"],
    });
  });

  it("keeps HubSpot source-event controls source-bound and explicit about snapshot limits", async () => {
    const { client, m } = makeClient();
    m.get.mockResolvedValue({
      id: "job_hubspot",
      source: "hubspot",
      status: "completed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const bound = { source: "hubspot" as const, job_id: "job_hubspot" };
    const start = tools.find((x) => x.name === "migrate_source_events_start")!;
    const status = tools.find(
      (x) => x.name === "migrate_source_events_status",
    )!;
    const stop = tools.find((x) => x.name === "migrate_source_events_stop")!;

    await start.handler({
      ...bound,
      interval_seconds: 900,
      confirm: true,
    });
    await status.handler(bound);
    await stop.handler({
      ...bound,
      post_pilot_cleanup: true,
      confirm: true,
    });

    expect(m.startSourceEvents).toHaveBeenCalledWith(
      "hubspot",
      "job_hubspot",
      900,
    );
    expect(m.sourceEvents).toHaveBeenCalledWith("job_hubspot");
    expect(m.stopSourceEvents).toHaveBeenCalledWith("job_hubspot", true);
    expect(start.description).toContain("at least seven continuous days");
    expect(start.description).toContain("changed contacts only");
    expect(start.description).toContain("standalone list-membership changes");
    expect(start.description).toContain("preference-only changes");
    expect(start.description).toContain("10,000 results");
    expect(start.description).toContain(
      "frozen final full snapshot remains authoritative",
    );
    expect(status.description).toContain("never proves");
    expect(stop.description).toContain("strict pilot acceptance");
    expect(stop.description).toContain("source_session_cleared=true");
    expect(stop.description).toContain("local encrypted source session");
  });

  it("fails closed on a source/job mismatch before invoking a lifecycle mutation", async () => {
    const { client, m } = makeClient();
    m.get.mockResolvedValueOnce({
      id: "job_001",
      source: "beehiiv",
      status: "completed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delta = migrationTools(client as any).find(
      (x) => x.name === "migrate_delta_import",
    )!;

    await expect(
      delta.handler({
        source: "activecampaign",
        job_id: "job_001",
        confirm: true,
      }),
    ).rejects.toThrow("does not match requested source");
    expect(m.deltaImport).not.toHaveBeenCalled();
  });

  it("gates every post-commit mutation on admin scope and explicit approval where required", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const adminNames = [
      "migrate_source_session_refresh",
      "migrate_delta_import",
      "migrate_shadow_check",
      "migrate_shadow_monitor_start",
      "migrate_shadow_monitor_stop",
      "migrate_source_events_start",
      "migrate_source_events_stop",
      "migrate_automation_rebuild_update",
      "migrate_rollback_rehearsal",
      "migrate_cutover_evidence",
    ];
    for (const name of adminNames) {
      expect(tools.find((x) => x.name === name)!.requiredScopes).toEqual([
        "admin",
      ]);
    }

    const approvedInputs: Record<string, Record<string, unknown>> = {
      migrate_source_session_refresh: {
        source: "activecampaign",
        job_id: "job_1",
        api_key: "secret",
      },
      migrate_delta_import: { source: "activecampaign", job_id: "job_1" },
      migrate_shadow_monitor_start: {
        source: "activecampaign",
        job_id: "job_1",
        interval_seconds: 300,
      },
      migrate_shadow_monitor_stop: {
        source: "activecampaign",
        job_id: "job_1",
      },
      migrate_source_events_start: {
        source: "activecampaign",
        job_id: "job_1",
        interval_seconds: 300,
      },
      migrate_source_events_stop: {
        source: "activecampaign",
        job_id: "job_1",
      },
      migrate_automation_rebuild_update: {
        source: "activecampaign",
        job_id: "job_1",
        rank: 1,
        name: "Welcome",
        status: "rebuilding",
      },
      migrate_rollback_rehearsal: {
        source: "activecampaign",
        job_id: "job_1",
      },
      migrate_cutover_evidence: {
        source: "activecampaign",
        job_id: "job_1",
        key: "activecampaign_templates_review",
        status: "pass",
        detail: "Reviewed",
        evidence: ["ticket-42"],
      },
    };
    for (const [name, input] of Object.entries(approvedInputs)) {
      const tool = tools.find((x) => x.name === name)!;
      expect(tool.schema.safeParse(input).success).toBe(false);
      expect(tool.schema.safeParse({ ...input, confirm: false }).success).toBe(
        false,
      );
      expect(tool.schema.safeParse({ ...input, confirm: true }).success).toBe(
        true,
      );
    }
  });

  it("bounds monitor, evidence, and automation inputs and enforces pass evidence", async () => {
    const { client, m } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const monitor = tools.find(
      (x) => x.name === "migrate_shadow_monitor_start",
    )!;
    expect(
      monitor.schema.safeParse({
        source: "activecampaign",
        job_id: "job_1",
        interval_seconds: 299,
        confirm: true,
      }).success,
    ).toBe(false);
    expect(
      monitor.schema.safeParse({
        source: "activecampaign",
        job_id: "job_1",
        interval_seconds: 604_801,
        confirm: true,
      }).success,
    ).toBe(false);

    const cutover = tools.find((x) => x.name === "migrate_cutover_evidence")!;
    expect(
      cutover.schema.safeParse({
        source: "beehiiv",
        job_id: "job_1",
        key: "beehiiv_consent_reconciliation",
        status: "pass",
        detail: "Reviewed",
        evidence: Array.from({ length: 51 }, (_, i) => `ticket-${i}`),
        confirm: true,
      }).success,
    ).toBe(false);

    const rebuild = tools.find(
      (x) => x.name === "migrate_automation_rebuild_update",
    )!;
    await expect(
      rebuild.handler({
        source: "activecampaign",
        job_id: "job_1",
        rank: 1,
        name: "Welcome",
        status: "test_passed",
        confirm: true,
      }),
    ).rejects.toThrow("requires non-secret test_evidence");
    expect(m.updateAutomationRebuild).not.toHaveBeenCalled();
  });

  it("rejects cutover evidence keys that are not valid for the bound provider", async () => {
    const { client, m } = makeClient();
    m.get.mockResolvedValue({
      id: "job_beehiiv",
      source: "beehiiv",
      status: "completed",
    });
    const cutover = migrationTools(client as any).find(
      (x) => x.name === "migrate_cutover_evidence",
    )!;

    await expect(
      cutover.handler({
        source: "beehiiv",
        job_id: "job_beehiiv",
        key: "activecampaign_templates_review",
        status: "pass",
        detail: "Reviewed",
        evidence: ["ticket-42"],
        confirm: true,
      }),
    ).rejects.toThrow("is not valid for beehiiv");
    expect(m.recordCutoverEvidence).not.toHaveBeenCalled();
  });

  it("records allow-listed Klaviyo cutover evidence on a Klaviyo job", async () => {
    const { client, m } = makeClient();
    m.get.mockResolvedValue({
      id: "job_klaviyo",
      source: "klaviyo",
      status: "completed",
    });
    const cutover = migrationTools(client as any).find(
      (x) => x.name === "migrate_cutover_evidence",
    )!;
    const input = {
      source: "klaviyo" as const,
      job_id: "job_klaviyo",
      key: "klaviyo_ecosystem_dependencies_review" as const,
      status: "pass" as const,
      detail: "Ecosystem dependency ledger reviewed after final delta.",
      evidence: ["ticket-klaviyo-42"],
      confirm: true as const,
    };

    expect(cutover.schema.safeParse(input).success).toBe(true);
    await expect(cutover.handler(input)).resolves.toMatchObject({
      status: "pass",
    });
    expect(m.recordCutoverEvidence).toHaveBeenCalledWith("job_klaviyo", {
      key: "klaviyo_ecosystem_dependencies_review",
      status: "pass",
      detail: "Ecosystem dependency ledger reviewed after final delta.",
      evidence: ["ticket-klaviyo-42"],
    });
  });

  it("records the HubSpot CRM-bridge scope review on its bound job", async () => {
    const { client, m } = makeClient();
    m.get.mockResolvedValue({
      id: "job_hubspot",
      source: "hubspot",
      status: "completed",
    });
    const cutover = migrationTools(client as any).find(
      (x) => x.name === "migrate_cutover_evidence",
    )!;
    const input = {
      source: "hubspot" as const,
      job_id: "job_hubspot",
      key: "hubspot_crm_bridge_scope_review" as const,
      status: "pass" as const,
      detail: "All 14 HubSpot bridge scope rows were reviewed.",
      evidence: ["ticket-hubspot-42"],
      confirm: true as const,
    };

    expect(cutover.schema.safeParse(input).success).toBe(true);
    await expect(cutover.handler(input)).resolves.toMatchObject({
      status: "pass",
    });
    expect(m.recordCutoverEvidence).toHaveBeenCalledWith("job_hubspot", {
      key: "hubspot_crm_bridge_scope_review",
      status: "pass",
      detail: "All 14 HubSpot bridge scope rows were reviewed.",
      evidence: ["ticket-hubspot-42"],
    });
  });

  it("records allow-listed Customer.io cutover evidence on its bound job", async () => {
    const { client, m } = makeClient();
    m.get.mockResolvedValue({
      id: "job_customerio",
      source: "customerio",
      status: "completed",
    });
    const cutover = migrationTools(client as any).find(
      (x) => x.name === "migrate_cutover_evidence",
    )!;
    const input = {
      source: "customerio" as const,
      job_id: "job_customerio",
      key: "customerio_identity_audience_review" as const,
      status: "pass" as const,
      detail: "Identity and frozen audience snapshot reviewed after delta.",
      evidence: ["ticket-customerio-42"],
      confirm: true as const,
    };

    expect(cutover.schema.safeParse(input).success).toBe(true);
    await expect(cutover.handler(input)).resolves.toMatchObject({
      status: "pass",
    });
    expect(m.recordCutoverEvidence).toHaveBeenCalledWith("job_customerio", {
      key: "customerio_identity_audience_review",
      status: "pass",
      detail: "Identity and frozen audience snapshot reviewed after delta.",
      evidence: ["ticket-customerio-42"],
    });
  });

  it("documents final-delta ordering and bounded Customer.io/Beehiiv/Klaviyo initial imports", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = migrationTools(client as any);
    const commit = tools.find((x) => x.name === "migrate_commit")!;
    const evidence = tools.find((x) => x.name === "migrate_cutover_evidence")!;
    const acceptance = tools.find(
      (x) => x.name === "migrate_pilot_acceptance",
    )!;

    expect(commit.description).toContain(
      "Beehiiv's initial commit is never cutover approval",
    );
    expect(commit.description).toContain(
      "Klaviyo's initial commit is likewise never cutover approval",
    );
    expect(commit.description).toContain(
      "Customer.io also requires a frozen full cio_id snapshot",
    );
    expect(commit.description).toContain(
      "global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default",
    );
    expect(commit.description).toContain(
      "sender-specific SMS/WhatsApp /v1/optouts separate",
    );
    expect(evidence.description).toContain(
      "Never call this before the latest final delta/full snapshot completes successfully",
    );
    expect(evidence.description).toContain("explicit user approval");
    expect(acceptance.description).toContain(
      "Beehiiv's initial commit is never sufficient",
    );
    expect(acceptance.description).toContain(
      "Klaviyo also requires consent/suppression and profile-identity reconciliation",
    );
    expect(acceptance.description).toContain(
      "Customer.io has no supported incremental profile-change feed",
    );
    expect(acceptance.description).toContain(
      "global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default governs email",
    );
    expect(acceptance.description).toContain(
      "separate sender-specific SMS/WhatsApp /v1/optouts review",
    );
    expect(acceptance.description).toContain(
      "warned lowest-stable-ID A/B representation",
    );
    expect(acceptance.description).toContain(
      "exact-source Design Studio HTML rather than provider rendering",
    );
    expect(acceptance.description).toContain(
      "mandatory secondary-email/per-address-consent source-archive record",
    );
    const delta = tools.find((x) => x.name === "migrate_delta_import")!;
    expect(delta.description).toContain(
      "stable profile ID changes email from A to B",
    );
    expect(delta.description).toContain(
      "full snapshot must materialize B and disable A before replay resumes",
    );
    expect(delta.description).toContain(
      "global + resolved email-channel + applicable-topic status including defaults",
    );
  });
});
