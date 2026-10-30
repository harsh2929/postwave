import { describe, expect, it } from "vitest";

import {
  classifySearchQuery,
  FILTER_REASON_ALIASES,
  isLikelyEmail,
  needsClientFilter,
  reasonLabel,
  reasonMatchesFilter,
  reasonTone,
  searchQueryParams,
  SERVER_SEARCH_MIN_PREFIX,
  SUPPRESSION_FILTERS,
  suppressionPageScopeNote,
} from "./suppressionSearch";

describe("classifySearchQuery", () => {
  it("treats an empty / whitespace query as none", () => {
    expect(classifySearchQuery("")).toEqual({ mode: "none", value: "" });
    expect(classifySearchQuery("   ")).toEqual({ mode: "none", value: "" });
  });

  it("routes a full email to the exact server filter, lowercased", () => {
    expect(classifySearchQuery("  Ada@Example.COM ")).toEqual({
      mode: "exact",
      value: "ada@example.com",
    });
  });

  it("routes a 3+ char fragment to the prefix server filter", () => {
    expect(classifySearchQuery("ada")).toEqual({ mode: "prefix", value: "ada" });
    expect(SERVER_SEARCH_MIN_PREFIX).toBe(3);
  });

  it("keeps 1-2 char fragments client-side", () => {
    expect(classifySearchQuery("a")).toEqual({ mode: "client", value: "a" });
    expect(classifySearchQuery("ad")).toEqual({ mode: "client", value: "ad" });
    expect(needsClientFilter(classifySearchQuery("ad"))).toBe(true);
    expect(needsClientFilter(classifySearchQuery("ada"))).toBe(false);
  });

  it("builds the right query fragment per mode and percent-encodes", () => {
    expect(searchQueryParams(classifySearchQuery("a+b@example.com"))).toBe(
      "&email=a%2Bb%40example.com",
    );
    expect(searchQueryParams(classifySearchQuery("ada"))).toBe("&q=ada");
    expect(searchQueryParams(classifySearchQuery("ad"))).toBe("");
    expect(searchQueryParams(classifySearchQuery(""))).toBe("");
  });
});

describe("reasonMatchesFilter", () => {
  it("matches spam traps under their own chip — the bug this replaces", () => {
    // The previous mobile matcher tested `r === 'spam'` and `includes('bounce')`,
    // so `spam_trap` matched NOTHING and was only visible under "All".
    expect(reasonMatchesFilter("spam_trap", "spamtrap")).toBe(true);
    expect(reasonMatchesFilter("spamtrap", "spamtrap")).toBe(true);
    expect(reasonMatchesFilter("spam_trap", "complaint")).toBe(false);
    expect(reasonMatchesFilter("spam_trap", "hard_bounce")).toBe(false);
  });

  it("keeps soft bounces out of the hard-bounce bucket", () => {
    expect(reasonMatchesFilter("soft_bounce", "soft_bounce")).toBe(true);
    expect(reasonMatchesFilter("soft_bounce_threshold", "soft_bounce")).toBe(
      true,
    );
    expect(reasonMatchesFilter("soft_bounce", "hard_bounce")).toBe(false);
  });

  it("buckets the address-quality signals under delivery issues", () => {
    for (const reason of FILTER_REASON_ALIASES.delivery_issue) {
      expect(reasonMatchesFilter(reason, "delivery_issue")).toBe(true);
    }
  });

  it("is case-insensitive and tolerates padding, null and undefined", () => {
    expect(reasonMatchesFilter(" HARD_BOUNCE ", "hard_bounce")).toBe(true);
    expect(reasonMatchesFilter(undefined, "hard_bounce")).toBe(false);
    expect(reasonMatchesFilter(undefined, "all")).toBe(true);
    expect(reasonMatchesFilter("", "all")).toBe(true);
  });

  it("assigns every non-all chip a disjoint alias set", () => {
    const seen = new Set<string>();
    for (const aliases of Object.values(FILTER_REASON_ALIASES)) {
      for (const alias of aliases) {
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  it("offers one chip per alias bucket plus All", () => {
    expect(SUPPRESSION_FILTERS).toHaveLength(
      Object.keys(FILTER_REASON_ALIASES).length + 1,
    );
    expect(SUPPRESSION_FILTERS[0]?.key).toBe("all");
  });
});

describe("reasonTone", () => {
  it("colours the act-now reasons danger and the transient ones warning", () => {
    expect(reasonTone("hard_bounce")).toBe("danger");
    expect(reasonTone("spam_complaint")).toBe("danger");
    expect(reasonTone("spam_trap")).toBe("danger");
    expect(reasonTone("soft_bounce")).toBe("warning");
    expect(reasonTone("role_account")).toBe("warning");
    expect(reasonTone("list_manual")).toBe("info");
    expect(reasonTone("global_unsubscribe")).toBe("neutral");
    expect(reasonTone(undefined)).toBe("neutral");
  });
});

describe("reasonLabel", () => {
  it("humanises the stored enum without ever rendering blank", () => {
    expect(reasonLabel("hard_bounce")).toBe("Hard bounce");
    expect(reasonLabel("SPAM_TRAP")).toBe("Spam trap");
    expect(reasonLabel("  ")).toBe("unknown");
    expect(reasonLabel(undefined)).toBe("unknown");
    expect(reasonLabel("__")).toBe("unknown");
  });
});

describe("isLikelyEmail", () => {
  it("accepts real addresses and rejects fragments", () => {
    expect(isLikelyEmail("ada@example.com")).toBe(true);
    expect(isLikelyEmail(" ADA@example.co.uk ")).toBe(true);
    expect(isLikelyEmail("ada@example")).toBe(false);
    expect(isLikelyEmail("ada")).toBe(false);
    expect(isLikelyEmail("")).toBe(false);
  });
});

describe("suppressionPageScopeNote", () => {
  it("says nothing when the loaded rows ARE the whole filtered set", () => {
    expect(
      suppressionPageScopeNote({ shown: 12, total: 12, clientFiltered: false }),
    ).toBe("");
    expect(
      suppressionPageScopeNote({
        shown: 12,
        total: undefined,
        clientFiltered: false,
      }),
    ).toBe("");
  });

  it("discloses the scope of the ordering when rows are unreachable", () => {
    const note = suppressionPageScopeNote({
      shown: 50,
      total: 1200,
      clientFiltered: false,
    });
    expect(note).toContain("Showing 50 of 1,200 suppressed addresses");
    expect(note).toContain("newest first within what's loaded");
  });

  it("points at Load more, not at the search box, while more pages exist", () => {
    // Telling an operator to guess an exact address is wrong advice when a
    // button that fetches the next page is on screen beside the sentence.
    const note = suppressionPageScopeNote({
      shown: 50,
      total: 1200,
      clientFiltered: false,
      canLoadMore: true,
    });
    expect(note).toContain("Load more to reach older records.");
    expect(note).not.toContain("Search by address");
  });

  it("falls back to search once paging has run out", () => {
    const note = suppressionPageScopeNote({
      shown: 1000,
      total: 400_000,
      clientFiltered: false,
      canLoadMore: false,
    });
    expect(note).toContain("Search by address to reach older records.");
  });

  it("still names the reason filter as a client-side narrowing", () => {
    expect(
      suppressionPageScopeNote({
        shown: 3,
        total: 1200,
        clientFiltered: true,
        canLoadMore: true,
      }),
    ).toContain("The reason filter narrows only what's loaded");
  });
});
