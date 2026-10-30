// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/lib/client.js";
import {
  beehiivCredentialInput,
  customerIOCredentialInput,
  hubSpotCredentialInput,
  isMigrationSource,
  klaviyoCredentialInput,
  migrateCommand,
  migrateSourceEventsStart,
  migrateSourceEventsStatus,
  migrateSourceEventsStop,
  normalizeMigrationAuthorizeUrl,
} from "../src/commands/migrate.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("isMigrationSource", () => {
  it("accepts only migration-start sources", () => {
    expect(isMigrationSource("activecampaign")).toBe(true);
    expect(isMigrationSource("hubspot")).toBe(true);
    expect(isMigrationSource("klaviyo")).toBe(true);
    expect(isMigrationSource("customerio")).toBe(true);
    expect(isMigrationSource("constant-contact")).toBe(true);
    expect(isMigrationSource("campaign-monitor")).toBe(true);
    expect(isMigrationSource("mailchimp_api")).toBe(false);
    expect(isMigrationSource("activecampaign/../../admin")).toBe(false);
  });
});

describe("Beehiiv credential migration", () => {
  it("builds an exact publication-bound credential payload", () => {
    expect(
      beehiivCredentialInput({
        sourceApiKey: " beehiiv-secret ",
        publicationId: " pub_00000000-0000-0000-0000-000000000000 ",
      }),
    ).toEqual({
      api_key: "beehiiv-secret",
      account_id: "pub_00000000-0000-0000-0000-000000000000",
      extra: {
        publication_id: "pub_00000000-0000-0000-0000-000000000000",
      },
    });
    expect(() =>
      beehiivCredentialInput({
        sourceApiKey: "",
        publicationId: "pub_00000000-0000-0000-0000-000000000000",
      }),
    ).toThrow("--source-api-key");
    expect(() =>
      beehiivCredentialInput({
        sourceApiKey: "secret",
        publicationId: "not-a-publication",
      }),
    ).toThrow("--publication-id");
  });

  it("creates and discovers the publication-bound job without using OAuth", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_beehiiv",
        account_id: "pub_00000000-0000-0000-0000-000000000000",
      })),
      discover: vi.fn(async () => ({ source: "beehiiv" })),
      start: vi.fn(),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("beehiiv", {
      sourceApiKey: "beehiiv-secret",
      publicationId: "pub_00000000-0000-0000-0000-000000000000",
      output: "json",
    });

    expect(migrations.credentials).toHaveBeenCalledWith("beehiiv", {
      api_key: "beehiiv-secret",
      account_id: "pub_00000000-0000-0000-0000-000000000000",
      extra: {
        publication_id: "pub_00000000-0000-0000-0000-000000000000",
      },
    });
    expect(migrations.discover).toHaveBeenCalledWith("beehiiv", "job_beehiiv");
    expect(migrations.start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("never reports a completed Beehiiv initial import as cutover-ready", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_beehiiv",
        account_id: "pub_00000000-0000-0000-0000-000000000000",
      })),
      discover: vi.fn(async () => ({ source: "beehiiv" })),
      dryRun: vi.fn(async () => ({ job_id: "job_beehiiv" })),
      commit: vi.fn(async () => ({ job_id: "job_beehiiv" })),
      get: vi
        .fn()
        .mockResolvedValueOnce({
          id: "job_beehiiv",
          source: "beehiiv",
          status: "awaiting_confirmation",
        })
        .mockResolvedValueOnce({
          id: "job_beehiiv",
          source: "beehiiv",
          status: "completed",
        }),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("beehiiv", {
      sourceApiKey: "beehiiv-secret",
      publicationId: "pub_00000000-0000-0000-0000-000000000000",
      commit: true,
      output: "json",
    });

    expect(migrations.dryRun).toHaveBeenCalledWith("beehiiv", "job_beehiiv");
    expect(migrations.commit).toHaveBeenCalledWith("beehiiv", "job_beehiiv");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"cutover_ready": false'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("frozen final delta"),
    );
  });
});

