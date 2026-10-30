import { describe, expect, it } from "vitest";

import { MAX_TEXT_SCALE } from "./textScale";
import {
  DENSE_ROLES,
  MAX_ROLE_SCALE,
  MULTILINE_FONT_SCALE,
  PROSE_LADDER,
  TAB_BAR_BASE_HEIGHT,
  TYPE,
  fontSizeFor,
  maxLinesAtScale,
  tabBarHeightFor,
  typeCap,
  typeStyle,
  type TypeRole,
} from "./typeScale";

const ALL_ROLES = Object.keys(TYPE) as TypeRole[];

describe("typeScale — coverage", () => {
  it("assigns every role to exactly one family", () => {
    expect([...PROSE_LADDER, ...DENSE_ROLES].sort()).toEqual(
      [...ALL_ROLES].sort(),
    );
    expect(
      PROSE_LADDER.filter((role) => DENSE_ROLES.includes(role)),
    ).toHaveLength(0);
    for (const role of PROSE_LADDER) expect(TYPE[role].density).toBe("prose");
    for (const role of DENSE_ROLES) expect(TYPE[role].density).toBe("dense");
  });

  it("names the roles the app actually needs", () => {
    for (const role of [
      "display",
      "title",
      "body",
      "label",
      "caption",
      "numeric",
      "mono",
      "figure",
    ] as const) {
      expect(ALL_ROLES).toContain(role);
    }
  });
});

describe("typeScale — no role scales unbounded", () => {
  it.each(ALL_ROLES)("%s has a finite ceiling above 1x", (role) => {
    const cap = TYPE[role].maxFontSizeMultiplier;
    expect(Number.isFinite(cap)).toBe(true);
    // A ceiling of 1 would mean "ignore the user's text-size setting", which is
    // the opposite failure from having no ceiling at all.
    expect(cap).toBeGreaterThan(1);
    expect(cap).toBeLessThanOrEqual(MAX_ROLE_SCALE);
  });
});

describe("typeScale — ceilings are monotonic", () => {
  it("loosens the ceiling as the prose step gets smaller", () => {
    for (let i = 1; i < PROSE_LADDER.length; i += 1) {
      const bigger = TYPE[PROSE_LADDER[i - 1]!];
      const smaller = TYPE[PROSE_LADDER[i]!];
      // Sizes strictly decrease down the ladder…
      expect(smaller.fontSize).toBeLessThan(bigger.fontSize);
      // …while the ceiling never tightens. Big type is what breaks layout, so
      // big type is what gets constrained.
      expect(smaller.maxFontSizeMultiplier).toBeGreaterThanOrEqual(
        bigger.maxFontSizeMultiplier,
      );
    }
  });

  it("keeps body copy looser than chrome and figures", () => {
    expect(TYPE.body.maxFontSizeMultiplier).toBeGreaterThan(
      TYPE.display.maxFontSizeMultiplier,
    );
    expect(TYPE.body.maxFontSizeMultiplier).toBeGreaterThan(
      TYPE.figure.maxFontSizeMultiplier,
    );
  });

  it("never lets a dense role outgrow the tightest prose role", () => {
    const tightestProse = Math.min(
      ...PROSE_LADDER.map((role) => TYPE[role].maxFontSizeMultiplier),
    );
    for (const role of DENSE_ROLES) {
      expect(TYPE[role].maxFontSizeMultiplier).toBeLessThanOrEqual(
        tightestProse,
      );
      // …and stays inside the app-wide dense ceiling the older call sites use,
      // so the two modules cannot drift apart.
      expect(TYPE[role].maxFontSizeMultiplier).toBeLessThanOrEqual(
        MAX_TEXT_SCALE,
      );
    }
  });

  it("gives the stat-tile figure the tightest ceiling of all", () => {
    for (const role of ALL_ROLES) {
      if (role === "figure") continue;
      expect(TYPE.figure.maxFontSizeMultiplier).toBeLessThanOrEqual(
        TYPE[role].maxFontSizeMultiplier,
      );
    }
  });
});

