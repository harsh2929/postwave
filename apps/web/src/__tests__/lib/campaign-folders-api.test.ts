// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign folders + organization tags, asserted at the wire: method, exact
// path (the campaign id is a path SEGMENT, so it must be encoded), body, and
// the transport option that keeps a write out of the offline queue — the list
// reports the server's answer per campaign, and a queued write has none.

import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => null),
  post: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      null,
  ),
  patch: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      null,
  ),
}));

vi.mock("@/lib/api", () => ({ api: transport }));

import {
  ALL_FOLDERS,
  UNCATEGORISED_FOLDER,
  bulkTagCampaigns,
  campaignFolderId,
  campaignFolderKeys,
  campaignOrgTagProblem,
  createCampaignFolder,
  filterCampaignsByFolder,
  listCampaignFolders,
  moveCampaignToFolder,
} from "@/lib/campaign-folders-api";
import type { Campaign } from "@/lib/campaigns-api";

beforeEach(() => {
  transport.get.mockReset();
  transport.post.mockReset();
  transport.patch.mockReset();
});

function campaign(id: string, folder_id?: string): Campaign {
  return {
    id,
    tenant_id: "t1",
    name: id,
    subject: id,
    status: "draft",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...(folder_id !== undefined ? { folder_id } : {}),
  } as Campaign;
}

describe("listCampaignFolders", () => {
  it("reads GET /api/v1/campaigns/folders and parses the {items} envelope", async () => {
    transport.get.mockResolvedValue({
      items: [
        {
          id: "f1",
          tenant_id: "t1",
          name: "Launches",
          campaign_count: 3,
          created_at: "2026-09-01T00:00:00Z",
          updated_at: "2026-09-02T00:00:00Z",
        },
      ],
    });
    await expect(listCampaignFolders()).resolves.toEqual([
      {
        id: "f1",
        name: "Launches",
        campaign_count: 3,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-02T00:00:00Z",
      },
    ]);
    expect(transport.get).toHaveBeenCalledWith("/api/v1/campaigns/folders");
  });

  it("drops rows that cannot be filtered on and never trusts a non-numeric count", async () => {
    transport.get.mockResolvedValue({
      items: [
        { id: "", name: "No id" },
        { id: "f2", name: "   " },
        { id: "f3", name: "Kept", campaign_count: "7" },
        null,
      ],
    });
    await expect(listCampaignFolders()).resolves.toEqual([
      { id: "f3", name: "Kept", campaign_count: 0 },
    ]);
  });

  it("treats a missing items field as no folders rather than crashing", async () => {
    transport.get.mockResolvedValue({});
    await expect(listCampaignFolders()).resolves.toEqual([]);
  });
});

describe("createCampaignFolder", () => {
  it("POSTs the trimmed name, online-only, and returns the server's folder", async () => {
    transport.post.mockResolvedValue({
      id: "f9",
      name: "Q4",
      campaign_count: 0,
    });
    await expect(createCampaignFolder("  Q4  ")).resolves.toMatchObject({
      id: "f9",
      name: "Q4",
    });
    expect(transport.post).toHaveBeenCalledWith(
      "/api/v1/campaigns/folders",
      { name: "Q4" },
      { requireOnline: true },
    );
  });

  it("refuses a blank name before any request", async () => {
    await expect(createCampaignFolder("   ")).rejects.toThrow(
      "Name the folder before creating it.",
    );
    expect(transport.post).not.toHaveBeenCalled();
  });
});

describe("moveCampaignToFolder", () => {
  it("PATCHes /campaigns/{id}/folder with the encoded id and the folder id", async () => {
    transport.patch.mockResolvedValue({ ok: true, folder_id: "f1" });
    await expect(moveCampaignToFolder("a/b c", "f1")).resolves.toEqual({
      folder_id: "f1",
    });
    expect(transport.patch).toHaveBeenCalledWith(
      "/api/v1/campaigns/a%2Fb%20c/folder",
      { folder_id: "f1" },
      { requireOnline: true },
    );
  });

  it("sends an empty folder id to move a campaign back to uncategorised", async () => {
    transport.patch.mockResolvedValue({ ok: true, folder_id: "" });
    await moveCampaignToFolder("c1", "");
    expect(transport.patch.mock.calls[0]?.[1]).toEqual({ folder_id: "" });
  });
});

describe("bulkTagCampaigns", () => {
  it("POSTs deduplicated ids and the normalized tag in one request", async () => {
    transport.post.mockResolvedValue({ ok: true, tag: "launch", tagged: 2 });
    await expect(
      bulkTagCampaigns(["c1", "c2", "c1", " "], "  Launch "),
    ).resolves.toEqual({ tag: "launch", tagged: 2 });
    expect(transport.post).toHaveBeenCalledWith(
      "/api/v1/campaigns/org-tags/bulk",
      { campaign_ids: ["c1", "c2"], tag: "launch" },
      { requireOnline: true },
    );
  });

  it("refuses an empty tag, an over-long tag, and more than 500 campaigns before sending", async () => {
    await expect(bulkTagCampaigns(["c1"], "  ")).rejects.toThrow(
      "Enter a tag.",
    );
    await expect(bulkTagCampaigns(["c1"], "x".repeat(41))).rejects.toThrow(
      /40 characters or fewer/,
    );
    const many = Array.from({ length: 501 }, (_, i) => `c${i}`);
    await expect(bulkTagCampaigns(many, "launch")).rejects.toThrow(
      /at most 500 campaigns/,
    );
    await expect(bulkTagCampaigns([], "launch")).rejects.toThrow(
      /at least one campaign/,
    );
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("measures the tag cap in bytes, as the server truncates it", () => {
    // 20 two-byte characters = 40 bytes: allowed. 21 = 42 bytes: refused.
    expect(campaignOrgTagProblem("é".repeat(20))).toBeNull();
    expect(campaignOrgTagProblem("é".repeat(21))).toMatch(/40 characters/);
  });
});

describe("folder filtering", () => {
  const rows = [campaign("a", "f1"), campaign("b"), campaign("c", "f2")];

  it("reads folder_id off list rows, treating absent as uncategorised", () => {
    expect(rows.map(campaignFolderId)).toEqual(["f1", "", "f2"]);
  });

  it("filters All / Uncategorised / a named folder", () => {
    expect(filterCampaignsByFolder(rows, ALL_FOLDERS).map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      filterCampaignsByFolder(rows, UNCATEGORISED_FOLDER).map((c) => c.id),
    ).toEqual(["b"]);
    expect(filterCampaignsByFolder(rows, "f2").map((c) => c.id)).toEqual([
      "c",
    ]);
  });

  it("keys folders under the campaigns resource so a list invalidation refreshes counts", () => {
    expect(campaignFolderKeys.list("t1", "owner")).toEqual([
      "campaigns",
      "t1",
      "owner",
      "folders",
    ]);
  });
});
