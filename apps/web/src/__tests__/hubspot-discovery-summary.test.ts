import { describe, expect, it } from "vitest";

import { hubSpotDiscoveryIdentitySummary } from "@/lib/migration-discovery-summary";
import type { DiscoveryReport } from "@/lib/types";

describe("HubSpot discovery identity summary", () => {
  it("surfaces excluded primary-email contacts and additional identities separately", () => {
    const report = {
      source: "hubspot",
      subscribers_count: 120,
      profiles_without_email_count: 7,
      additional_email_identities_count: 11,
      segments_count: 4,
      automations_count: 0,
      archive_count: 0,
      paid_subs_count: 0,
      custom_fields: [],
      warnings: [],
    } satisfies DiscoveryReport;

    expect(hubSpotDiscoveryIdentitySummary(report)).toEqual([
      ["Contacts without a valid primary email (not imported)", 7],
      ["Additional email identities (review only)", 11],
    ]);
  });

  it("keeps absent optional evidence visible as zero without merging categories", () => {
    const report = {
      source: "hubspot",
      subscribers_count: 0,
      segments_count: 0,
      automations_count: 0,
      archive_count: 0,
      paid_subs_count: 0,
      custom_fields: [],
      warnings: [],
    } satisfies DiscoveryReport;

    expect(hubSpotDiscoveryIdentitySummary(report)).toEqual([
      ["Contacts without a valid primary email (not imported)", 0],
      ["Additional email identities (review only)", 0],
    ]);
  });
});