describe("Customer.io credential migration", () => {
  it("builds an exact regional workspace-bound credential payload", () => {
    expect(
      customerIOCredentialInput({
        sourceApiKey: " cio_app_key ",
        sourceAccountId: " 9001 ",
        sourceRegion: " EU ",
      }),
    ).toEqual({
      api_key: "cio_app_key",
      account_id: "9001",
      extra: { region: "eu" },
    });
    expect(customerIOCredentialInput({ sourceApiKey: "cio_app_key" })).toEqual({
      api_key: "cio_app_key",
      extra: { region: "us" },
    });
    expect(() =>
      customerIOCredentialInput({ sourceApiKey: "", sourceRegion: "us" }),
    ).toThrow("--source-api-key");
    expect(() =>
      customerIOCredentialInput({
        sourceApiKey: "key",
        sourceRegion: "apac",
      }),
    ).toThrow("--source-region");
    expect(() =>
      customerIOCredentialInput({
        sourceApiKey: "key",
        sourceAccountId: "workspace-name",
      }),
    ).toThrow("numeric workspace ID");
    expect(
      customerIOCredentialInput({
        sourceApiKey: "key",
        sourceAccountId: "9".repeat(64),
      }).account_id,
    ).toBe("9".repeat(64));
    expect(() =>
      customerIOCredentialInput({
        sourceApiKey: "key",
        sourceAccountId: "9".repeat(65),
      }),
    ).toThrow("1 to 64 digits");
  });

  it("creates and discovers the workspace-bound job without using OAuth", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_customerio",
        account_id: "9001",
      })),
      discover: vi.fn(async () => ({
        source: "customerio",
        subscription_channels_count: 3,
      })),
      start: vi.fn(),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("customerio", {
      sourceApiKey: "cio_app_key",
      sourceAccountId: "9001",
      sourceRegion: "eu",
      output: "json",
    });

    expect(migrations.credentials).toHaveBeenCalledWith("customerio", {
      api_key: "cio_app_key",
      account_id: "9001",
      extra: { region: "eu" },
    });
    expect(migrations.discover).toHaveBeenCalledWith(
      "customerio",
      "job_customerio",
    );
    expect(migrations.start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"subscription_channels_count": 3'),
    );
  });

  it("runs Customer.io dry-run and commit while preserving exact archive evidence and fail-closed fidelity guidance", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_customerio",
        account_id: "9001",
      })),
      discover: vi.fn(async () => ({
        source: "customerio",
        subscription_channels_count: 3,
      })),
      dryRun: vi.fn(async () => ({ job_id: "job_customerio" })),
      commit: vi.fn(async () => ({ job_id: "job_customerio" })),
      get: vi
        .fn()
        .mockResolvedValueOnce({
          id: "job_customerio",
          source: "customerio",
          status: "awaiting_confirmation",
        })
        .mockResolvedValueOnce({
          id: "job_customerio",
          source: "customerio",
          status: "completed",
          verification_report: {
            source_archive_by_resource: {
              customerio_subscription_channel: 3,
            },
          },
        }),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("customerio", {
      sourceApiKey: "cio_app_key",
      sourceAccountId: "9001",
      sourceRegion: "eu",
      commit: true,
      output: "json",
    });

    expect(migrations.dryRun).toHaveBeenCalledWith(
      "customerio",
      "job_customerio",
    );
    expect(migrations.commit).toHaveBeenCalledWith(
      "customerio",
      "job_customerio",
    );
    const output = log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain('"cutover_ready": false');
    expect(output).toContain('"customerio_subscription_channel": 3');
    expect(output).toContain('language=\\"\\"');
    expect(output).toContain("lowest stable content ID");
    expect(output).toContain("exact source, never provider-rendered output");
    expect(output).toContain("IDs/timestamps rather than original payload");
    expect(output).toContain("conflict-aware rollback rehearsal");
  });
});

