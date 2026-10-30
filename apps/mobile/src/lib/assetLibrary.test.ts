/**
 * The list envelope is three-part and only one part is the rows. These tests
 * pin the two places that separation matters: `counts` describing the whole
 * tenant set rather than the page, and every "we were not told" case reporting
 * null instead of a confident zero.
 */
import { describe, expect, it } from "vitest";

import {
  ASSET_FILTERS,
  absoluteAssetUrl,
  assetDimensions,
  assetUsagePhrase,
  parseAsset,
  parseAssetDetail,
  parseAssetFolders,
  parseAssetPage,
  parseAssetTags,
} from "./assetLibrary";

const ROW = {
  id: "0f1e2d3c-4b5a-4968-8778-66554433221a",
  tenantId: "t-1",
  filename: "hero.png",
  mime: "image/png",
  bytes: 204_800,
  width: 1280,
  height: 720,
  url: "https://cdn.example.test/assets/hero.png",
  createdAt: "2026-07-01T09:00:00Z",
  altText: "Hero banner",
  referencesCount: 2,
  folderId: null,
};

describe("parseAsset", () => {
  it("reads a full row", () => {
    const asset = parseAsset(ROW)!;
    expect(asset.id).toBe(ROW.id);
    expect(asset.filename).toBe("hero.png");
    expect(asset.bytes).toBe(204_800);
    expect(asset.referencesCount).toBe(2);
    expect(asset.altText).toBe("Hero banner");
  });

  it("drops a row with no id rather than rendering a tile that cannot open", () => {
    expect(parseAsset({ ...ROW, id: "" })).toBeNull();
    expect(parseAsset(null)).toBeNull();
    expect(parseAsset([ROW])).toBeNull();
  });

  it("reports an ABSENT measurement as null, never as zero", () => {
    // `bytes` / `width` / `height` / `referencesCount` carry no `omitempty`
    // (repo.go:42), so absence means the payload is not what we think it is.
    const asset = parseAsset({ id: ROW.id })!;
    expect(asset.bytes).toBeNull();
    expect(asset.width).toBeNull();
    expect(asset.height).toBeNull();
    expect(asset.referencesCount).toBeNull();
  });

  it("reports a stored zero dimension as unknown, not as a zero-pixel image", () => {
    const asset = parseAsset({ ...ROW, width: 0, height: 0 })!;
    expect(asset.width).toBeNull();
    expect(asset.height).toBeNull();
  });

  it("keeps a genuine zero reference count, which is a real answer", () => {
    expect(parseAsset({ ...ROW, referencesCount: 0 })!.referencesCount).toBe(0);
  });

  it("reads an absent lastUsedAt as never-used", () => {
    // `omitempty` on a *time.Time: absence is the fact, not a gap.
    expect(parseAsset(ROW)!.lastUsedAt).toBeNull();
    expect(
      parseAsset({ ...ROW, lastUsedAt: "2026-07-20T00:00:00Z" })!.lastUsedAt,
    ).toBe("2026-07-20T00:00:00Z");
  });
});

