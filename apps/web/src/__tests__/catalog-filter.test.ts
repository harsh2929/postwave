import { describe, expect, it } from "vitest";

import {
  CATALOG_PAGE_SIZE,
  capabilityFacets,
  categoryFacets,
  filterCatalog,
  filterSortCatalog,
  isCatalogFiltered,
  providerMonogram,
  sortCatalog,
  type CatalogFilterState,
} from "@/lib/catalog-filter";
import type { CatalogItem } from "@/lib/integrations-catalog-api";

function item(partial: Partial<CatalogItem> & { slug: string }): CatalogItem {
  return {
    slug: partial.slug,
    name: partial.name ?? partial.slug,
    category: partial.category ?? "crm",
    badge: partial.badge ?? "native",
    runtime_status: partial.runtime_status ?? "available",
    summary: partial.summary ?? "",
    capabilities: partial.capabilities ?? [],
    docs_url: partial.docs_url,
    setup_path: partial.setup_path,
    native: partial.native ?? true,
    featured: partial.featured,
    phase: partial.phase,
    sources: partial.sources,
  };
}

const BASE: CatalogFilterState = {
  search: "",
  category: null,
  status: "all",
  capability: null,
  nativeOnly: false,
  connectedOnly: false,
  sort: "featured",
};

const CATALOG: CatalogItem[] = [
  item({ slug: "salesforce", name: "Salesforce", category: "crm", native: true, runtime_status: "available", capabilities: ["profiles", "events"], summary: "Sync leads" }),
  item({ slug: "slack", name: "Slack", category: "customer_service", native: false, runtime_status: "delegated", capabilities: ["events"], summary: "Chat ops" }),
  item({ slug: "typeform", name: "Typeform", category: "forms", native: false, runtime_status: "planned", capabilities: ["profiles"], summary: "Form intake" }),
  item({ slug: "shopify", name: "Shopify", category: "commerce", native: true, runtime_status: "partial", capabilities: ["profiles", "events", "lists", "segments"], summary: "Store sync" }),
];

describe("filterCatalog", () => {
  it("filters by native-only", () => {
    const out = filterCatalog(CATALOG, { ...BASE, nativeOnly: true });
    expect(out.map((i) => i.slug).sort()).toEqual(["salesforce", "shopify"]);
  });

  it("filters delegated and planned statuses (INTG-008)", () => {
    expect(filterCatalog(CATALOG, { ...BASE, status: "delegated" }).map((i) => i.slug)).toEqual(["slack"]);
    expect(filterCatalog(CATALOG, { ...BASE, status: "planned" }).map((i) => i.slug)).toEqual(["typeform"]);
  });

  it("filters by capability (INTG-032)", () => {
    expect(filterCatalog(CATALOG, { ...BASE, capability: "segments" }).map((i) => i.slug)).toEqual(["shopify"]);
    expect(filterCatalog(CATALOG, { ...BASE, capability: "events" }).map((i) => i.slug).sort()).toEqual(["salesforce", "shopify", "slack"]);
  });

  it("searches name, slug, and summary case-insensitively", () => {
    expect(filterCatalog(CATALOG, { ...BASE, search: "STORE" }).map((i) => i.slug)).toEqual(["shopify"]);
    expect(filterCatalog(CATALOG, { ...BASE, search: "sales" }).map((i) => i.slug)).toEqual(["salesforce"]);
  });

  it("combines facets (AND semantics)", () => {
    const out = filterCatalog(CATALOG, { ...BASE, nativeOnly: true, capability: "events" });
    expect(out.map((i) => i.slug).sort()).toEqual(["salesforce", "shopify"]);
  });

  it("filters to connected only against the supplied slug set (INTG-029)", () => {
    expect(
      filterCatalog(
        CATALOG,
        { ...BASE, connectedOnly: true },
        new Set(["salesforce"]),
      ).map((i) => i.slug),
    ).toEqual(["salesforce"]);
  });

  it("connectedOnly with no set yields nothing (INTG-029)", () => {
    expect(
      filterCatalog(CATALOG, { ...BASE, connectedOnly: true }).length,
    ).toBe(0);
  });
});

describe("sortCatalog", () => {
  it("sorts by name", () => {
    expect(sortCatalog(CATALOG, "name").map((i) => i.name)).toEqual([
      "Salesforce",
      "Shopify",
      "Slack",
      "Typeform",
    ]);
  });

  it("sorts native-first", () => {
    const out = sortCatalog(CATALOG, "native").map((i) => i.native);
    expect(out).toEqual([true, true, false, false]);
  });

  it("sorts by status rank (available → planned)", () => {
    expect(sortCatalog(CATALOG, "status").map((i) => i.runtime_status)).toEqual([
      "available",
      "partial",
      "delegated",
      "planned",
    ]);
  });

  it("keeps featured items first and is stable otherwise (INTG-030)", () => {
    const featured = [
      item({ slug: "a", name: "A", featured: false }),
      item({ slug: "b", name: "B", featured: true }),
      item({ slug: "c", name: "C", featured: false }),
    ];
    expect(sortCatalog(featured, "featured").map((i) => i.slug)).toEqual(["b", "a", "c"]);
  });
});

describe("capabilityFacets", () => {
  it("counts capabilities and sorts by frequency then name", () => {
    const facets = capabilityFacets(CATALOG);
    expect(facets[0]).toEqual({ key: "events", count: 3 });
    expect(facets.find((f) => f.key === "segments")).toEqual({ key: "segments", count: 1 });
  });
});

describe("categoryFacets", () => {
  it("counts categories with humanized labels", () => {
    const facets = categoryFacets(CATALOG, (k) => k.toUpperCase());
    expect(facets.every((f) => f.count === 1)).toBe(true);
    expect(facets.map((f) => f.label)).toContain("CRM");
  });
});

describe("isCatalogFiltered", () => {
  it("is false at defaults and true when any facet is active", () => {
    expect(isCatalogFiltered(BASE)).toBe(false);
    expect(isCatalogFiltered({ ...BASE, search: "x" })).toBe(true);
    expect(isCatalogFiltered({ ...BASE, status: "partial" })).toBe(true);
    expect(isCatalogFiltered({ ...BASE, nativeOnly: true })).toBe(true);
    expect(isCatalogFiltered({ ...BASE, connectedOnly: true })).toBe(true);
  });
});

describe("filterSortCatalog", () => {
  it("filters then sorts", () => {
    const out = filterSortCatalog(CATALOG, { ...BASE, capability: "events", sort: "name" });
    expect(out.map((i) => i.name)).toEqual(["Salesforce", "Shopify", "Slack"]);
  });
});

describe("providerMonogram", () => {
  it("derives a stable 1–2 letter monogram", () => {
    expect(providerMonogram("Salesforce")).toBe("SA");
    expect(providerMonogram("Google Ads")).toBe("GA");
    expect(providerMonogram("HubSpot CRM")).toBe("HC");
    expect(providerMonogram("")).toBe("?");
  });
});

describe("CATALOG_PAGE_SIZE", () => {
  it("is a sane bounded page size", () => {
    expect(CATALOG_PAGE_SIZE).toBeGreaterThanOrEqual(24);
    expect(CATALOG_PAGE_SIZE).toBeLessThanOrEqual(100);
  });
});
