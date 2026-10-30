// SPDX-License-Identifier: AGPL-3.0-only
//
// The pure halves of the campaign activity panels' transport: the summary's
// 404-is-a-state rule, the markdown subset it is rendered from, the byte-offset
// region splice, and the web-version URL composed from archive settings.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => null),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: mocks.get, post: vi.fn() } };
});

import { ApiError } from "@/lib/api";
import { archiveIssueUrl, type ArchiveSettings } from "@/lib/archive-admin-api";
import {
  applyRegionPicks,
  campaignArchiveFields,
  campaignSummaryAvailable,
  getCampaignSummary,
  parseSummaryMarkdown,
} from "@/lib/campaign-detail-panels-api";

const SETTINGS: ArchiveSettings = {
  tenant_archive_slug: "acme",
  archive_domain: "",
  archive_title: "",
  archive_tagline: "",
  tips_enabled: false,
  tips_currency: "usd",
  tips_suggested_amounts: [],
  tips_min_amount: 0,
  tips_message: "",
  archive_bar_default_enabled: false,
  view_in_browser_default_enabled: false,
};

beforeEach(() => {
  mocks.get.mockReset();
});

describe("getCampaignSummary", () => {
  it("reads 404 as 'no summary yet' and rethrows every other refusal", async () => {
    mocks.get.mockRejectedValueOnce(new ApiError("no summary yet", 404));
    await expect(getCampaignSummary("c1")).resolves.toBeNull();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/campaigns/c1/summary");

    mocks.get.mockRejectedValueOnce(new ApiError("role denied", 403));
    await expect(getCampaignSummary("c1")).rejects.toThrow("role denied");
  });

  it("is withheld for exactly the statuses the regenerate POST refuses", () => {
    expect(campaignSummaryAvailable("draft")).toBe(false);
    expect(campaignSummaryAvailable("Scheduled")).toBe(false);
    expect(campaignSummaryAvailable("paused")).toBe(false);
    expect(campaignSummaryAvailable("sent")).toBe(true);
    expect(campaignSummaryAvailable("sending")).toBe(true);
  });
});

describe("parseSummaryMarkdown", () => {
  it("keeps bold and code as runs and never passes markup through", () => {
    expect(
      parseSummaryMarkdown("Open **8%** vs `base`.\n\n<img src=x onerror=1>"),
    ).toEqual([
      [
        { kind: "text", text: "Open " },
        { kind: "bold", text: "8%" },
        { kind: "text", text: " vs " },
        { kind: "code", text: "base" },
        { kind: "text", text: "." },
      ],
      [{ kind: "text", text: "<img src=x onerror=1>" }],
    ]);
  });
});

describe("applyRegionPicks", () => {
  it("splices on UTF-8 byte offsets, not UTF-16 indices", () => {
    const prefix = "😀é ";
    const region = "{{#if A}}yes{{else}}no{{/if}}";
    const body = `${prefix}${region}!`;
    const start = new TextEncoder().encode(prefix).length;
    const end = start + new TextEncoder().encode(region).length;
    const regions = [
      {
        key: "A",
        start,
        end,
        true_branch: "yes",
        false_branch: "no",
        has_else: true,
        children: [],
      },
    ];
    expect(applyRegionPicks(body, regions, { A: "true" })).toBe(`${prefix}yes!`);
    expect(applyRegionPicks(body, regions, { A: "false" })).toBe(`${prefix}no!`);
    expect(applyRegionPicks(body, regions, {})).toBe(body);
  });
});

describe("web version URL", () => {
  it("hangs the campaign slug off the vanity host when one is configured", () => {
    expect(
      archiveIssueUrl(
        { ...SETTINGS, archive_domain: "https://News.Acme.com/" },
        "https://app.example.com",
        "spring-sale",
      ),
    ).toBe("https://news.acme.com/spring-sale");
  });

  it("uses this app's archive route when there is no vanity host", () => {
    expect(
      archiveIssueUrl(SETTINGS, "https://app.example.com", "spring-sale"),
    ).toBe("https://app.example.com/en/archive/acme/spring-sale");
  });

  it("refuses to compose a link that would resolve nowhere", () => {
    expect(
      archiveIssueUrl({ ...SETTINGS, tenant_archive_slug: "" }, "", "spring-sale"),
    ).toBeNull();
    expect(archiveIssueUrl(SETTINGS, "", "../admin")).toBeNull();
    expect(archiveIssueUrl(SETTINGS, "", "")).toBeNull();
  });

  it("reads the archive fields defensively off the campaign payload", () => {
    expect(
      campaignArchiveFields({ archive_public: true, archive_slug: " s-1 " }),
    ).toEqual({ archivePublic: true, archiveSlug: "s-1" });
    expect(campaignArchiveFields({ archive_public: "yes" })).toEqual({
      archivePublic: false,
      archiveSlug: "",
    });
    expect(campaignArchiveFields(null)).toEqual({
      archivePublic: false,
      archiveSlug: "",
    });
  });
});
