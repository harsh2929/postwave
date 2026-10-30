// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  filterLandingPages,
  landingMetrics,
  nextSort,
  sortLandingPages,
  statusLabel,
  type LandingSortKey,
} from "@/lib/landing-list-helpers";
import type { LandingPage } from "@/lib/landing-pages-api";

function page(over: Partial<LandingPage>): LandingPage {
  return {
    id: over.id ?? "1",
    tenant_id: "t",
    slug: over.slug ?? "slug",
    name: over.name ?? "Page",
    status: over.status ?? "draft",
    domain: over.domain,
    template: over.template ?? "signup",
    blocks: over.blocks ?? [],
    seo: over.seo ?? {},
    tracking: over.tracking ?? {},
    metrics: over.metrics ?? {},
    created_at: over.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: over.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

describe("filterLandingPages", () => {
  const pages = [
    page({ id: "a", name: "Welcome", slug: "welcome", status: "published" }),
    page({ id: "b", name: "Waitlist", slug: "wait", status: "draft" }),
    page({ id: "c", name: "Old promo", slug: "old", status: "archived" }),
  ];

  it("filters by name or slug (case-insensitive)", () => {
    expect(filterLandingPages(pages, { q: "welc" }).map((p) => p.id)).toEqual([
      "a",
    ]);
    expect(filterLandingPages(pages, { q: "WAIT" }).map((p) => p.id)).toEqual([
      "b",
    ]);
  });

  it("filters by status", () => {
    expect(
      filterLandingPages(pages, { status: "archived" }).map((p) => p.id),
    ).toEqual(["c"]);
    expect(filterLandingPages(pages, { status: "all" })).toHaveLength(3);
  });

  it("combines status + query", () => {
    expect(
      filterLandingPages(pages, { status: "published", q: "welcome" }).map(
        (p) => p.id,
      ),
    ).toEqual(["a"]);
    expect(
      filterLandingPages(pages, { status: "draft", q: "welcome" }),
    ).toHaveLength(0);
  });
});

describe("landingMetrics", () => {
  it("returns null counts when metrics are absent (honest empty)", () => {
    const m = landingMetrics(page({}));
    expect(m.views).toBeNull();
    expect(m.conversions).toBeNull();
    expect(m.conversionRate).toBeNull();
  });

  it("computes conversion rate from views + conversions", () => {
    const m = landingMetrics(page({ metrics: { views: 200, conversions: 50 } }));
    expect(m.views).toBe(200);
    expect(m.conversions).toBe(50);
    expect(m.conversionRate).toBe(25);
  });

  it("yields 0% for zero views (no divide-by-zero)", () => {
    const m = landingMetrics(page({ metrics: { views: 0, conversions: 0 } }));
    expect(m.conversionRate).toBe(0);
  });

  it("accepts aliases and an explicit fractional rate", () => {
    const m = landingMetrics(
      page({ metrics: { visits: 10, signups: 3, conversion_rate: 0.3 } }),
    );
    expect(m.views).toBe(10);
    expect(m.conversions).toBe(3);
    // explicit fractional rate wins and is expressed as a percentage
    expect(m.conversionRate).toBe(30);
  });
});

describe("sortLandingPages", () => {
  const pages = [
    page({ id: "a", name: "Beta", updated_at: "2026-01-02T00:00:00Z", metrics: { views: 5 } }),
    page({ id: "b", name: "Alpha", updated_at: "2026-01-03T00:00:00Z", metrics: { views: 50 } }),
    page({ id: "c", name: "Gamma", updated_at: "2026-01-01T00:00:00Z", metrics: { views: 1 } }),
  ];

  it("sorts by name ascending", () => {
    expect(sortLandingPages(pages, "name", "asc").map((p) => p.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts by views descending", () => {
    expect(sortLandingPages(pages, "views", "desc").map((p) => p.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts by updatedAt descending (recency)", () => {
    expect(
      sortLandingPages(pages, "updatedAt", "desc").map((p) => p.id),
    ).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input", () => {
    const copy = [...pages];
    sortLandingPages(pages, "name", "asc");
    expect(pages).toEqual(copy);
  });
});

describe("nextSort", () => {
  it("flips direction when re-selecting the active column", () => {
    expect(nextSort({ sort: "name", order: "asc" }, "name")).toEqual({
      sort: "name",
      order: "desc",
    });
  });

  it("uses descending default for numeric/recency columns", () => {
    for (const key of ["views", "conversions", "conversionRate", "updatedAt"] as LandingSortKey[]) {
      expect(nextSort({ sort: "name", order: "asc" }, key).order).toBe("desc");
    }
  });

  it("uses ascending default for text columns", () => {
    expect(nextSort({ sort: "views", order: "desc" }, "name").order).toBe("asc");
  });
});

describe("statusLabel", () => {
  it("humanizes machine statuses", () => {
    expect(statusLabel("published")).toBe("Published");
    expect(statusLabel("draft")).toBe("Draft");
    expect(statusLabel("archived")).toBe("Archived");
  });
});
