import { describe, expect, it } from "vitest";

import {
  asTimelineFacet,
  emptyFacetMessage,
  facetCounts,
  facetForType,
  filterTimeline,
  TIMELINE_FACETS,
  timelineFilterNote,
} from "./timelineFilter";

const EVENTS = [
  { type: "campaign_sent" },
  { type: "opened" },
  { type: "clicked" },
  { type: "bounced" },
  { type: "unsubscribed" },
  { type: "tag_added" },
  { type: "quantum_teleported" }, // a type this build has never seen
];

describe("facetForType", () => {
  it("classifies both spellings the gateway emits", () => {
    expect(facetForType("campaign_opened")).toBe("engagement");
    expect(facetForType("opened")).toBe("engagement");
    expect(facetForType("campaign_sent")).toBe("sends");
    expect(facetForType("sent")).toBe("sends");
  });

  it("is null — never a facet — for anything unrecognised", () => {
    expect(facetForType("brand_new_type")).toBeNull();
    expect(facetForType(undefined)).toBeNull();
    expect(facetForType(42)).toBeNull();
  });

  it("is case- and whitespace-insensitive", () => {
    expect(facetForType("  BOUNCED ")).toBe("problems");
  });
});

describe("filterTimeline", () => {
  it("passes everything through under All", () => {
    const out = filterTimeline(EVENTS, "all");
    expect(out.rows).toHaveLength(EVENTS.length);
    expect(out.loaded).toBe(EVENTS.length);
  });

  it("narrows to the facet's own types", () => {
    expect(filterTimeline(EVENTS, "problems").rows.map((e) => e.type)).toEqual([
      "bounced",
      "unsubscribed",
    ]);
    expect(filterTimeline(EVENTS, "engagement").rows.map((e) => e.type)).toEqual(
      ["opened", "clicked"],
    );
  });

  it("keeps an unknown type visible under All and counts it", () => {
    const all = filterTimeline(EVENTS, "all");
    expect(all.rows.some((e) => e.type === "quantum_teleported")).toBe(true);
    expect(all.unclassified).toBe(1);
    // …and never smuggles it into a named facet, whose label would lie.
    for (const facet of ["sends", "engagement", "problems", "lifecycle"] as const) {
      expect(
        filterTimeline(EVENTS, facet).rows.some(
          (e) => e.type === "quantum_teleported",
        ),
      ).toBe(false);
    }
  });
});

describe("facetCounts", () => {
  it("counts each facet and totals All", () => {
    const counts = facetCounts(EVENTS);
    expect(counts.all).toBe(7);
    expect(counts.sends).toBe(1);
    expect(counts.engagement).toBe(2);
    expect(counts.problems).toBe(2);
    expect(counts.lifecycle).toBe(1);
  });
});

describe("the disclosure rule", () => {
  it("says nothing when there is nothing to qualify", () => {
    expect(
      timelineFilterNote({
        facet: "all",
        shown: 0,
        loaded: 0,
        unclassified: 0,
        hasMore: false,
      }),
    ).toBeNull();
    expect(
      timelineFilterNote({
        facet: "all",
        shown: 7,
        loaded: 7,
        unclassified: 0,
        hasMore: false,
      }),
    ).toBeNull();
  });

  it("ALWAYS scopes a filtered count to what is loaded", () => {
    const note = timelineFilterNote({
      facet: "problems",
      shown: 2,
      loaded: 7,
      unclassified: 1,
      hasMore: false,
    });
    expect(note).toContain("2 of 7 loaded events");
  });

  it("warns that older pages exist, so an empty facet is not a fact", () => {
    const note = timelineFilterNote({
      facet: "problems",
      shown: 0,
      loaded: 200,
      unclassified: 0,
      hasMore: true,
    });
    expect(note).toContain("load older activity");
  });

  it("discloses unrecognised types instead of dropping them silently", () => {
    const note = timelineFilterNote({
      facet: "sends",
      shown: 1,
      loaded: 7,
      unclassified: 1,
      hasMore: false,
    });
    expect(note).toContain("doesn't recognise");
  });

  it("still warns about unloaded pages under All", () => {
    expect(
      timelineFilterNote({
        facet: "all",
        shown: 7,
        loaded: 7,
        unclassified: 0,
        hasMore: true,
      }),
    ).toContain("not been loaded yet");
  });
});

describe("emptyFacetMessage", () => {
  it("never states a fact about the record while pages remain", () => {
    expect(emptyFacetMessage("problems", true)).toContain("loaded so far");
    expect(emptyFacetMessage("problems", true)).not.toContain("record");
  });

  it("may state the fact once the whole record is loaded", () => {
    expect(emptyFacetMessage("problems", false)).toContain(
      "subscriber's record",
    );
  });
});

describe("asTimelineFacet", () => {
  it("accepts every declared facet and rejects anything else", () => {
    for (const facet of TIMELINE_FACETS) {
      expect(asTimelineFacet(facet.value)).toBe(facet.value);
    }
    expect(asTimelineFacet("nonsense")).toBe("all");
    expect(asTimelineFacet(undefined)).toBe("all");
    expect(asTimelineFacet(3)).toBe("all");
  });
});
