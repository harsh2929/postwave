import { describe, expect, it } from "vitest";

import {
  capabilityMatchesSearch,
  filterCapabilities,
  groupCapabilities,
  migrationSourceCategory,
  migrationSourceCtaVerb,
} from "@/lib/migration-source-catalog";
import type { AdapterCapabilities, SourcePlatform } from "@/lib/types";

function cap(
  source: SourcePlatform,
  auth: AdapterCapabilities["auth_method"],
): AdapterCapabilities {
  return {
    source,
    auth_method: auth,
    supports: {
      subscribers: true,
      segments: true,
      automations: false,
      campaign_archive: false,
      paid_subs: false,
      consent_timestamps: false,
    },
  };
}

describe("migration source catalogue (MIGR-020 / MIGR-030)", () => {
  it("categorises file-upload, CRM, and ESP sources", () => {
    expect(migrationSourceCategory(cap("csv", "csv_upload"))).toBe("file");
    expect(migrationSourceCategory(cap("substack", "csv_upload"))).toBe("file");
    expect(migrationSourceCategory(cap("hubspot", "api_key"))).toBe("crm");
    expect(migrationSourceCategory(cap("mailchimp", "oauth2"))).toBe("esp");
  });

  it("derives the CTA verb from the connection type", () => {
    expect(migrationSourceCtaVerb(cap("csv", "csv_upload"))).toBe("Upload");
    expect(migrationSourceCtaVerb(cap("substack", "csv_upload"))).toBe("Upload");
    expect(migrationSourceCtaVerb(cap("mailchimp", "oauth2"))).toBe("Connect");
    expect(migrationSourceCtaVerb(cap("hubspot", "api_key"))).toBe("Connect");
  });

  it("matches search over label and slug, case-insensitively", () => {
    expect(capabilityMatchesSearch(cap("mailchimp", "oauth2"), "mail")).toBe(
      true,
    );
    expect(capabilityMatchesSearch(cap("customerio", "api_key"), "Customer")).toBe(
      true,
    );
    expect(capabilityMatchesSearch(cap("mailchimp", "oauth2"), "klaviyo")).toBe(
      false,
    );
    // empty query matches everything
    expect(capabilityMatchesSearch(cap("mailchimp", "oauth2"), "  ")).toBe(true);
  });

  it("filters the catalogue by query", () => {
    const caps = [
      cap("mailchimp", "oauth2"),
      cap("klaviyo", "api_key"),
      cap("csv", "csv_upload"),
    ];
    expect(filterCapabilities(caps, "csv").map((c) => c.source)).toEqual(["csv"]);
  });

  it("groups sources ESP → CRM → File, dropping empty groups", () => {
    const groups = groupCapabilities([
      cap("mailchimp", "oauth2"),
      cap("hubspot", "api_key"),
      cap("csv", "csv_upload"),
      cap("klaviyo", "api_key"),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["esp", "crm", "file"]);
    expect(groups[0]!.caps.map((c) => c.source)).toEqual([
      "mailchimp",
      "klaviyo",
    ]);
  });
});
