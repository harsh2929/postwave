import { describe, expect, it } from "vitest";

import {
  applyRuntimeMigrationCapability,
  buildMigrationCredentialInput,
  findSource,
  migrationCredentialLabel,
  validateConnection,
} from "../lib/migration-sources";

function activeCampaignValues(apiUrl: string) {
  return {
    api_key: "ac-token",
    "extra.api_url": apiUrl,
  };
}

describe("migration source validation", () => {
  it("accepts valid ActiveCampaign account API URLs", () => {
    const source = findSource("activecampaign");
    expect(source).not.toBeNull();
    expect(
      source?.fields.find((field) => field.key === "extra.api_url")?.help,
    ).toContain("must be authorized by the Moosewave deployment");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://example.api-us1.com/api/3"),
      ),
    ).toBeNull();
    expect(
      validateConnection(source!, activeCampaignValues("example.api-us1.com")),
    ).toBeNull();
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://tenant.eu.provider.example/api/3"),
      ),
    ).toBeNull();
  });

  it("rejects unsafe or non-API ActiveCampaign URLs before submitting the token", () => {
    const source = findSource("activecampaign");
    expect(source).not.toBeNull();

    expect(
      validateConnection(
        source!,
        activeCampaignValues("http://example.api-us1.com/api/3"),
      ),
    ).toBe("Use an HTTPS ActiveCampaign API URL.");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://token@example.api-us1.com/api/3"),
      ),
    ).toBe("Remove usernames, query strings, and fragments from the API URL.");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://example.api-us1.com/app/settings"),
      ),
    ).toBe("Use the ActiveCampaign account API root or an `/api/3` API URL.");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("http://127.1:8080/api/3"),
      ),
    ).toBe("Use an HTTPS ActiveCampaign API URL.");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://example.api-us1.com:8443/api/3"),
      ),
    ).toBe("ActiveCampaign API URLs must use the default HTTPS port (443).");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://127.0.0.1/api/3"),
      ),
    ).toContain("IP");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://api.localhost/api/3"),
      ),
    ).toContain("localhost");
    expect(
      validateConnection(
        source!,
        activeCampaignValues("https://intranet/api/3"),
      ),
    ).toContain("single-label");
  });

  it("builds ActiveCampaign credentials with accountId and extra api_url", () => {
    const source = findSource("activecampaign");
    expect(source).not.toBeNull();

    expect(
      buildMigrationCredentialInput(
        source!,
        activeCampaignValues(" https://example.api-us1.com/api/3 "),
        " st_123 ",
      ),
    ).toEqual({
      apiKey: "ac-token",
      accountId: "https://example.api-us1.com/api/3",
      extra: {
        api_url: "https://example.api-us1.com/api/3",
        state: "st_123",
      },
    });
  });

  it("builds HubSpot credentials with private app token and hub id metadata", () => {
    const source = findSource("hubspot");
    expect(source).not.toBeNull();
    expect(source!.tagline).toContain("exact preferences");
    expect(source!.tagline).toContain("conservative current-email eligibility");
    const tokenHelp = source!.fields.find(
      (field) => field.key === "api_key",
    )?.help;
    expect(tokenHelp).toContain("subscriptions-definition-read");
    expect(tokenHelp).toContain("subscriptions-status-read");
    expect(tokenHelp).toContain(
      "Enterprise-only batch subscription scopes are not required",
    );
    expect(tokenHelp).toContain("NOT_SPECIFIED remains unconfirmed");
    expect(tokenHelp).toContain("not exact HubSpot sendability parity");
    expect(tokenHelp).toContain("1,000,000 contacts");
    expect(
      source!.fields.find((field) => field.key === "account_id")?.maxLength,
    ).toBe(64);
    expect(
      validateConnection(source!, {
        api_key: "pat-na1-secret",
        account_id: "",
      }),
    ).toBeNull();
    expect(
      validateConnection(source!, {
        api_key: "pat-na1-secret",
        account_id: "9".repeat(64),
      }),
    ).toBeNull();
    expect(
      validateConnection(source!, {
        api_key: "pat-na1-secret",
        account_id: "12a34",
      }),
    ).toBe("Hub ID must contain 1 to 64 digits.");
    expect(
      validateConnection(source!, {
        api_key: "pat-na1-secret",
        account_id: "1".repeat(65),
      }),
    ).toBe("Hub ID must contain 1 to 64 digits.");

    expect(
      buildMigrationCredentialInput(
        source!,
        {
          api_key: " pat-na1-secret ",
          account_id: " 12345678 ",
        },
        " st_hs ",
      ),
    ).toEqual({
      apiKey: "pat-na1-secret",
      accountId: "12345678",
      extra: {
        hub_id: "12345678",
        state: "st_hs",
      },
    });
  });

  it("binds Beehiiv credentials to the exact explicit publication", () => {
    const source = findSource("beehiiv");
    expect(source).not.toBeNull();
    expect(source!.tagline).toContain(
      "segments and automations stay rebuild evidence",
    );
    expect(source!.tagline).toContain("metadata rather than Stripe billing");
    expect(
      source!.fields.find((field) => field.key === "publication_id")?.help,
    ).toContain("no workspace publication chooser");

    expect(
      buildMigrationCredentialInput(source!, {
        api_key: " bh_secret ",
        publication_id: " pub_newsletter ",
      }),
    ).toEqual({
      apiKey: "bh_secret",
      accountId: "pub_newsletter",
      extra: { publication_id: "pub_newsletter" },
    });
  });

  it("models Substack as the registered official ZIP/CSV intake, not a credential flow", () => {
    const source = findSource("substack");
    expect(source).not.toBeNull();
    expect(source).toMatchObject({
      authFlow: "csv_upload",
      fields: [expect.objectContaining({ key: "file", kind: "file" })],
    });
    expect(validateConnection(source!, {})).toContain(
      "Substack official ZIP or subscriber CSV is required",
    );
    expect(source!.tagline).toContain(
      "consent, billing, and ecosystem gaps stay explicit",
    );
    expect(source!.fields[0]?.label).toContain("official ZIP");
    expect(source!.fields[0]?.help).toContain("Stripe/Apple billing");
  });

  it("uses source-aware credential labels for migration recovery", () => {
    expect(migrationCredentialLabel("activecampaign")).toBe(
      "API token + account URL",
    );
    expect(migrationCredentialLabel("hubspot")).toBe(
      "private app access token",
    );
    expect(migrationCredentialLabel("beehiiv")).toBe("API key");
  });

  it("uses OAuth for Mailchimp and follows the runtime capability matrix", () => {
    const source = findSource("mailchimp");
    expect(source).not.toBeNull();
    expect(
      applyRuntimeMigrationCapability(source!, {
        source: "mailchimp",
        auth_method: "oauth2",
        supports: {
          subscribers: true,
          automations: true,
          automation_mode: "runtime",
          paid_subs: false,
        },
      }),
    ).toMatchObject({
      authFlow: "oauth",
      serverSupport: true,
      fields: [],
      automationMode: "runtime",
      tagline:
        "The validated Classic welcomeSeries subset migrates paused; other Classic workflows and Customer Journeys require manual rebuild.",
    });
    expect(source!.tagline).not.toContain("paid subs");
    expect(migrationCredentialLabel("mailchimp")).toBe("OAuth connection");
  });

  it("describes Mailchimp rebuild-review mode without claiming Journey migration", () => {
    const source = findSource("mailchimp");
    expect(
      applyRuntimeMigrationCapability(source!, {
        source: "mailchimp",
        auth_method: "oauth2",
        supports: {
          automations: true,
          automation_mode: "rebuild_review",
        },
      }),
    ).toMatchObject({
      automationMode: "rebuild_review",
      tagline:
        "Classic Automations import for rebuild review; Customer Journeys remain manual.",
    });
  });

  it("keeps Beehiiv rebuild-only and billing boundaries after capability refresh", () => {
    const source = findSource("beehiiv");
    expect(
      applyRuntimeMigrationCapability(source!, {
        source: "beehiiv",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          automations: true,
          automation_mode: "rebuild_review",
          paid_subs: false,
        },
      }),
    ).toMatchObject({
      automationMode: "rebuild_review",
      tagline:
        "Subscribers and sent-post history import; segments and automations stay rebuild evidence, and premium memberships stay metadata rather than Stripe billing.",
    });
  });

  it("keeps Klaviyo identity, membership, nullable-definition, archive, and checklist boundaries explicit", () => {
    const source = findSource("klaviyo");
    expect(source).not.toBeNull();
    expect(source!.tagline).toContain("send-targetable membership projections");
    expect(source!.tagline).toContain("sent email history");
    expect(source!.tagline).toContain(
      "nullable-definition gaps require review",
    );
    expect(source!.tagline).toContain("campaign tags retain IDs");
    expect(source!.tagline).toContain("static checklists are not inventory");
    expect(source!.fields[0]?.help).not.toContain("metrics");
    expect(source!.fields[0]?.help).toContain(
      "Stable profile retrieval exposes only the primary email",
    );
    expect(source!.fields[0]?.help).toContain(
      "independent per-address consent through the preserved source-archive record",
    );
    expect(source!.fields[0]?.help).toContain(
      "predictive analytics and use its stricter 10/second, 150/minute tier",
    );
    expect(source!.fields[0]?.help).toContain(
      "Unnamed audiences use deterministic Klaviyo list/segment ID labels",
    );
    expect(source!.fields[0]?.help).toContain(
      "enumerated send-targetable projection after validated list-level suppressions, not a separately exposed raw count",
    );
    expect(source!.fields[0]?.help).toContain(
      "Draft campaign-message and flow definitions may be null",
    );
    expect(source!.fields[0]?.help).toContain(
      "Campaign tags retain provider IDs, not names/groups",
    );
    expect(source!.fields[0]?.help).toContain(
      "Eight unconditional static checklist rows each use source_total=1 but do not prove product inventory",
    );
    expect(source!.fields[0]?.help).toContain(
      "Reports, SMS runtime, and ecommerce are not imported",
    );

    expect(
      applyRuntimeMigrationCapability(source!, {
        source: "klaviyo",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: true,
          automation_mode: "rebuild_review",
          campaign_archive: true,
          reports: false,
          sms: false,
          ecommerce: false,
        },
      }),
    ).toMatchObject({
      authFlow: "api_key",
      serverSupport: true,
      automationMode: "rebuild_review",
      tagline:
        "Primary-email profiles plus enumerated send-targetable list/segment projections and sent email history import; no separate raw membership count is exposed. Secondary addresses, per-address consent, and nullable flow/draft-message definitions require manual review; campaign tags retain IDs only, SMS/push stays source-archive evidence, and eight static checklist rows do not prove product inventory.",
    });
    expect(migrationCredentialLabel("klaviyo")).toBe("private API key");
  });

  it("binds Customer.io credentials to an explicit workspace and region", () => {
    const source = findSource("customerio");
    expect(source).not.toBeNull();
    expect(source!.tagline).toContain("cio_id profiles");
    expect(source!.tagline).toContain("frozen segment memberships");
    expect(source!.tagline).toContain("three-layer email eligibility");
    expect(source!.fields[0]?.help).toContain("not a Track API site key");
    expect(source!.fields[0]?.help).toContain("immutable cio_id");
    expect(source!.fields[0]?.help).toContain(
      "global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default",
    );
    expect(source!.fields[0]?.help).toContain(
      "Sender-specific SMS/WhatsApp /v1/optouts are separate non-email evidence",
    );
    expect(source!.fields[0]?.help).toContain('explicit language="" default');
    expect(source!.fields[0]?.help).toContain(
      "deterministic lowest-ID A/B representation",
    );
    expect(source!.fields[0]?.help).toContain(
      "provable source layout/body composition",
    );
    expect(source!.fields[0]?.help).toContain(
      "rather than provider-rendered output",
    );
    expect(
      source!.fields.find((field) => field.key === "account_id")?.help,
    ).toContain("multiple workspaces");

    expect(
      buildMigrationCredentialInput(source!, {
        api_key: " cio_app_key ",
        account_id: " 9001 ",
        "extra.region": " EU ",
      }),
    ).toEqual({
      apiKey: "cio_app_key",
      accountId: "9001",
      extra: { region: "eu" },
    });
    expect(
      validateConnection(source!, {
        api_key: "cio_app_key",
        "extra.region": "apac",
      }),
    ).toBe("Region must be us or eu.");
    expect(
      validateConnection(source!, {
        api_key: "cio_app_key",
        account_id: "workspace-name",
      }),
    ).toBe("Workspace ID must contain 1 to 64 digits.");
    expect(
      validateConnection(source!, {
        api_key: "cio_app_key",
        account_id: "9".repeat(64),
      }),
    ).toBeNull();
    expect(
      validateConnection(source!, {
        api_key: "cio_app_key",
        account_id: "9".repeat(65),
      }),
    ).toBe("Workspace ID must contain 1 to 64 digits.");

    expect(
      applyRuntimeMigrationCapability(source!, {
        source: "customerio",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: true,
          automation_mode: "rebuild_review",
          campaign_archive: true,
          reports: false,
          custom_objects: false,
          sms: false,
        },
      }),
    ).toMatchObject({
      authFlow: "api_key",
      serverSupport: true,
      automationMode: "rebuild_review",
    });
    expect(migrationCredentialLabel("customerio")).toBe(
      "App API key + workspace/region",
    );
  });

  it("does not advertise an adapter missing from the runtime matrix", () => {
    const source = findSource("mailchimp");
    expect(applyRuntimeMigrationCapability(source!, undefined)).toMatchObject({
      authFlow: "oauth",
      serverSupport: false,
    });
  });
});