describe("Klaviyo credential migration", () => {
  it("builds a trimmed account-bound credential payload", () => {
    expect(
      klaviyoCredentialInput({
        sourceApiKey: " klaviyo-secret ",
        sourceAccountId: " account_123 ",
      }),
    ).toEqual({
      api_key: "klaviyo-secret",
      account_id: "account_123",
    });
    expect(klaviyoCredentialInput({ sourceApiKey: "klaviyo-secret" })).toEqual({
      api_key: "klaviyo-secret",
    });
    expect(() => klaviyoCredentialInput({ sourceApiKey: "" })).toThrow(
      "--source-api-key",
    );
    expect(() =>
      klaviyoCredentialInput({
        sourceApiKey: "secret",
        sourceAccountId: "account with spaces",
      }),
    ).toThrow("--source-account-id");
  });

  it("creates and discovers an account-bound job without using OAuth", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_klaviyo",
        account_id: "account_123",
      })),
      discover: vi.fn(async () => ({
        source: "klaviyo",
        subscribers_count: 12,
        profiles_without_email_count: 5,
        archive_count: 4,
        source_archive_count: 16,
        sms_campaigns_count: 6,
        push_campaigns_count: 7,
        warnings: ["Secondary-address review required."],
      })),
      start: vi.fn(),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("klaviyo", {
      sourceApiKey: "klaviyo-secret",
      sourceAccountId: "account_123",
      output: "json",
    });

    expect(migrations.credentials).toHaveBeenCalledWith("klaviyo", {
      api_key: "klaviyo-secret",
      account_id: "account_123",
    });
    expect(migrations.discover).toHaveBeenCalledWith("klaviyo", "job_klaviyo");
    expect(migrations.start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"job_id": "job_klaviyo"'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"profiles_without_email_count": 5'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"archive_count": 4'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"source_archive_count": 16'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"sms_campaigns_count": 6'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"push_campaigns_count": 7'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Secondary-address review required."),
    );
  });

  it("never reports a completed Klaviyo initial import as cutover-ready", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_klaviyo",
        account_id: "account_123",
      })),
      discover: vi.fn(async () => ({ source: "klaviyo" })),
      dryRun: vi.fn(async () => ({ job_id: "job_klaviyo" })),
      commit: vi.fn(async () => ({ job_id: "job_klaviyo" })),
      get: vi
        .fn()
        .mockResolvedValueOnce({
          id: "job_klaviyo",
          source: "klaviyo",
          status: "awaiting_confirmation",
        })
        .mockResolvedValueOnce({
          id: "job_klaviyo",
          source: "klaviyo",
          status: "completed",
        }),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("klaviyo", {
      sourceApiKey: "klaviyo-secret",
      sourceAccountId: "account_123",
      commit: true,
      output: "json",
    });

    expect(migrations.dryRun).toHaveBeenCalledWith("klaviyo", "job_klaviyo");
    expect(migrations.commit).toHaveBeenCalledWith("klaviyo", "job_klaviyo");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"cutover_ready": false'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("rebuild and review Klaviyo flows"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("secondary-email/per-address-consent"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("stable-profile email A→B move"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "reuse the original unrolled-back tenant/account job lineage",
      ),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "suppression-filtered send-targetable projection",
      ),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("nullable draft-message/flow definitions"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("eight unconditional static checklist rows"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ecosystem, rollback, and credential-cleanup"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("strict pilot acceptance"),
    );
  });
});