describe("typeScale — leading", () => {
  it.each(ALL_ROLES)("%s has a line height at or above its font size", (role) => {
    expect(TYPE[role].lineHeight).toBeGreaterThanOrEqual(TYPE[role].fontSize);
  });

  it.each(ALL_ROLES)("%s keeps leading in a legible ratio", (role) => {
    const ratio = TYPE[role].lineHeight / TYPE[role].fontSize;
    expect(ratio).toBeGreaterThanOrEqual(1.1);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it.each(ALL_ROLES)("%s uses whole-pixel metrics", (role) => {
    // Half-pixel type (the app had 12.5 and 13.5) renders differently per
    // density bucket and is the tell-tale of a size nobody chose.
    expect(Number.isInteger(TYPE[role].fontSize)).toBe(true);
    expect(Number.isInteger(TYPE[role].lineHeight)).toBe(true);
  });
});

describe("typeScale — helpers", () => {
  it("splits metrics from the ceiling so neither lands in the wrong slot", () => {
    expect(typeStyle("body")).toEqual({ fontSize: 15, lineHeight: 21 });
    expect(typeStyle("body")).not.toHaveProperty("maxFontSizeMultiplier");
    expect(typeCap("body")).toEqual({ maxFontSizeMultiplier: 1.8 });
    expect(typeCap("body")).not.toHaveProperty("fontSize");
    expect(fontSizeFor("figure")).toBe(30);
  });

  it("returns frozen, shared objects rather than fresh ones per render", () => {
    expect(typeStyle("body")).toBe(typeStyle("body"));
    expect(Object.isFrozen(typeStyle("body"))).toBe(true);
    expect(Object.isFrozen(typeCap("body"))).toBe(true);
  });
});

describe("tabBarHeightFor", () => {
  it("matches the historical literal at the default text size", () => {
    expect(tabBarHeightFor(1)).toBe(TAB_BAR_BASE_HEIGHT);
    expect(tabBarHeightFor(undefined)).toBe(TAB_BAR_BASE_HEIGHT);
    expect(tabBarHeightFor(Number.NaN)).toBe(TAB_BAR_BASE_HEIGHT);
    // Below 1 (some Android launchers) the bar must not SHRINK — the icon and
    // the touch target still need their 60pt.
    expect(tabBarHeightFor(0.85)).toBe(TAB_BAR_BASE_HEIGHT);
  });

  it("grows the bar with the label, monotonically", () => {
    const heights = [1, 1.1, 1.2, 1.3, 2, 3].map(tabBarHeightFor);
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!).toBeGreaterThanOrEqual(heights[i - 1]!);
    }
    expect(tabBarHeightFor(1.2)).toBeGreaterThan(TAB_BAR_BASE_HEIGHT);
  });

  it("stops growing at the tabLabel ceiling", () => {
    const capped = tabBarHeightFor(TYPE.tabLabel.maxFontSizeMultiplier);
    expect(tabBarHeightFor(3)).toBe(capped);
    expect(tabBarHeightFor(10)).toBe(capped);
    // The whole point: a bounded bar. Unbounded, a 3x label would add ~26pt.
    expect(capped - TAB_BAR_BASE_HEIGHT).toBeLessThanOrEqual(6);
  });
});

describe("maxLinesAtScale", () => {
  it("keeps the base line count at ordinary text sizes", () => {
    expect(maxLinesAtScale(1, 1)).toBe(1);
    expect(maxLinesAtScale(1, MULTILINE_FONT_SCALE - 0.01)).toBe(1);
    expect(maxLinesAtScale(2, 1.1)).toBe(2);
  });

  it("grants one extra line at and above the threshold", () => {
    expect(maxLinesAtScale(1, MULTILINE_FONT_SCALE)).toBe(2);
    expect(maxLinesAtScale(1, 3)).toBe(2);
    expect(maxLinesAtScale(2, 2)).toBe(3);
  });

  it("treats an absent or bogus fontScale as the default size", () => {
    expect(maxLinesAtScale(1, undefined)).toBe(1);
    expect(maxLinesAtScale(1, Number.NaN)).toBe(1);
    expect(maxLinesAtScale(1, Number.POSITIVE_INFINITY)).toBe(1);
    expect(maxLinesAtScale(1, "2")).toBe(1);
  });

  it("never returns fewer than one line", () => {
    expect(maxLinesAtScale(0, 1)).toBe(1);
    expect(maxLinesAtScale(-3, 1)).toBe(1);
  });
});
