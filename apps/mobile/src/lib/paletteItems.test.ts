import { describe, expect, it } from "vitest";

import {
  buildPaletteItems,
  filterPaletteItems,
  rankFuzzy,
  scorePaletteItem,
  type PaletteItem,
} from "./paletteItems";

const ITEM = (over: Partial<PaletteItem> & { id: string }): PaletteItem => ({
  kind: "navigation",
  title: over.title ?? over.id,
  icon: "settings",
  ...over,
});

describe("rankFuzzy", () => {
  it("scores a prefix best", () => {
    expect(rankFuzzy("camp", "Campaigns")).toBeLessThan(100);
  });

  it("scores a word start above a mid-string substring", () => {
    const wordStart = rankFuzzy("set", "Sending settings");
    const substring = rankFuzzy("ampaig", "Campaigns");
    expect(wordStart).toBeGreaterThanOrEqual(100);
    expect(wordStart).toBeLessThan(300);
    expect(substring).toBeGreaterThanOrEqual(300);
  });

  it("matches a loose subsequence last", () => {
    expect(rankFuzzy("cmp", "Campaigns")).toBeGreaterThanOrEqual(1000);
  });

  it("returns -1 when no subsequence exists", () => {
    expect(rankFuzzy("zzz", "Campaigns")).toBe(-1);
  });

  it("treats an empty query as a neutral match", () => {
    expect(rankFuzzy("", "anything")).toBe(0);
  });

  it("is case insensitive in both directions", () => {
    expect(rankFuzzy("CAMP", "campaigns")).toBe(rankFuzzy("camp", "CAMPAIGNS"));
  });
});

describe("scorePaletteItem", () => {
  it("prefers a title match over the same match in subtitle or keywords", () => {
    const byTitle = scorePaletteItem(
      ITEM({ id: "a", title: "Suppressions" }),
      "supp",
    );
    const bySubtitle = scorePaletteItem(
      ITEM({ id: "b", title: "zzz", subtitle: "Suppressions" }),
      "supp",
    );
    const byKeyword = scorePaletteItem(
      ITEM({ id: "c", title: "zzz", keywords: "Suppressions" }),
      "supp",
    );
    expect(byTitle).toBeLessThan(bySubtitle);
    expect(bySubtitle).toBeLessThan(byKeyword);
  });

  it("still matches on a keyword the row never renders", () => {
    const item = ITEM({ id: "a", title: "Suppressions", keywords: "blocklist" });
    expect(scorePaletteItem(item, "blocklist")).toBeLessThan(
      Number.POSITIVE_INFINITY,
    );
  });

  it("returns Infinity when nothing matches", () => {
    expect(scorePaletteItem(ITEM({ id: "a", title: "Lists" }), "qqq")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("buildPaletteItems", () => {
  it("includes the five primary tabs for every role", () => {
    const items = buildPaletteItems({ role: "viewer", mode: "session" });
    const ids = items.map((i) => i.id);
    for (const key of [
      "dashboard",
      "subscribers",
      "campaigns",
      "approvals",
      "more",
    ]) {
      expect(ids).toContain(`nav:${key}`);
    }
  });

  it("hides admin-only destinations from a viewer", () => {
    const viewer = buildPaletteItems({ role: "viewer", mode: "session" });
    const admin = buildPaletteItems({ role: "admin", mode: "session" });
    expect(viewer.map((i) => i.id)).not.toContain("nav:scim");
    expect(admin.map((i) => i.id)).toContain("nav:scim");
  });

  it("hides every role-gated route in api-key mode", () => {
    const items = buildPaletteItems({ role: "owner", mode: "api_key" });
    expect(items.map((i) => i.id)).not.toContain("nav:agency");
  });

  it("always offers the local actions", () => {
    const ids = buildPaletteItems({ role: "viewer", mode: "session" }).map(
      (i) => i.id,
    );
    expect(ids).toContain("action:sign-out");
    expect(ids).toContain("action:theme-dark");
  });
});

describe("filterPaletteItems", () => {
  const items = [
    ITEM({ id: "nav:campaigns", title: "Campaigns" }),
    ITEM({ id: "nav:lists", title: "Lists" }),
    ITEM({ id: "action:sign-out", kind: "action", title: "Sign out" }),
  ];

  it("shows recents first when the query is empty", () => {
    const out = filterPaletteItems(items, "", { recentIds: ["nav:lists"] });
    expect(out[0]?.id).toBe("nav:lists");
    // Recents are not repeated further down the list.
    expect(out.filter((i) => i.id === "nav:lists")).toHaveLength(1);
  });

  it("omits actions from the empty-query list", () => {
    const out = filterPaletteItems(items, "");
    expect(out.map((i) => i.id)).not.toContain("action:sign-out");
  });

  it("surfaces an action once it is typed", () => {
    const out = filterPaletteItems(items, "sign");
    expect(out[0]?.id).toBe("action:sign-out");
  });

  it("ignores a recent id that is no longer in the catalogue", () => {
    const out = filterPaletteItems(items, "", { recentIds: ["nav:deleted"] });
    expect(out.map((i) => i.id)).not.toContain("nav:deleted");
  });

  it("breaks a score tie in favour of the recent item", () => {
    const tied = [
      ITEM({ id: "nav:a", title: "Report" }),
      ITEM({ id: "nav:b", title: "Report" }),
    ];
    expect(filterPaletteItems(tied, "rep")[0]?.id).toBe("nav:a");
    expect(
      filterPaletteItems(tied, "rep", { recentIds: ["nav:b"] })[0]?.id,
    ).toBe("nav:b");
  });

  it("honours the limit", () => {
    expect(filterPaletteItems(items, "", { limit: 1 })).toHaveLength(1);
  });

  it("drops non-matching items entirely", () => {
    expect(filterPaletteItems(items, "zzzz")).toEqual([]);
  });
});
