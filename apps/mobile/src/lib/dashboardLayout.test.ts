import { describe, expect, it } from "vitest";

import {
  canHideTile,
  MOBILE_TILE_KEYS,
  parseDashboardLayoutOrder,
  parseHiddenTiles,
  resolveTileOrder,
  serialiseHiddenTiles,
  tilePickerLabel,
  toggleHiddenTile,
  visibleTiles,
  type MobileTileKey,
} from "./dashboardLayout";

describe("parseDashboardLayoutOrder", () => {
  it("reads the server envelope", () => {
    expect(
      parseDashboardLayoutOrder({
        userId: "u",
        tenantId: "t",
        order: ["bounces", "subs", "opens", "clicks"],
        updatedAt: "2026-07-01T00:00:00Z",
      }),
    ).toEqual(["bounces", "subs", "opens", "clicks"]);
  });

  it("returns null rather than an empty order when nothing usable is sent", () => {
    // "the server did not tell us" must fall back to the default order, so it
    // cannot be represented by the same value as "show nothing".
    expect(parseDashboardLayoutOrder(null)).toBeNull();
    expect(parseDashboardLayoutOrder({})).toBeNull();
    expect(parseDashboardLayoutOrder({ order: "subs" })).toBeNull();
    expect(parseDashboardLayoutOrder({ order: [] })).toBeNull();
    expect(parseDashboardLayoutOrder({ order: [1, 2] })).toBeNull();
  });

  it("drops blanks, duplicates and over-long keys the server would reject", () => {
    expect(
      parseDashboardLayoutOrder({
        order: ["subs", " ", "subs", "x".repeat(65), " opens "],
      }),
    ).toEqual(["subs", "opens"]);
  });
});

describe("resolveTileOrder", () => {
  it("defaults when nothing is saved", () => {
    expect(resolveTileOrder(null)).toEqual([...MOBILE_TILE_KEYS]);
    expect(resolveTileOrder(undefined)).toEqual([...MOBILE_TILE_KEYS]);
    expect(resolveTileOrder([])).toEqual([...MOBILE_TILE_KEYS]);
  });

  it("honours the desktop's saved order for the four shared tiles", () => {
    expect(resolveTileOrder(["bounces", "clicks", "opens", "subs"])).toEqual([
      "bounce-rate",
      "click-rate",
      "open-rate",
      "subscribers",
      "sent",
      "sequences",
    ]);
  });

  it("skips the desktop's section keys instead of rendering them", () => {
    // The stored row is ONE flat list shared with the desktop's card sections.
    expect(
      resolveTileOrder([
        "opens",
        "subs",
        "clicks",
        "bounces",
        "forecast",
        "anomalies",
        "goals",
        "clv",
      ]),
    ).toEqual([
      "open-rate",
      "subscribers",
      "click-rate",
      "bounce-rate",
      "sent",
      "sequences",
    ]);
  });

  it("appends a tile the saved order never mentions rather than dropping it", () => {
    expect(resolveTileOrder(["bounces"])).toEqual([
      "bounce-rate",
      "subscribers",
      "open-rate",
      "click-rate",
      "sent",
      "sequences",
    ]);
  });

  it("degrades to the default order for a shape it does not recognise", () => {
    // A rehydrated cache written by an older build can hold anything.
    expect(
      resolveTileOrder({} as unknown as readonly string[]),
    ).toEqual([...MOBILE_TILE_KEYS]);
    expect(
      resolveTileOrder("subs" as unknown as readonly string[]),
    ).toEqual([...MOBILE_TILE_KEYS]);
  });

  it("never emits a tile twice", () => {
    const order = resolveTileOrder(["subs", "subs", "opens"]);
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(MOBILE_TILE_KEYS.length);
  });
});

describe("hidden-tile preference", () => {
  it("round-trips through the string preference store", () => {
    const hidden: MobileTileKey[] = ["sequences", "sent"];
    expect(parseHiddenTiles(serialiseHiddenTiles(hidden)).sort()).toEqual([
      "sent",
      "sequences",
    ]);
  });

  it("serialises stably regardless of toggle order", () => {
    expect(serialiseHiddenTiles(["sent", "sequences"])).toBe(
      serialiseHiddenTiles(["sequences", "sent"]),
    );
  });

  it("ignores unknown keys from an older or newer build", () => {
    expect(parseHiddenTiles("sent,replies,,sequences")).toEqual([
      "sent",
      "sequences",
    ]);
  });

  it("discards a stored set that would hide every tile", () => {
    expect(parseHiddenTiles(MOBILE_TILE_KEYS.join(","))).toEqual([]);
  });
});

describe("visibleTiles", () => {
  const order = [...MOBILE_TILE_KEYS];

  it("removes hidden tiles, preserving order", () => {
    expect(visibleTiles(order, ["open-rate", "sequences"])).toEqual([
      "subscribers",
      "click-rate",
      "bounce-rate",
      "sent",
    ]);
  });

  it("refuses to render an empty grid", () => {
    expect(visibleTiles(order, order)).toEqual(order);
  });
});

describe("canHideTile / toggleHiddenTile", () => {
  const order = [...MOBILE_TILE_KEYS];

  it("permits hiding while more than one tile remains", () => {
    expect(canHideTile(order, [], "sent")).toBe(true);
  });

  it("refuses the toggle that would empty the grid", () => {
    const hidden = order.slice(1); // one tile left visible
    expect(canHideTile(order, hidden, order[0] as MobileTileKey)).toBe(false);
    expect(toggleHiddenTile(order, hidden, order[0] as MobileTileKey)).toEqual(
      hidden,
    );
  });

  it("always allows unhiding", () => {
    const hidden = order.slice(1);
    expect(canHideTile(order, hidden, "open-rate")).toBe(true);
    expect(toggleHiddenTile(order, hidden, "open-rate")).not.toContain(
      "open-rate",
    );
  });

  it("toggles on and back off", () => {
    const once = toggleHiddenTile(order, [], "sent");
    expect(once).toEqual(["sent"]);
    expect(toggleHiddenTile(order, once, "sent")).toEqual([]);
  });
});

describe("tilePickerLabel", () => {
  it("says how many are hidden so a truncated grid never looks broken", () => {
    expect(tilePickerLabel(0)).toBe("Choose metrics");
    expect(tilePickerLabel(2)).toBe("Choose metrics · 2 hidden");
  });
});
