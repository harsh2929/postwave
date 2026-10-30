/**
 * The discovery layer's data rules. The two facts most worth pinning:
 * shelfQuery ALWAYS sends a lifecycle value (the server's empty default mixes
 * archived rows into the browse shelf), and the compare toggle refuses past
 * the server's 4-identifier cap BEFORE the request.
 */
import { describe, expect, it } from "vitest";

import {
  parseRecentTemplateViews,
  parseTemplateCompare,
  parseTemplateSavedSearches,
  parseTemplateStats,
  savedSearchAutoName,
  shelfQuery,
  sortQueryValue,
  TEMPLATE_COMPARE_MAX,
  TEMPLATE_SHELVES,
  toggleCompareId,
} from "./templateDiscovery";

describe("shelfQuery", () => {
  it("always names a lifecycle — the server's empty default means BOTH", () => {
    for (const shelf of TEMPLATE_SHELVES) {
      const axes = shelfQuery(shelf);
      expect(axes.archived === "active" || axes.archived === "archived").toBe(
        true,
      );
    }
  });

  it("maps each shelf to the axes desktop sends", () => {
    expect(shelfQuery("all")).toEqual({
      source: null,
      favorited: false,
      archived: "active",
    });
    expect(shelfQuery("gallery").source).toBe("platform");
    expect(shelfQuery("team").source).toBe("team");
    expect(shelfQuery("mine").source).toBe("mine");
    expect(shelfQuery("favorites")).toEqual({
      source: null,
      favorited: true,
      archived: "active",
    });
    expect(shelfQuery("archived").archived).toBe("archived");
  });
});

describe("sortQueryValue", () => {
  it("omits the default and passes the other two through", () => {
    expect(sortQueryValue("recommended")).toBeNull();
    expect(sortQueryValue("name")).toBe("name");
    expect(sortQueryValue("most_used")).toBe("most_used");
  });
});

describe("parseTemplateStats", () => {
  it("reads the extras.go rollup", () => {
    expect(
      parseTemplateStats({
        total: 42,
        mine: 7,
        favorites: 3,
        used_last_30d: 11,
        top_template_name: "Spring launch",
        top_usage_count: 9,
      }),
    ).toEqual({
      total: 42,
      mine: 7,
      favorites: 3,
      usedLast30d: 11,
      topTemplateName: "Spring launch",
      topUsageCount: 9,
    });
  });

  it("answers null — tiles absent, not zeroed — for a non-rollup body", () => {
    expect(parseTemplateStats(null)).toBeNull();
    expect(parseTemplateStats({ items: [] })).toBeNull();
  });
});

const TEMPLATE_ROW = {
  id: "tpl-1",
  slug: "spring",
  name: "Spring launch",
  subject: "s",
  variables: [],
  tags: [],
  template_kind: "editable",
  review_status: "approved",
  source_license_status: "owned",
};

describe("parseRecentTemplateViews", () => {
  it("reads {items:[{template,view_count,last_viewed_at}]}", () => {
    const rows = parseRecentTemplateViews({
      items: [
        {
          template: TEMPLATE_ROW,
          view_count: 4,
          last_viewed_at: "2026-08-01T10:00:00Z",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.template.id).toBe("tpl-1");
    expect(rows[0]!.viewCount).toBe(4);
  });

  it("drops a row whose template cannot be parsed", () => {
    expect(
      parseRecentTemplateViews({ items: [{ view_count: 2 }] }),
    ).toEqual([]);
  });
});

describe("parseTemplateSavedSearches", () => {
  it("flags definitions carrying axes this phone has no control for", () => {
    const rows = parseTemplateSavedSearches({
      items: [
        {
          id: "s1",
          name: "Spring promos",
          etag: '"v1"',
          filters: { q: "spring", goal: "promotional" },
        },
        {
          id: "s2",
          name: "Berlin style",
          etag: '"v2"',
          filters: { q: "x", style: "bold" },
        },
      ],
    });
    expect(rows.map((row) => row.hasExtraFilters)).toEqual([false, true]);
  });
});

describe("parseTemplateCompare", () => {
  it("keeps unresolved identifiers as a said fact, never dropped", () => {
    const result = parseTemplateCompare({
      items: [{ requested_identifier: "tpl-1", template: TEMPLATE_ROW }],
      unavailable_identifiers: ["ghost"],
    });
    expect(result.items.map((t) => t.id)).toEqual(["tpl-1"]);
    expect(result.unavailable).toEqual(["ghost"]);
  });
});

describe("toggleCompareId", () => {
  it("adds, then removes, the same id", () => {
    const added = toggleCompareId([], "a");
    expect(added.ids).toEqual(["a"]);
    expect(toggleCompareId(added.ids, "a").ids).toEqual([]);
  });

  it("refuses the fifth selection with a stated reason", () => {
    const four = ["a", "b", "c", "d"];
    const refused = toggleCompareId(four, "e");
    expect(refused.ids).toEqual(four);
    expect(refused.blockReason).toContain(String(TEMPLATE_COMPARE_MAX));
  });
});

describe("savedSearchAutoName", () => {
  it("derives the name from what the search is", () => {
    expect(
      savedSearchAutoName({
        query: "spring",
        goal: null,
        shelf: "favorites",
        sort: "most_used",
      }),
    ).toBe("“spring” · Favorites · Most used");
  });

  it("falls back to a whole-library name when nothing is narrowed", () => {
    expect(
      savedSearchAutoName({
        query: "",
        goal: null,
        shelf: "all",
        sort: "recommended",
      }),
    ).toBe("All designs");
  });
});
