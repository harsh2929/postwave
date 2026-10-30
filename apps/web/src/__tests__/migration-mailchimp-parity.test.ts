import { describe, expect, it } from "vitest";

import {
  mockDiscovery,
  mockGetJob,
  mockVerification,
} from "@/lib/migration-mocks";

describe("Mailchimp migration parity report", () => {
  it("surfaces audiences and source-session expiry for the Mailchimp wizard", () => {
    const discovery = mockDiscovery("mailchimp");
    const job = mockGetJob("mock_mailchimp");

    expect(discovery.audiences).toEqual([
      expect.objectContaining({
        id: "list_newsletter",
        name: "Newsletter",
        subscribers_total: 8800,
      }),
      expect.objectContaining({
        id: "list_customers",
        name: "Customers",
        subscribers_total: 3200,
      }),
      expect.objectContaining({
        id: "list_events",
        name: "Events",
        subscribers_total: discovery.subscribers_count - 12000,
      }),
    ]);
    expect(
      discovery.audiences?.reduce(
        (sum, audience) => sum + audience.subscribers_total,
        0,
      ),
    ).toBe(discovery.subscribers_count);
    expect(job.source_session_expires_at).toEqual(expect.any(String));
    expect(job.selected_audience_ids).toEqual([
      "list_customers",
      "list_events",
      "list_newsletter",
    ]);
  });

  it("surfaces P0 parity objects as imported or preserved", () => {
    const discovery = mockDiscovery("mailchimp");
    const report = mockVerification("mailchimp");
    const rows = new Map(
      (report.resource_completeness ?? []).map((row) => [row.resource, row]),
    );

    expect(rows.get("templates")).toMatchObject({
      source_total: discovery.templates_count,
      imported: discovery.templates_count,
      supported: true,
      status: "imported_runtime",
    });
    expect(rows.get("forms")).toMatchObject({
      source_total: discovery.forms_count,
      imported: discovery.forms_count,
      supported: true,
      status: "imported_runtime",
    });
    expect(rows.get("landing")).toMatchObject({
      source_total: discovery.landing_pages_count,
      imported: discovery.landing_pages_count,
      supported: true,
      status: "imported_runtime",
    });
    expect(rows.get("ecommerce")).toMatchObject({
      source_total: discovery.ecommerce_count,
      imported: discovery.ecommerce_count,
      supported: true,
      status: "imported_runtime",
    });
    expect(rows.get("reports")).toMatchObject({
      source_total: discovery.reports_count,
      imported: discovery.reports_count,
      supported: true,
      status: "imported_runtime",
    });
    expect(rows.get("automations")?.notes?.[0]).toMatch(/rebuild state/i);
  });
});
