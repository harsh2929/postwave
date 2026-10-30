/**
 * lib/assetOrganize — the pure half of asset organising. Every normaliser here
 * is a MIRROR of a Go source line (folders.go `normalizeFolderName`, tags.go
 * `normalizeTag`), so these tests pin the mirror to the server's documented
 * behaviour, not to whatever the mirror happens to do.
 */
import { describe, expect, it } from "vitest";

import {
  ASSET_FOLDER_NAME_MAX,
  ASSET_TAG_MAX,
  assetFolderById,
  assetFolderNameTaken,
  assetOrganizeErrorMessage,
  normalizeAssetFolderName,
  normalizeAssetTag,
  parseAssetFolder,
  parseAssetTagList,
} from "./assetOrganize";

describe("normalizeAssetFolderName (mirror of folders.go normalizeFolderName)", () => {
  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeAssetFolderName("  Q3   Launch  ")).toBe("Q3 Launch");
    expect(normalizeAssetFolderName("Summer\t\tShoots")).toBe("Summer Shoots");
  });

  it("rejects an over-long name as empty, counting runes not UTF-16 units", () => {
    expect(normalizeAssetFolderName("x".repeat(ASSET_FOLDER_NAME_MAX))).toBe(
      "x".repeat(ASSET_FOLDER_NAME_MAX),
    );
    expect(
      normalizeAssetFolderName("x".repeat(ASSET_FOLDER_NAME_MAX + 1)),
    ).toBe("");
    // 128 astral runes are 256 UTF-16 units — still exactly at the limit.
    expect(normalizeAssetFolderName("😀".repeat(ASSET_FOLDER_NAME_MAX))).toBe(
      "😀".repeat(ASSET_FOLDER_NAME_MAX),
    );
  });

  it("returns empty for whitespace-only input", () => {
    expect(normalizeAssetFolderName("   ")).toBe("");
  });
});

describe("normalizeAssetTag (mirror of tags.go normalizeTag)", () => {
  it("lowercases, maps punctuation to dashes, and strips edge dashes", () => {
    // "Q3 Launch!" → "q3 launch!" → "q3 launch-" → trim "- " → "q3 launch"
    expect(normalizeAssetTag("Q3 Launch!")).toBe("q3 launch");
    expect(normalizeAssetTag("user@example.com")).toBe("user-example-com");
  });

  it("keeps Unicode letters/numbers/marks and - _ space", () => {
    expect(normalizeAssetTag("Été-2026")).toBe("été-2026");
    expect(normalizeAssetTag("北京 2024")).toBe("北京 2024");
    expect(normalizeAssetTag("a_b")).toBe("a_b");
  });

  it("collapses whitespace runs and rejects over-long or all-junk input", () => {
    expect(normalizeAssetTag("summer   hero")).toBe("summer hero");
    expect(normalizeAssetTag("@@@")).toBe("");
    expect(normalizeAssetTag("x".repeat(ASSET_TAG_MAX + 1))).toBe("");
    expect(normalizeAssetTag("x".repeat(ASSET_TAG_MAX))).toBe(
      "x".repeat(ASSET_TAG_MAX),
    );
  });
});

describe("parseAssetFolder (the create/rename answer body)", () => {
  it("reads the bare Folder row the write endpoints answer with", () => {
    expect(
      parseAssetFolder({
        id: "f1",
        name: "Launches",
        createdAt: "2026-08-01T00:00:00Z",
        assetCount: 4,
      }),
    ).toEqual({
      id: "f1",
      name: "Launches",
      createdAt: "2026-08-01T00:00:00Z",
      assetCount: 4,
    });
  });

  it("returns null for a body nothing could be filed into", () => {
    expect(parseAssetFolder({ name: "no id" })).toBeNull();
    expect(parseAssetFolder({ id: "f1", name: "  " })).toBeNull();
    expect(parseAssetFolder(null)).toBeNull();
    expect(parseAssetFolder([{ id: "f1", name: "x" }])).toBeNull();
  });

  it("defaults junk createdAt/assetCount instead of propagating them", () => {
    const folder = parseAssetFolder({ id: "f1", name: "F", assetCount: -2 });
    expect(folder?.createdAt).toBeNull();
    expect(folder?.assetCount).toBe(0);
  });
});

describe("parseAssetTagList", () => {
  it("reads {tags: [string]} and drops non-string rows instead of stringifying", () => {
    expect(parseAssetTagList({ tags: ["hero", 3, "", "summer"] })).toEqual([
      "hero",
      "summer",
    ]);
  });

  it("answers empty for a shape that is not the contract", () => {
    expect(parseAssetTagList(null)).toEqual([]);
    expect(parseAssetTagList({ tags: "hero" })).toEqual([]);
    expect(parseAssetTagList(["hero"])).toEqual([]);
  });
});

describe("assetFolderNameTaken (the 409 said before the tap)", () => {
  const folders = [
    { id: "f1", name: "Newsletters", createdAt: null, assetCount: 1 },
  ];

  it("is exact-string after normalisation, like the server's unique index", () => {
    expect(assetFolderNameTaken(folders, "Newsletters")).toBe(true);
    expect(assetFolderNameTaken(folders, "  Newsletters  ")).toBe(true);
    // Case differs → the server would accept it as a NEW folder.
    expect(assetFolderNameTaken(folders, "newsletters")).toBe(false);
    expect(assetFolderNameTaken(folders, "Launches")).toBe(false);
    expect(assetFolderNameTaken(folders, "   ")).toBe(false);
  });
});

describe("assetFolderById", () => {
  const folders = [
    { id: "f1", name: "Newsletters", createdAt: null, assetCount: 1 },
  ];
  it("resolves an id and treats null as Uncategorised", () => {
    expect(assetFolderById(folders, "f1")?.name).toBe("Newsletters");
    expect(assetFolderById(folders, null)).toBeNull();
    expect(assetFolderById(folders, "gone")).toBeNull();
  });
});

describe("assetOrganizeErrorMessage", () => {
  const err = (over: Record<string, unknown>) =>
    Object.assign(new Error("raw server text"), over);

  it("translates the handlers' own codes", () => {
    expect(assetOrganizeErrorMessage(err({ code: "name_conflict" }), "f")).toBe(
      "A folder with that name already exists.",
    );
    expect(assetOrganizeErrorMessage(err({ code: "invalid_tag" }), "f")).toBe(
      "Tags must be 1 to 64 characters.",
    );
    expect(
      assetOrganizeErrorMessage(err({ code: "folder_not_found" }), "f"),
    ).toMatch(/no longer exists/);
  });

  it("reads a 403 as the permission rule it is, never a generic failure", () => {
    const message = assetOrganizeErrorMessage(err({ status: 403 }), "fallback");
    expect(message).toMatch(/editor role/);
    expect(message).not.toBe("fallback");
  });

  it("falls back to the error's own text, then the caller's fallback", () => {
    expect(assetOrganizeErrorMessage(err({}), "fallback")).toBe(
      "raw server text",
    );
    expect(assetOrganizeErrorMessage({ odd: true }, "fallback")).toBe(
      "fallback",
    );
  });
});