describe("parseAssetPage", () => {
  it("reads items, counts and the cursor as three separate facts", () => {
    const page = parseAssetPage({
      items: [ROW],
      counts: { all: 42, recent: 9, inUse: 4, unused: 12, large: 3 },
      nextCursor: "0f1e2d3c-4b5a-4968-8778-66554433221b",
    });
    expect(page.items).toHaveLength(1);
    // 42 is the tenant total; the page holds one row. Deriving either from the
    // other is the bug this asserts against.
    expect(page.counts?.all).toBe(42);
    expect(page.nextCursor).toBe("0f1e2d3c-4b5a-4968-8778-66554433221b");
  });

  it("reads a null cursor as the last page", () => {
    expect(parseAssetPage({ items: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it("refuses to synthesise a partial counts object", () => {
    // Three of five numbers would render two confident zeros beside filters
    // that were never measured.
    expect(parseAssetPage({ items: [], counts: { all: 5, recent: 1 } }).counts).toBeNull();
    expect(parseAssetPage({ items: [] }).counts).toBeNull();
  });

  it("survives a payload that is not the envelope at all", () => {
    const page = parseAssetPage("nope");
    expect(page.items).toEqual([]);
    expect(page.counts).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("skips unusable rows without discarding the page", () => {
    const page = parseAssetPage({ items: [ROW, { id: "" }, null] });
    expect(page.items).toHaveLength(1);
  });
});

describe("parseAssetFolders / parseAssetTags", () => {
  it("reads the folder envelope with its counts", () => {
    const folders = parseAssetFolders({
      folders: [
        { id: "f-1", name: "Brand", createdAt: "2026-01-01T00:00:00Z", assetCount: 7 },
      ],
    });
    expect(folders).toEqual([
      { id: "f-1", name: "Brand", createdAt: "2026-01-01T00:00:00Z", assetCount: 7 },
    ]);
  });

  it("drops a nameless folder — a chip with no label is unpressable", () => {
    expect(parseAssetFolders({ folders: [{ id: "f-1", name: "  " }] })).toEqual([]);
  });

  it("reads the tag envelope", () => {
    expect(parseAssetTags({ tags: [{ tag: "hero", count: 3 }] })).toEqual([
      { tag: "hero", count: 3 },
    ]);
    expect(parseAssetTags({})).toEqual([]);
  });
});

describe("parseAssetDetail", () => {
  it("reads the asset and its freshly recomputed referrers", () => {
    const detail = parseAssetDetail({
      asset: ROW,
      usage: [
        { kind: "campaign", id: "c-1", name: "July newsletter" },
        { kind: "form", id: "fm-2", name: "Signup" },
      ],
    });
    expect(detail.asset?.id).toBe(ROW.id);
    expect(detail.usage).toHaveLength(2);
    expect(detail.usage[0]?.name).toBe("July newsletter");
  });

  it("reads an empty usage array as genuinely unreferenced", () => {
    expect(parseAssetDetail({ asset: ROW, usage: [] }).usage).toEqual([]);
  });

  it("does not invent an asset from a broken envelope", () => {
    expect(parseAssetDetail({}).asset).toBeNull();
  });
});

describe("absoluteAssetUrl", () => {
  it("passes an absolute CDN url straight through", () => {
    expect(
      absoluteAssetUrl("https://cdn.example.test/a/b.png", "https://api.test"),
    ).toBe("https://cdn.example.test/a/b.png");
  });

  it("resolves the filesystem backend's relative blob path", () => {
    // FSStorage.Put returns "/api/v1/assets/{id}/blob" (storage.go:116).
    expect(
      absoluteAssetUrl("/api/v1/assets/abc/blob", "https://api.test/"),
    ).toBe("https://api.test/api/v1/assets/abc/blob");
  });

  it("returns null rather than a half-formed link", () => {
    expect(absoluteAssetUrl("/api/v1/assets/abc/blob", null)).toBeNull();
    expect(absoluteAssetUrl("", "https://api.test")).toBeNull();
    expect(absoluteAssetUrl("assets/abc", "https://api.test")).toBeNull();
    expect(absoluteAssetUrl("/x", "not-a-url")).toBeNull();
  });
});

describe("derivations", () => {
  it("renders dimensions only when both were established", () => {
    expect(assetDimensions(parseAsset(ROW)!)).toBe("1280 × 720");
    expect(assetDimensions(parseAsset({ ...ROW, width: 0 })!)).toBeNull();
  });

  it("keeps 'we do not know' distinct from 'nothing uses it'", () => {
    expect(assetUsagePhrase(null)).toBe("Usage unknown");
    expect(assetUsagePhrase(0)).toBe("Not used by anything live");
    expect(assetUsagePhrase(1)).toBe("Used by 1 live item");
    expect(assetUsagePhrase(4)).toBe("Used by 4 live items");
  });

  it("offers exactly the filters the server's allowlist accepts", () => {
    // handlers.go:289 400s anything else before touching the database.
    expect(ASSET_FILTERS.map((f) => f.value)).toEqual([
      "all",
      "recent",
      "in-use",
      "unused",
      "large",
    ]);
  });
});

describe("the sort vocabulary", () => {
  it("is exactly the server allowlist (invalid_sort names these five)", async () => {
    const { ASSET_SORTS, DEFAULT_ASSET_SORT } = await import("./assetLibrary");
    expect(ASSET_SORTS.map((s) => s.value)).toEqual([
      "newest",
      "oldest",
      "largest",
      "name",
      "most-used",
    ]);
    expect(DEFAULT_ASSET_SORT).toBe("newest");
  });
});

describe("altTextBlockReason", () => {
  it("allows anything at or under 1024 RUNES, including empty (clearing)", async () => {
    const { altTextBlockReason } = await import("./assetLibrary");
    expect(altTextBlockReason("")).toBeNull();
    expect(altTextBlockReason("a".repeat(1024))).toBeNull();
  });

  it("refuses past the bound with the count in the sentence", async () => {
    const { altTextBlockReason } = await import("./assetLibrary");
    expect(altTextBlockReason("a".repeat(1025))).toMatch(/1025/);
  });

  it("counts runes the way utf8.RuneCountInString does, not UTF-16 units", async () => {
    const { altTextBlockReason } = await import("./assetLibrary");
    // 1024 emoji are 2048 UTF-16 units but exactly 1024 runes — the server
    // accepts this string, so the client must too.
    expect(altTextBlockReason("🚀".repeat(1024))).toBeNull();
    expect(altTextBlockReason("🚀".repeat(1025))).toMatch(/1025/);
  });
});