describe("HubSpot credential migration", () => {
  it("builds a portal-bound private-app payload", () => {
    expect(
      hubSpotCredentialInput({
        sourceApiKey: " hubspot-private-app-token ",
        sourceAccountId: " 12345678 ",
      }),
    ).toEqual({
      api_key: "hubspot-private-app-token",
      account_id: "12345678",
      extra: { hub_id: "12345678" },
    });
    expect(
      hubSpotCredentialInput({ sourceApiKey: "hubspot-private-app-token" }),
    ).toEqual({ api_key: "hubspot-private-app-token" });
    expect(() => hubSpotCredentialInput({ sourceApiKey: "" })).toThrow(
      "--source-api-key",
    );
    expect(() =>
      hubSpotCredentialInput({
        sourceApiKey: "secret",
        sourceAccountId: "portal-name",
      }),
    ).toThrow("numeric Hub ID");
    expect(() =>
      hubSpotCredentialInput({
        sourceApiKey: "secret",
        sourceAccountId: "9".repeat(65),
      }),
    ).toThrow("1 to 64 digits");
  });

  it("creates and discovers a portal-bound job without using the OAuth start route", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_hubspot",
        account_id: "12345678",
      })),
      discover: vi.fn(async () => ({
        source: "hubspot",
        subscribers_count: 12,
        segments_count: 3,
      })),
      start: vi.fn(),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("hubspot", {
      sourceApiKey: "hubspot-private-app-token",
      sourceAccountId: "12345678",
      output: "json",
    });

    expect(migrations.credentials).toHaveBeenCalledWith("hubspot", {
      api_key: "hubspot-private-app-token",
      account_id: "12345678",
      extra: { hub_id: "12345678" },
    });
    expect(migrations.discover).toHaveBeenCalledWith("hubspot", "job_hubspot");
    expect(migrations.start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"job_id": "job_hubspot"'),
    );
  });

  it("never reports a completed initial import as cutover-ready", async () => {
    const migrations = {
      credentials: vi.fn(async () => ({
        job_id: "job_hubspot",
        account_id: "12345678",
      })),
      discover: vi.fn(async () => ({ source: "hubspot" })),
      dryRun: vi.fn(async () => ({ job_id: "job_hubspot" })),
      commit: vi.fn(async () => ({ job_id: "job_hubspot" })),
      get: vi
        .fn()
        .mockResolvedValueOnce({
          id: "job_hubspot",
          source: "hubspot",
          status: "awaiting_confirmation",
        })
        .mockResolvedValueOnce({
          id: "job_hubspot",
          source: "hubspot",
          status: "completed",
        }),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migrateCommand("hubspot", {
      sourceApiKey: "hubspot-private-app-token",
      sourceAccountId: "12345678",
      commit: true,
      output: "json",
    });

    expect(migrations.dryRun).toHaveBeenCalledWith("hubspot", "job_hubspot");
    expect(migrations.commit).toHaveBeenCalledWith("hubspot", "job_hubspot");
    const output = log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain('"cutover_ready": false');
    expect(output).toContain("at least seven continuous days");
    expect(output).toContain("contact changes only");
    expect(output).toContain("standalone list-membership changes");
    expect(output).toContain("authoritative final full snapshot");
    expect(output).toContain("CRM-bridge scope review");
    expect(output).toContain("external token cleanup evidence");
  });
});

describe("source-event migration commands", () => {
  function mockClient() {
    const migrations = {
      startSourceEvents: vi.fn(async () => ({
        monitor: {
          job_id: "job/a",
          tenant_id: "tenant_1",
          source: "activecampaign",
          enabled: true,
          interval_seconds: 900,
        },
        events: [],
      })),
      sourceEvents: vi.fn(async () => ({
        monitor: {
          job_id: "job/a",
          tenant_id: "tenant_1",
          source: "activecampaign",
          enabled: true,
          interval_seconds: 900,
        },
        events: [],
      })),
      stopSourceEvents: vi.fn(async () => ({
        job_id: "job/a",
        enabled: false,
        source_session_cleared: false,
      })),
    };
    vi.mocked(createClient).mockReturnValue({ migrations } as never);
    return migrations;
  }

  it("routes start/status/stop to source-event SDK methods", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const migrations = mockClient();

    await migrateSourceEventsStart("activecampaign", " job/a ", {
      intervalSeconds: "900",
      output: "json",
    });
    await migrateSourceEventsStart("klaviyo", " job/klaviyo ", {
      intervalSeconds: "1200",
      output: "json",
    });
    await migrateSourceEventsStart("hubspot", " job/hubspot ", {
      intervalSeconds: "1800",
      output: "json",
    });
    await migrateSourceEventsStatus(" job/a ", { output: "json" });
    await migrateSourceEventsStop(" job/a ", { output: "json" });
    await migrateSourceEventsStop(" job/hubspot ", {
      output: "json",
      postPilotCleanup: true,
    });

    expect(migrations.startSourceEvents).toHaveBeenCalledWith(
      "activecampaign",
      "job/a",
      900,
    );
    expect(migrations.startSourceEvents).toHaveBeenCalledWith(
      "klaviyo",
      "job/klaviyo",
      1200,
    );
    expect(migrations.startSourceEvents).toHaveBeenCalledWith(
      "hubspot",
      "job/hubspot",
      1800,
    );
    expect(migrations.sourceEvents).toHaveBeenCalledWith("job/a");
    expect(migrations.stopSourceEvents).toHaveBeenNthCalledWith(
      1,
      "job/a",
      false,
    );
    expect(migrations.stopSourceEvents).toHaveBeenNthCalledWith(
      2,
      "job/hubspot",
      true,
    );
    expect(log).toHaveBeenCalledTimes(6);
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects invalid source-event inputs before dispatch", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const migrations = mockClient();

    await migrateSourceEventsStart("mailchimp_api", "job/a", {
      intervalSeconds: "900",
    });
    expect(process.exitCode).toBe(1);
    expect(migrations.startSourceEvents).not.toHaveBeenCalled();

    process.exitCode = undefined;
    await migrateSourceEventsStart("activecampaign", "job/a", {
      intervalSeconds: "0",
    });
    expect(process.exitCode).toBe(1);
    expect(migrations.startSourceEvents).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("rejects Customer.io source events with full-snapshot guidance", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const migrations = mockClient();

    await migrateSourceEventsStart("customerio", "job/customerio", {
      intervalSeconds: "900",
    });

    expect(process.exitCode).toBe(1);
    expect(migrations.startSourceEvents).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("final full snapshot"),
    );
  });
});

