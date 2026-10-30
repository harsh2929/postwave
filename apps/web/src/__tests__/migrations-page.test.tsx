import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MigrationsIndexContent } from "@/app/(dashboard)/app/migrations/_index-content";
import { mockCapabilities } from "@/lib/migration-mocks";
import {
  MIGRATION_SOURCE_PLATFORMS,
  type AdapterCapabilities,
} from "@/lib/types";

describe("MigrationsPage", () => {
  it("labels ActiveCampaign automations as rebuild review on the source card", async () => {
    const capabilities: AdapterCapabilities[] = [
      {
        source: "activecampaign",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: true,
          automation_mode: "rebuild_review",
          campaign_archive: true,
          paid_subs: false,
          consent_timestamps: true,
          templates: false,
          campaigns: true,
          reports: true,
          groups: true,
          forms: true,
          landing_pages: false,
          ecommerce: true,
          crm: true,
          custom_objects: true,
          sms: true,
        },
      },
    ];

    const html = renderToStaticMarkup(
      <MigrationsIndexContent capabilities={capabilities} jobs={[]} />,
    );

    expect(html).toContain("Automation rebuild review");
    expect(html).toContain("API token");
    expect(html).toContain("enriched automation definitions are rebuild-only");
    expect(html).not.toContain(">Automations</span>");
  });

  it("labels HubSpot as a Service Key CRM bridge on the source card", async () => {
    const capabilities: AdapterCapabilities[] = [
      {
        source: "hubspot",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: false,
          campaign_archive: false,
          paid_subs: false,
          consent_timestamps: true,
          templates: false,
          campaigns: false,
          reports: false,
          groups: true,
          forms: false,
          landing_pages: false,
          ecommerce: false,
          crm: true,
          custom_objects: false,
          sms: false,
        },
      },
    ];

    const html = renderToStaticMarkup(
      <MigrationsIndexContent capabilities={capabilities} jobs={[]} />,
    );

    expect(html).toContain("HubSpot");
    expect(html).toContain("Service Key / token");
    expect(html).toContain("portal-bound 2026-03 snapshot");
    expect(html).toContain(
      "dynamic-list predicates are deliberately not requested or persisted",
    );
    expect(html).toContain("not exact HubSpot sendability parity");
    expect(html).not.toContain("API key");
  });

  it("labels Klaviyo as a bounded private-key flow-rebuild import", async () => {
    const capabilities: AdapterCapabilities[] = [
      {
        source: "klaviyo",
        auth_method: "api_key",
        supports: {
          subscribers: true,
          segments: true,
          automations: true,
          automation_mode: "rebuild_review",
          campaign_archive: true,
          paid_subs: false,
          consent_timestamps: true,
          templates: true,
          campaigns: true,
          reports: false,
          groups: false,
          forms: true,
          landing_pages: false,
          ecommerce: false,
          sms: false,
        },
      },
    ];

    const html = renderToStaticMarkup(
      <MigrationsIndexContent capabilities={capabilities} jobs={[]} />,
    );

    expect(html).toContain("Klaviyo");
    expect(html).toContain("Private API key");
    expect(html).toContain("Flow rebuild review");
    expect(html).toContain("primary email identity");
    expect(html).toContain("stable Get Profiles response");
    expect(html).toContain("secondary email addresses");
    expect(html).toContain("independent per-address consent");
    expect(html).toContain("10 requests/second");
    expect(html).toContain("Klaviyo list &lt;id&gt;");
    expect(html).toContain("stable profile ID changes from email A to B");
    expect(html).toContain("send-targetable list/segment projection");
    expect(html).toContain(
      "Raw Klaviyo audience membership counts are not exposed separately",
    );
    expect(html).toContain(
      "Draft campaign-message definitions and flow definitions may be null",
    );
    expect(html).toContain("provider IDs only");
    expect(html).toContain(
      "always emits eight static product-area checklist records",
    );
    expect(html).toContain("sent email campaign archive rows");
    expect(html).toContain(
      "Sent SMS and push records remain non-executable source-archive evidence",
    );
    expect(html).toContain("never become email campaigns");
    expect(html).toContain("non-email-only profiles are not imported");
  });

  it("renders every canonical source from the capability response", async () => {
    const html = renderToStaticMarkup(
      <MigrationsIndexContent capabilities={mockCapabilities()} jobs={[]} />,
    );

    for (const source of MIGRATION_SOURCE_PLATFORMS) {
      expect(html).toContain(`data-testid="source-${source}"`);
    }
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("does not misreport a failed migration-history request as an empty history", async () => {
    const html = renderToStaticMarkup(
      <MigrationsIndexContent
        capabilities={mockCapabilities()}
        jobs={[]}
        jobsUnavailable
      />,
    );

    expect(html).toContain("Migration history unavailable");
    expect(html).toContain("not an empty migration history");
    expect(html).not.toContain("No migrations yet");
  });

  it("does not misreport a failed capability request as an empty catalogue", async () => {
    const html = renderToStaticMarkup(
      <MigrationsIndexContent
        capabilities={[]}
        jobs={[]}
        capabilitiesUnavailable
      />,
    );

    expect(html).toContain("Source catalogue unavailable");
    expect(html).toContain("not an empty catalogue");
    expect(html).not.toContain("No migration sources are available yet");
  });
});
