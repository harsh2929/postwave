import { describe, expect, it } from "vitest";

import {
  ALL_FOLDERS,
  UNCATEGORISED_FOLDER,
  campaignFolderCaveat,
  campaignFolderNameConflict,
  campaignFolderOptions,
  currentFolderId,
  matchesCampaignFolder,
  normalizeCampaignFolderName,
  parseCampaignFolder,
  parseCampaignFolders,
} from "./campaignFolders";

describe("parseCampaignFolders", () => {
  it("reads the { items } envelope the handler writes", () => {
    const folders = parseCampaignFolders({
      items: [{ id: "f1", name: "Newsletters", campaign_count: 12 }],
    });
    expect(folders).toEqual([
      { id: "f1", name: "Newsletters", campaignCount: 12 },
    ]);
  });

  it("drops rows that could only render as a blank chip", () => {
    expect(
      parseCampaignFolders({ items: [{ id: "", name: "x" }, { id: "y" }] }),
    ).toEqual([]);
  });

  it("tolerates a bare array and a missing count", () => {
    expect(parseCampaignFolders([{ id: "f", name: "F" }])).toEqual([
      { id: "f", name: "F", campaignCount: 0 },
    ]);
  });
});

describe("matchesCampaignFolder", () => {
  /**
   * The server projects COALESCE(folder_id::text, ''), so uncategorised is
   * the EMPTY STRING on the wire — a null check would bucket nothing.
   */
  it("treats the empty string as uncategorised", () => {
    expect(matchesCampaignFolder({ folder_id: "" }, UNCATEGORISED_FOLDER)).toBe(
      true,
    );
    expect(matchesCampaignFolder({}, UNCATEGORISED_FOLDER)).toBe(true);
    expect(
      matchesCampaignFolder({ folder_id: "f1" }, UNCATEGORISED_FOLDER),
    ).toBe(false);
  });

  it("matches an explicit folder and passes everything under All", () => {
    expect(matchesCampaignFolder({ folder_id: "f1" }, "f1")).toBe(true);
    expect(matchesCampaignFolder({ folder_id: "f2" }, "f1")).toBe(false);
    expect(matchesCampaignFolder({ folder_id: "f2" }, ALL_FOLDERS)).toBe(true);
  });
});

describe("campaignFolderOptions", () => {
  it("puts All first and Uncategorised last", () => {
    const options = campaignFolderOptions(
      [{ id: "f1", name: "News", campaignCount: 3 }],
      ALL_FOLDERS,
    );
    expect(options.map((o) => o.value)).toEqual([
      ALL_FOLDERS,
      "f1",
      UNCATEGORISED_FOLDER,
    ]);
    expect(options[1]?.label).toBe("News 3");
  });

  /** A control that vanishes mid-use strands the operator inside a filter. */
  it("keeps a filter that is no longer in the workspace list reachable", () => {
    const options = campaignFolderOptions([], "gone");
    expect(options.some((o) => o.value === "gone")).toBe(true);
  });
});

describe("campaignFolderCaveat", () => {
  it("is silent under All and when every page is loaded", () => {
    expect(campaignFolderCaveat(ALL_FOLDERS, true, 100)).toBeNull();
    expect(campaignFolderCaveat("f1", false, 100)).toBeNull();
  });

  it("states the client-side limit when pages remain", () => {
    const caveat = campaignFolderCaveat("f1", true, 100);
    expect(caveat).toContain("100");
    expect(caveat).toContain("client");
  });
});

describe("currentFolderId", () => {
  it("maps the empty string back to null", () => {
    expect(currentFolderId({ folder_id: "" })).toBeNull();
    expect(currentFolderId({ folder_id: "f1" })).toBe("f1");
  });
});

describe("parseCampaignFolder (the create's 201 body)", () => {
  it("reads the bare Folder row POST /campaigns/folders answers with", () => {
    expect(
      parseCampaignFolder({ id: "f9", name: "Launches", campaign_count: 2 }),
    ).toEqual({ id: "f9", name: "Launches", campaignCount: 2 });
  });

  it("returns null for a body the UI could not file anything into", () => {
    expect(parseCampaignFolder({ name: "no id" })).toBeNull();
    expect(parseCampaignFolder({ id: "f9", name: "  " })).toBeNull();
    expect(parseCampaignFolder(null)).toBeNull();
    expect(parseCampaignFolder([{ id: "f9", name: "x" }])).toBeNull();
  });

  it("defaults a missing or junk count to zero", () => {
    expect(parseCampaignFolder({ id: "f", name: "F" })?.campaignCount).toBe(0);
    expect(
      parseCampaignFolder({ id: "f", name: "F", campaign_count: -3 })
        ?.campaignCount,
    ).toBe(0);
  });
});

describe("normalizeCampaignFolderName", () => {
  /**
   * The server's ONLY normalisation is strings.TrimSpace (folders.go). The
   * mirror must not promise more: no case-fold, no inner-whitespace collapse.
   */
  it("trims and nothing else", () => {
    expect(normalizeCampaignFolderName("  Q3  Launch  ")).toBe("Q3  Launch");
    expect(normalizeCampaignFolderName("Newsletters")).toBe("Newsletters");
    expect(normalizeCampaignFolderName("   ")).toBe("");
  });
});

describe("campaignFolderNameConflict", () => {
  const folders = [{ id: "f1", name: "Newsletters", campaignCount: 3 }];

  it("names an exact match — the server will reuse, not duplicate", () => {
    expect(campaignFolderNameConflict(folders, "Newsletters")).toBe("exact");
    expect(campaignFolderNameConflict(folders, "  Newsletters ")).toBe("exact");
  });

  it("names a case-only match — the quiet taxonomy split", () => {
    expect(campaignFolderNameConflict(folders, "newsletters")).toBe("case");
    expect(campaignFolderNameConflict(folders, "NEWSLETTERS")).toBe("case");
  });

  it("is silent for a fresh name and for emptiness", () => {
    expect(campaignFolderNameConflict(folders, "Launches")).toBeNull();
    expect(campaignFolderNameConflict(folders, "   ")).toBeNull();
    expect(campaignFolderNameConflict([], "Newsletters")).toBeNull();
  });
});
