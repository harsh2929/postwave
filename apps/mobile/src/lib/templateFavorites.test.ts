import { describe, expect, it } from "vitest";

import { patchTemplateFavorite } from "./templateFavorites";

describe("patchTemplateFavorite", () => {
  const page = {
    pages: [
      { items: [{ id: "a", isFavorited: false }, { id: "b", isFavorited: true }] },
    ],
  };

  it("flips only the targeted row", () => {
    const next = patchTemplateFavorite(page, "a", true) as typeof page;
    expect(next.pages[0]?.items[0]?.isFavorited).toBe(true);
    expect(next.pages[0]?.items[1]?.isFavorited).toBe(true);
  });

  it("does not mutate the cached object in place", () => {
    patchTemplateFavorite(page, "a", true);
    expect(page.pages[0]?.items[0]?.isFavorited).toBe(false);
  });

  /**
   * A future envelope change must degrade to "no optimistic update", never to
   * a wiped cache — the star simply waits for the refetch.
   */
  it("returns anything that is not the expected envelope unchanged", () => {
    expect(patchTemplateFavorite(null, "a", true)).toBeNull();
    expect(patchTemplateFavorite({ items: [] }, "a", true)).toEqual({
      items: [],
    });
    const odd = { pages: [{ rows: [] }] };
    expect(patchTemplateFavorite(odd, "a", true)).toEqual(odd);
  });
});
