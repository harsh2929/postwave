import { describe, expect, it } from "vitest";

import {
  mobileMigrationCutoverNote,
  migrationSourceAutomationNote,
  migrationSourceAuthLabel,
  supportedMigrationCapabilityLabels,
} from "./migrationSources";

describe("mobile migration source capability labels", () => {
  it("labels ActiveCampaign automation support as rebuild review", () => {
    expect(
      supportedMigrationCapabilityLabels({
        source: "activecampaign",
        supports: {
          subscribers: true,
          automations: true,
          automation_mode: "rebuild_review" as const,
          campaign_archive: true,
        },
      }),
    ).toEqual(["subscribers", "automation rebuild review", "campaign archive"]);
  });

  it("uses ActiveCampaign rebuild review wording for older payloads", () => {
    expect(
      supportedMigrationCapabilityLabels({
        source: "activecampaign",
        supports: {
          automations: true,
        },
      }),
    ).toEqual(["automation rebuild review"]);
  });

  it("labels Mailchimp runtime support as Classic Automations", () => {
    expect(
      supportedMigrationCapabilityLabels({
        source: "mailchimp",
        supports: {
          automations: true,
          automation_mode: "runtime" as const,
          paid_subs: false,
        },
      }),
    ).toEqual(["Validated Classic welcome series (runtime)"]);
    expect(
      migrationSourceAutomationNote({
        source: "mailchimp",
        supports: { automation_mode: "runtime" as const },
      }),
    ).toBe(
      "The validated Classic welcomeSeries subset migrates paused; other Classic workflows and Customer Journeys require manual rebuild.",
    );
  });

  it("labels Klaviyo campaign archive capability as sent-email-only", () => {
    expect(
      supportedMigrationCapabilityLabels({
        source: "klaviyo",
        supports: {
          campaign_archive: true,
          sms: false,
        },
      }),
    ).toEqual(["sent email campaign archive"]);
  });

  it("labels Customer.io campaigns and audiences as rebuild/frozen evidence", () => {
    expect(
      supportedMigrationCapabilityLabels({
        source: "customerio",
        supports: {
          segments: true,
          automations: true,
          automation_mode: "rebuild_review" as const,
          campaign_archive: true,
          campaigns: true,
        },
      }),
    ).toEqual([
      "frozen segment/topic snapshots",
      "workflow rebuild review",
      "sent email one-time-send archive",
      "campaign/broadcast rebuild evidence",
    ]);
  });

  it("keeps Mailchimp rebuild-review and Journey boundaries explicit", () => {
    expect(
      migrationSourceAutomationNote({
        source: "mailchimp",
        supports: { automation_mode: "rebuild_review" as const },
      }),
    ).toBe(
      "Classic Automations import for rebuild review; Customer Journeys remain manual.",
    );
  });

  it("keeps Beehiiv source and completed-job cutover boundaries explicit", () => {
    expect(
      migrationSourceAutomationNote({
        source: "beehiiv",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain("completed import is not cutover approval");
    expect(
      mobileMigrationCutoverNote({ source: "beehiiv", status: "completed" }),
    ).toContain("cutover is not certified");
    expect(
      mobileMigrationCutoverNote({ source: "beehiiv", status: "importing" }),
    ).toBeNull();
    expect(
      mobileMigrationCutoverNote({ source: "mailchimp", status: "completed" }),
    ).toBeNull();
  });

  it("keeps Klaviyo identity, flow, and final-snapshot cutover boundaries explicit", () => {
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain("flows are rebuild-only and never activated automatically");
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain(
      "Sent email campaigns are campaign-archive-only; sent SMS/push history is non-executable source-archive evidence",
    );
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain("final full-snapshot delta");
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain("Stable profile retrieval exposes only the primary email");
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain(
      "secondary addresses and independent per-address consent require multi-email source-archive, consent, and ecosystem review",
    );
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain("deterministic Klaviyo list/segment ID labels");
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain(
      "Predictive profile reads use the stricter 10/second, 150/minute tier",
    );
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain(
      "stable-ID email A→B change blocks replay until the full snapshot materializes B and disables source-owned A",
    );
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain(
      "enumerated send-targetable projection after validated list-level suppressions, not a separately exposed raw count",
    );
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain("Draft campaign-message and flow definitions may be null");
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain("campaign tags retain IDs only");
    expect(
      migrationSourceAutomationNote({
        source: "klaviyo",
        supports: {
          automations: true,
          automation_mode: "rebuild_review" as const,
        },
      }),
    ).toContain(
      "Eight unconditional source_total=1 static checklist rows do not prove product inventory",
    );
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain("Klaviyo cutover is not certified");
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain("fresh verification/shadow checks");
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain("Only sent email campaigns entered campaign history");
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain("Only the primary email identity imported");
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain("source-archive evidence tied to consent and ecosystem review");
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain(
      "stable-ID email A→B change materialized B and disabled source-owned A",
    );
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain(
      "post-list-suppression send-targetable projection, not raw membership",
    );
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain(
      "Recover or retire nullable flow/draft-message definitions, resolve campaign tag IDs",
    );
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "completed" }),
    ).toContain(
      "close all eight static checklist obligations without treating them as source inventory",
    );
    expect(
      mobileMigrationCutoverNote({ source: "klaviyo", status: "importing" }),
    ).toBeNull();
  });

  it("keeps Customer.io workspace, identity, and final-snapshot boundaries explicit", () => {
    const source = {
      source: "customerio",
      auth_method: "api_key",
      supports: {
        automations: true,
        automation_mode: "rebuild_review" as const,
        campaign_archive: true,
        sms: false,
      },
    };
    expect(migrationSourceAuthLabel(source)).toBe("App API key");
    expect(supportedMigrationCapabilityLabels(source)).toEqual([
      "workflow rebuild review",
      "sent email one-time-send archive",
    ]);
    expect(migrationSourceAutomationNote(source)).toContain(
      "bound to one US/EU workspace and immutable cio_id identities",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "no supported incremental profile-change feed",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "Sender-specific SMS/WhatsApp /v1/optouts remain separate non-email evidence",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      'explicit language="" default',
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "lowest stable ID represents a multi-default/A-B set",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "all variants remain evidence",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "source content/composition rather than provider-rendered output",
    );
    const completed = mobileMigrationCutoverNote({
      source: "customerio",
      status: "completed",
    });
    expect(completed).toContain("Customer.io cutover is not certified");
    expect(completed).toContain("final full email-addressable cio_id snapshot");
    expect(completed).toContain(
      "prove email enablement requires global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default",
    );
    expect(completed).toContain(
      "Reconcile sender-specific SMS/WhatsApp /v1/optouts separately from subscription-center channel preferences",
    );
    expect(completed).toContain('explicit language="" default');
    expect(completed).toContain("lowest-stable-ID A/B representative");
    expect(completed).toContain("all variants retained");
    expect(completed).toContain("provable source layout/body composition");
    expect(completed).toContain("no provider-rendering claim");
    expect(completed).toContain("all six Customer.io review gates");
    expect(
      mobileMigrationCutoverNote({
        source: "customerio",
        status: "importing",
      }),
    ).toBeNull();
  });

  it("labels HubSpot auth as private app token instead of generic API key", () => {
    const source = {
      source: "hubspot",
      auth_method: "api_key",
      supports: {},
    };
    expect(migrationSourceAuthLabel(source)).toBe("Private app token");
    expect(migrationSourceAutomationNote(source)).toContain(
      "per-type plus wide communication preferences",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "NOT_SPECIFIED remains unconfirmed",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "filter predicates are deliberately not fetched or stored",
    );
    expect(migrationSourceAutomationNote(source)).toContain(
      "Changed-contact polling misses",
    );
    const completed = mobileMigrationCutoverNote({
      source: "hubspot",
      status: "completed",
    });
    expect(completed).toContain("HubSpot cutover is not certified");
    expect(completed).toContain("at least seven days");
    expect(completed).toContain("authoritative full snapshot");
    expect(completed).toContain("local source-session deletion");
  });

  it("labels ActiveCampaign auth as API token", () => {
    expect(
      migrationSourceAuthLabel({
        source: "activecampaign",
        auth_method: "api_key",
        supports: {},
      }),
    ).toBe("API token");
  });
});
