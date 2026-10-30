import { describe, expect, it } from "vitest";

import {
  asCampaignString,
  resolveCampaignArchiveBase,
  resolveCampaignFromEmail,
} from "../../components/campaigns/useCampaignDetailData";
import type {
  ArchiveTenantSettings,
  CampaignDetail,
} from "../../lib/api-client";

describe("campaign detail data helpers", () => {
  it("resolves vanity domains before path-based archive slugs", () => {
    expect(
      resolveCampaignArchiveBase(
        settings({
          archive_domain: "https://news.example.com/",
          tenant_archive_slug: "ignored",
        }),
      ),
    ).toBe("https://news.example.com");
    expect(
      resolveCampaignArchiveBase(
        settings({ archive_domain: "news.example.com" }),
      ),
    ).toBe("https://news.example.com");
  });

  it("encodes path archive slugs and fails honestly when unconfigured", () => {
    expect(
      resolveCampaignArchiveBase(
        settings({ tenant_archive_slug: "launch / 2026" }),
      ),
    ).toBe("https://archive.moosewave.com/launch%20%2F%202026");
    expect(resolveCampaignArchiveBase(settings())).toBeNull();
    expect(resolveCampaignArchiveBase(null)).toBeNull();
  });

  it("preserves the effective sender precedence", () => {
    expect(
      resolveCampaignFromEmail({
        from_email: "top@example.com",
        delivery_settings: { from_email: "nested@example.com" },
      } as CampaignDetail),
    ).toBe("top@example.com");
    expect(
      resolveCampaignFromEmail({
        delivery_settings: { from_email: "nested@example.com" },
      } as CampaignDetail),
    ).toBe("nested@example.com");
    expect(resolveCampaignFromEmail({} as CampaignDetail)).toBe("");
  });

  it("normalizes campaign bodies without manufacturing null text", () => {
    expect(asCampaignString("<p>Hello</p>")).toBe("<p>Hello</p>");
    expect(asCampaignString(42)).toBe("42");
    expect(asCampaignString(null)).toBe("");
    expect(asCampaignString(undefined)).toBe("");
  });
});

function settings(
  overrides: Partial<ArchiveTenantSettings> = {},
): ArchiveTenantSettings {
  return overrides as ArchiveTenantSettings;
}
