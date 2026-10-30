import { describe, expect, it } from "vitest";

import {
  type AssetLike,
  fmtBytes,
  fmtDims,
  fmtRelDate,
  isLikelyImage,
  sortAssets,
} from "../../lib/library-filters";

function mk(p: Partial<AssetLike> = {}): AssetLike {
  return {
    id: "x",
    filename: "f.png",
    bytes: 1000,
    createdAt: "2026-05-01T00:00:00Z",
    referencesCount: 0,
    ...p,
  };
}

describe("fmtBytes", () => {
  it("0 → 0 B", () => expect(fmtBytes(0)).toBe("0 B"));
  it("1023 → 1023 B", () => expect(fmtBytes(1023)).toBe("1023 B"));
  it("1024 → 1.0 KB", () => expect(fmtBytes(1024)).toBe("1.0 KB"));
  it("1500000 → 1.43 MB", () => expect(fmtBytes(1500000)).toBe("1.43 MB"));
  it("null → em-dash", () => expect(fmtBytes(null)).toBe("—"));
  it("undefined → em-dash", () => expect(fmtBytes(undefined)).toBe("—"));
  it("negative → em-dash", () => expect(fmtBytes(-1)).toBe("—"));
});

describe("fmtDims", () => {
  it("present", () => expect(fmtDims(1600, 900)).toBe("1600×900"));
  it("missing", () => expect(fmtDims(undefined, 900)).toBe("—"));
});

describe("isLikelyImage", () => {
  it("image/png ok", () => expect(isLikelyImage("image/png")).toBe(true));
  it("text/plain not ok", () =>
    expect(isLikelyImage("text/plain")).toBe(false));
  it("empty not ok", () => expect(isLikelyImage("")).toBe(false));
  it("null not ok", () => expect(isLikelyImage(null)).toBe(false));
});

describe("sortAssets", () => {
  const a = mk({
    id: "a",
    filename: "apple.png",
    bytes: 1000,
    createdAt: "2026-05-01T00:00:00Z",
    referencesCount: 5,
  });
  const b = mk({
    id: "b",
    filename: "banana.png",
    bytes: 5000,
    createdAt: "2026-05-02T00:00:00Z",
    referencesCount: 0,
  });
  const c = mk({
    id: "c",
    filename: "cherry.png",
    bytes: 100,
    createdAt: "2026-04-30T00:00:00Z",
    referencesCount: 12,
  });

  it("newest first", () =>
    expect(sortAssets([a, b, c], "newest").map((x) => x.id)).toEqual([
      "b",
      "a",
      "c",
    ]));
  it("oldest first", () =>
    expect(sortAssets([a, b, c], "oldest").map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]));
  it("largest first", () =>
    expect(sortAssets([a, b, c], "largest").map((x) => x.id)).toEqual([
      "b",
      "a",
      "c",
    ]));
  it("name asc", () =>
    expect(sortAssets([c, b, a], "name").map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
    ]));
  it("most-used desc", () =>
    expect(sortAssets([a, b, c], "most-used").map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]));
  it("does not mutate input", () => {
    const input = [a, b, c];
    sortAssets(input, "name");
    expect(input.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("fmtRelDate", () => {
  it("null → em-dash", () => expect(fmtRelDate(null)).toBe("—"));
  it("invalid → em-dash", () =>
    expect(fmtRelDate("not-a-date")).toBe("—"));
  it("now → today", () =>
    expect(fmtRelDate(new Date().toISOString())).toBe("today"));
  it("36 hours ago → yesterday", () => {
    const t = Date.now() - 36 * 3_600_000;
    expect(fmtRelDate(new Date(t).toISOString())).toBe("yesterday");
  });
  it("3 days ago → '3 days ago'", () => {
    const t = Date.now() - 3 * 86_400_000;
    expect(fmtRelDate(new Date(t).toISOString())).toBe("3 days ago");
  });
});