describe("normalizeMigrationAuthorizeUrl", () => {
  it("allows safe HTTPS OAuth URLs and strips fragments", () => {
    expect(
      normalizeMigrationAuthorizeUrl(
        "https://login.example.test/oauth/authorize?state=st_123#token",
        "mailchimp",
      ),
    ).toBe("https://login.example.test/oauth/authorize?state=st_123");
  });

  it("allows local HTTP callbacks for development flows", () => {
    expect(
      normalizeMigrationAuthorizeUrl(
        "http://127.0.0.1:8080/api/v1/migrations/mailchimp/oauth/callback?state=st_123",
        "mailchimp",
      ),
    ).toBe(
      "http://127.0.0.1:8080/api/v1/migrations/mailchimp/oauth/callback?state=st_123",
    );
  });

  it("allows Moosewave-owned deep links for token-entry migration sources", () => {
    expect(
      normalizeMigrationAuthorizeUrl(
        "moosewave://migrate/activecampaign/api-key-entry?state=st_123",
        "activecampaign",
      ),
    ).toBe("moosewave://migrate/activecampaign/api-key-entry?state=st_123");
    expect(
      normalizeMigrationAuthorizeUrl(
        "moosewave://migrations/api-key?source=hubspot&state=st_123",
        "hubspot",
      ),
    ).toBe("moosewave://migrations/api-key?source=hubspot&state=st_123");
    expect(
      normalizeMigrationAuthorizeUrl(
        "moosewave://migrations/api-key?source=activecampaign&state=st_456",
        "activecampaign",
      ),
    ).toBe("moosewave://migrations/api-key?source=activecampaign&state=st_456");
  });

  it("rejects unsafe or source-mismatched authorize URLs", () => {
    expect(
      normalizeMigrationAuthorizeUrl("javascript:alert(1)", "mailchimp"),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl(
        "https://u:p@login.example.test/oauth",
        "mailchimp",
      ),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl(
        "http://login.example.test/oauth",
        "mailchimp",
      ),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl("https://localhost/oauth", "mailchimp"),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl(
        "https://169.254.169.254/latest",
        "mailchimp",
      ),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl(
        "https://login.example.test/oauth\nbad",
        "mailchimp",
      ),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl(
        "moosewave://migrate/hubspot/private-app-token?state=st_123",
        "activecampaign",
      ),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl(
        "moosewave://migrations/api-key?source=hubspot&state=st_123",
        "activecampaign",
      ),
    ).toBeNull();
    expect(
      normalizeMigrationAuthorizeUrl(
        "moosewave://migrate/activecampaign/%252e%252e/hubspot?state=st_123",
        "activecampaign",
      ),
    ).toBeNull();
  });
});
