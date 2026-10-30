import { describe, expect, it } from "vitest";

import {
  MAX_FAVORITE_ROUTES,
  MAX_RECENT_ROUTES,
  navPreferencesKey,
  parseNavPreferences,
  visibleFavorites,
  visibleRecents,
  withFavorite,
  withVisit,
} from "@/lib/navPreferences";

const all = () => true;

describe("parseNavPreferences", () => {
  it("survives junk written by an older build", () => {
    expect(parseNavPreferences(null)).toEqual({ favorites: [], recents: [] });
    expect(parseNavPreferences("not json")).toEqual({
      favorites: [],
      recents: [],
    });
    expect(parseNavPreferences("[1,2,3]")).toEqual({
      favorites: [],
      recents: [],
    });
    expect(
      parseNavPreferences(
        JSON.stringify({ favorites: [1, null, "tags", "tags", " "], recents: "x" }),
      ),
    ).toEqual({ favorites: ["tags"], recents: [] });
  });

  it("bounds both lists", () => {
    const many = Array.from({ length: 40 }, (_, i) => `r${i}`);
    const parsed = parseNavPreferences(
      JSON.stringify({ favorites: many, recents: many }),
    );
    expect(parsed.favorites).toHaveLength(MAX_FAVORITE_ROUTES);
    expect(parsed.recents).toHaveLength(MAX_RECENT_ROUTES);
  });
});

describe("withFavorite", () => {
  it("pins to the END so the user's own order survives", () => {
    expect(withFavorite(["a"], "b")).toEqual(["a", "b"]);
  });

  it("toggles off", () => {
    expect(withFavorite(["a", "b"], "a")).toEqual(["b"]);
  });

  it("ignores empty keys and respects the cap", () => {
    expect(withFavorite(["a"], "  ")).toEqual(["a"]);
    const full = Array.from({ length: MAX_FAVORITE_ROUTES }, (_, i) => `f${i}`);
    expect(withFavorite(full, "new")).toHaveLength(MAX_FAVORITE_ROUTES);
  });
});

describe("withVisit", () => {
  it("is most-recent-first, de-duplicated and bounded", () => {
    let recents = withVisit([], "a");
    recents = withVisit(recents, "b");
    recents = withVisit(recents, "a");
    expect(recents).toEqual(["a", "b"]);
    for (const key of ["c", "d", "e", "f"]) recents = withVisit(recents, key);
    expect(recents).toHaveLength(MAX_RECENT_ROUTES);
    expect(recents[0]).toBe("f");
  });
});

describe("visible lists", () => {
  const prefs = { favorites: ["tags", "gone"], recents: ["tags", "audit", "dead"] };

  it("never shows a pinned destination twice", () => {
    expect(visibleRecents(prefs, all)).toEqual(["audit", "dead"]);
  });

  it("drops keys the live manifest no longer knows", () => {
    const known = (k: string) => k !== "gone" && k !== "dead";
    expect(visibleFavorites(prefs, known)).toEqual(["tags"]);
    expect(visibleRecents(prefs, known)).toEqual(["audit"]);
  });
});

describe("navPreferencesKey", () => {
  it("refuses to build a key from an incomplete identity", () => {
    // The cross-account bleed guard: no shared fallback key, ever.
    expect(
      navPreferencesKey({ baseUrl: null, tenantId: "t", principalId: "u" }),
    ).toBeNull();
    expect(
      navPreferencesKey({ baseUrl: "https://a", tenantId: "", principalId: "u" }),
    ).toBeNull();
    expect(
      navPreferencesKey({
        baseUrl: "https://a/",
        tenantId: "t",
        principalId: "u",
      }),
    ).toBe("postwave.listprefs.v1:https://a:t:u:more-nav");
  });
});
