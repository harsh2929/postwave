import { describe, expect, it, vi, afterEach } from "vitest";

import {
  mockCapability,
  mockDiscovery,
  mockGetJob,
  mockStartJob,
  mockVerification,
} from "@/lib/migration-mocks";
import { sourceSessionStatus } from "@/lib/migration-source-session";

afterEach(() => {
  vi.useRealTimers();
});

describe("migration mocks", () => {
  it("keeps ActiveCampaign mock jobs outside the cutover near-expiry window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));

    const job = mockStartJob("activecampaign", "awaiting_confirmation");

    expect(
      sourceSessionStatus(
        "activecampaign",
        job.source_session_expires_at,
        "cutover checks",
      ),
    ).toEqual({ kind: "ok", message: "" });
  });

  it("keeps generic mock jobs healthy with the shorter demo session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));

    const job = mockStartJob("mailchimp", "awaiting_confirmation");

    expect(
      sourceSessionStatus(
        "mailchimp",
        job.source_session_expires_at,
        "dry-run",
      ),
    ).toEqual({ kind: "ok", message: "" });
  });

  it("does not overclaim Customer.io runtime or channel capabilities", () => {
    expect(mockCapability("customerio")).toMatchObject({
      source: "customerio",
      auth_method: "api_key",
      supports: {
        subscribers: true,
        segments: true,
        automations: true,
        automation_mode: "rebuild_review",
        campaign_archive: true,
        consent_timestamps: false,
        reports: false,
        custom_objects: false,
        sms: false,
      },
    });
  });

  it("keeps HubSpot consent evidence and combined targeting boundaries explicit", () => {
    const capability = mockCapability("hubspot");
    const discovery = mockDiscovery("hubspot");
    const report = mockVerification("hubspot");
    const rows = new Map(
      report.resource_completeness?.map((row) => [row.resource, row]),
    );

    expect(capability.supports.consent_timestamps).toBe(true);
    expect(discovery.segments_count).toBeGreaterThan(0);
    expect(rows.get("lists")).toMatchObject({
      label: "HubSpot list and subscription targeting boundaries",
      source_total: discovery.segments_count,
    });
    expect(rows.get("lists")?.notes?.join(" ")).toContain(
      "combined count includes exact list snapshots and one targeting boundary for every active email subscription definition",
    );
    expect(rows.get("dynamic_list_predicates")?.notes?.join(" ")).toContain(
      "deliberately not fetched or stored",
    );
  });

  it("keeps Customer.io mock discovery and completeness on the exact rebuild contract", () => {
    const discovery = mockDiscovery("customerio");
    const report = mockVerification("customerio");
    const rows = new Map(
      report.resource_completeness?.map((row) => [row.resource, row]),
    );

    expect(discovery).toMatchObject({
      segments_count: 3,
      automations_count: 28,
      archive_count: 32,
      campaigns_count: 70,
      custom_objects_count: 4,
      subscription_channels_count: 3,
      source_archive_count: 147,
    });
    expect(discovery.audiences).toHaveLength(discovery.segments_count);
    expect(report.resource_completeness).toHaveLength(15);
    expect(rows.get("subscription_topics")).toMatchObject({
      label: "Subscription-topic and channel definitions",
      source_total: 4,
      imported: 4,
      status: "preserved_for_rebuild",
    });
    expect(rows.get("source_archive")).toMatchObject({
      source_total: discovery.source_archive_count,
      imported: discovery.source_archive_count,
      status: "preserved_for_rebuild",
    });
    expect(report.source_archive_by_resource).toMatchObject({
      customerio_subscription_topic: 1,
      customerio_subscription_channel: 3,
      customerio_campaign_workflow: 18,
      customerio_broadcast_workflow: 10,
    });
    expect(
      Object.values(report.source_archive_by_resource ?? {}).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(discovery.source_archive_count);
    expect(rows.get("workflow_definitions")).toMatchObject({
      source_total: discovery.automations_count,
      imported: discovery.automations_count,
      status: "preserved_for_rebuild",
    });
    expect(rows.get("campaigns")?.notes?.join(" ")).toContain(
      "multi-default/A-B set",
    );
    expect(rows.get("campaigns")?.notes?.join(" ")).toContain(
      "exactly one documented {{content}} slot",
    );
    expect(rows.get("source_archive")?.notes?.join(" ")).toContain(
      "original payloads, audiences, and per-user data",
    );
  });

  it("recovers ActiveCampaign source identity from mock job ids after state loss", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));

    const job = mockGetJob("job_activecampaign_recovered");
    const report = mockVerification("job_activecampaign_report");

    expect(job.source).toBe("activecampaign");
    expect(
      sourceSessionStatus(
        "activecampaign",
        job.source_session_expires_at,
        "cutover checks",
      ),
    ).toEqual({ kind: "ok", message: "" });
    expect(
      report.resource_completeness?.some((row) => row.resource === "sms"),
    ).toBe(true);
  });

  it("treats ActiveCampaign automations as rebuild-only in mock reports", () => {
    expect(mockCapability("activecampaign").supports.automation_mode).toBe(
      "rebuild_review",
    );

    const discovery = mockDiscovery("activecampaign");
    const report = mockVerification("activecampaign");

    expect(report.automations_translated).toBe(0);
    expect(report.automations_unsupported).toHaveLength(
      discovery.automations_count,
    );

    const discoveryRows = new Map(
      discovery.resource_metadata?.map((row) => [row.resource, row]),
    );
    const reportRows = new Map(
      report.resource_completeness?.map((row) => [row.resource, row]),
    );

    expect(discoveryRows.get("automations")).toMatchObject({
      imported: 0,
      status: "manual_rebuild_required",
    });
    expect(reportRows.get("automations")).toMatchObject({
      imported: 0,
      status: "manual_rebuild_required",
    });
    expect(reportRows.get("audience_schema")).toMatchObject({
      status: "preserved_for_rebuild",
    });
    expect(reportRows.get("groups")).toMatchObject({
      label: "Assigned tags",
      imported: discovery.groups_count,
      status: "imported_runtime",
    });
    expect(reportRows.get("campaigns")?.status).toBe("partial_runtime");
    expect(reportRows.get("consent_exclusions")?.status).toBe(
      "manual_rebuild_required",
    );
    expect(reportRows.get("non_email_contacts")?.status).toBe("not_detected");
    for (const resource of [
      "audience_schema",
      "templates",
      "forms",
      "crm",
      "custom_objects",
      "ecommerce",
      "sms",
    ]) {
      expect(reportRows.get(resource)?.status).toBe("preserved_for_rebuild");
    }
  });

  it("keeps Beehiiv mock capabilities and verification aligned with the migration contract", () => {
    const capability = mockCapability("beehiiv");
    expect(capability.supports).toMatchObject({
      subscribers: true,
      segments: true,
      groups: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: false,
    });

    const discovery = mockDiscovery("beehiiv");
    const report = mockVerification("beehiiv");
    expect(discovery.paid_subs_count).toBeGreaterThan(0);
    expect(discovery.forms_count ?? 0).toBe(0);
    expect(discovery.landing_pages_count ?? 0).toBe(0);
    expect(report.automations_translated).toBe(0);
    expect(report.automations_unsupported).toHaveLength(
      discovery.automations_count,
    );
    expect(report.paid_subs_imported).toBe(0);

    const rows = new Map(
      report.resource_completeness?.map((row) => [row.resource, row]),
    );
    expect(rows.get("automations")).toMatchObject({
      imported: discovery.automations_count,
      status: "preserved_for_rebuild",
    });
    expect(rows.get("premium_memberships")).toMatchObject({
      source_total: discovery.paid_subs_count,
      imported: discovery.paid_subs_count,
      status: "imported_runtime",
    });
    expect(rows.get("paid_subs")).toMatchObject({
      source_total: discovery.paid_subs_count,
      imported: 0,
      supported: false,
      status: "manual_rebuild_required",
    });
    expect(rows.get("newsletter_list_history")).toMatchObject({
      source_total: discovery.groups_count,
      imported: discovery.groups_count,
    });
    expect(rows.get("newsletter_list_definitions")).toMatchObject({
      source_total: discovery.groups_count,
      imported: discovery.groups_count,
    });
    expect(rows.get("automation_email_inventory")).toMatchObject({
      source_total: discovery.automations_count,
      imported: discovery.automations_count,
      status: "imported_runtime",
    });
    for (const resource of [
      "beehiiv_website_capture_rebuild",
      "beehiiv_boosts_recommendations_rebuild",
      "beehiiv_ad_network_rebuild",
    ]) {
      expect(rows.get(resource)).toMatchObject({
        source_total: 1,
        imported: 1,
        status: "preserved_for_rebuild",
      });
    }
  });

  it("keeps Klaviyo mock capability and flow results rebuild-only", () => {
    const capability = mockCapability("klaviyo");
    expect(capability.auth_method).toBe("api_key");
    expect(capability.supports).toMatchObject({
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      templates: true,
      reports: false,
      forms: true,
      ecommerce: false,
      sms: false,
    });

    const discovery = mockDiscovery("klaviyo");
    const report = mockVerification("klaviyo");
    expect(discovery).toMatchObject({
      profiles_without_email_count: 84,
      sms_campaigns_count: 12,
      push_campaigns_count: 7,
      source_archive_count: 26,
    });
    expect(report.automations_translated).toBe(0);
    expect(report.automations_unsupported).toHaveLength(
      discovery.automations_count,
    );
    expect(report.source_archive_imported).toBe(26);
    expect(discovery.audiences).toEqual([
      {
        id: "klaviyo:list:L_UNNAMED",
        name: "Klaviyo list L_UNNAMED",
        subscribers_total: 7_200,
      },
      {
        id: "klaviyo:segment:S_UNNAMED",
        name: "Klaviyo segment S_UNNAMED",
        subscribers_total: 3_100,
      },
    ]);
    expect(discovery.warnings.join(" ")).toContain("stable Get Profiles");
    expect(discovery.warnings.join(" ")).toContain(
      "secondary email identifiers",
    );
    expect(discovery.warnings.join(" ")).toContain("10 requests/second");
    expect(discovery.warnings.join(" ")).toContain("150 requests/minute");
    expect(discovery.warnings.join(" ")).toContain(
      "Klaviyo list <id> or Klaviyo segment <id> fallbacks",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "full final snapshot must materialize the new address and disable the old address",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "send-targetable projection after validated list-level suppressions",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "raw count is not exposed separately",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "Draft campaign-message definitions and flow definitions may be null",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "campaign tags preserve provider IDs only",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "Eight static source-archive product-area rows are emitted unconditionally",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "does not prove source inventory",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "Dynamic segment predicates and flows require rebuild review",
    );
    expect(discovery.warnings.join(" ")).toContain(
      "sent SMS and push remain non-executable source-archive evidence",
    );
    const completeness = new Map(
      report.resource_completeness?.map((row) => [row.resource, row]),
    );
    expect(completeness.get("campaigns")?.label).toBe(
      "Sent email campaign archive",
    );
    expect(completeness.get("campaigns")?.notes?.join(" ") ?? "").toContain(
      "Only sent email campaigns materialize",
    );
    expect(completeness.get("non_email_campaigns")?.label).toBe(
      "Sent SMS and push source-archive evidence",
    );
    expect(completeness.get("non_email_campaigns")?.source_total).toBe(19);
    expect(
      completeness.get("non_email_campaigns")?.notes?.join(" ") ?? "",
    ).toContain("never materialize as email campaign rows");
    expect(completeness.get("subscribers")?.label).toBe(
      "Primary-email profiles",
    );
    expect(completeness.get("multi_email_profiles")).toMatchObject({
      label: "Secondary email identities and per-address consent",
      source_total: 1,
      imported: 1,
      supported: false,
      status: "manual_rebuild_required",
    });
    expect(
      completeness.get("multi_email_profiles")?.notes?.join(" ") ?? "",
    ).toContain("not a count of affected profiles");
    for (const resource of [
      "ecommerce",
      "reviews",
      "service",
      "cdp",
      "multi_email_profiles",
      "omni_channels",
      "deliverability",
      "marketplace",
    ]) {
      const staticChecklist = completeness.get(resource);
      expect(staticChecklist).toMatchObject({
        source_total: 1,
        imported: 1,
        supported: false,
        status: "manual_rebuild_required",
      });
      expect(staticChecklist?.notes?.join(" ") ?? "").toContain(
        "unconditional",
      );
      expect(staticChecklist?.notes?.join(" ") ?? "").toMatch(
        /not (proof|a count)/,
      );
    }
    expect(completeness.get("segments")?.notes?.join(" ") ?? "").toContain(
      "send-targetable projection",
    );
    expect(completeness.get("segments")?.notes?.join(" ") ?? "").toContain(
      "does not expose a separate raw membership count",
    );
    expect(completeness.get("automations")?.notes?.join(" ") ?? "").toContain(
      "nullable source definition",
    );
    expect(completeness.get("campaigns")?.notes?.join(" ") ?? "").toContain(
      "Draft campaign-message definitions may be null",
    );
    expect(completeness.get("campaigns")?.notes?.join(" ") ?? "").toContain(
      "provider IDs only",
    );
  });
});
