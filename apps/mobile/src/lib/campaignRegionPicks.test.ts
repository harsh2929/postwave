/**
 * Region branch substitution — including the trap the module exists for:
 * Region.Start/End are Go UTF-8 BYTE offsets, JS slices count UTF-16 units,
 * and one 'é' before a region shifts every offset.
 */
import { describe, expect, it } from "vitest";

import { applyRegionPicks, pickableRegions } from "./campaignRegionPicks";

describe("pickableRegions", () => {
  it("keeps only top-level rows with usable offsets, deduped by key", () => {
    const regions = pickableRegions({
      regions: [
        { key: "is_vip", start: 3, end: 10, true_branch: "VIP", has_else: true, false_branch: "not" },
        { key: "is_vip", start: 3, end: 10 },
        { key: "", start: 0, end: 5 },
        { key: "bad", start: 9, end: 4 },
        { key: "no_offsets" },
      ],
    });
    expect(regions.map((r) => r.key)).toEqual(["is_vip"]);
    expect(regions[0]!.hasElse).toBe(true);
  });
  it("empty for junk", () => {
    expect(pickableRegions(null)).toEqual([]);
    expect(pickableRegions({ regions: "x" })).toEqual([]);
  });
});

describe("applyRegionPicks", () => {
  // "café " is 5 chars / 6 BYTES — the region's byte offsets start at 6.
  const body = "café [IF]either[/IF] end";
  const byteStart = 6; // after "café " in UTF-8
  const byteEnd = byteStart + "[IF]either[/IF]".length;
  const region = {
    key: "cond",
    start: byteStart,
    end: byteEnd,
    trueBranch: "yes",
    falseBranch: "no",
    hasElse: true,
  };

  it("resolves the TRUE branch through the byte→UTF-16 map", () => {
    expect(applyRegionPicks(body, [region], { cond: "true" })).toBe(
      "café yes end",
    );
  });

  it("resolves the FALSE branch when the region has an else", () => {
    expect(applyRegionPicks(body, [region], { cond: "false" })).toBe(
      "café no end",
    );
  });

  it("false with NO else collapses to nothing — that recipient gets nothing there", () => {
    expect(
      applyRegionPicks(body, [{ ...region, hasElse: false }], {
        cond: "false",
      }),
    ).toBe("café  end");
  });

  it("default leaves the raw markup in place", () => {
    expect(applyRegionPicks(body, [region], {})).toBe(body);
    expect(applyRegionPicks(body, [region], { cond: "default" })).toBe(body);
  });

  it("substitutes multiple regions right-to-left so offsets stay valid", () => {
    const two = "aa[A]x[/A]bb[B]y[/B]cc";
    const rA = {
      key: "A",
      start: 2,
      end: 10,
      trueBranch: "1",
      falseBranch: "",
      hasElse: false,
    };
    const rB = {
      key: "B",
      start: 12,
      end: 20,
      trueBranch: "2",
      falseBranch: "",
      hasElse: false,
    };
    expect(applyRegionPicks(two, [rA, rB], { A: "true", B: "true" })).toBe(
      "aa1bb2cc",
    );
  });
});
