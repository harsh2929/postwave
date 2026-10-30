import { describe, expect, it } from "vitest";

import {
  CATALOG_PAGE_SIZE,
  catalogAvailabilityLine,
  catalogCategoryOptions,
  catalogEntryConnectable,
  catalogResultSentence,
  catalogSearchTerm,
  catalogStatusLabel,
  catalogStatusTone,
  catalogTierLabel,
  catalogTierOptions,
  filterCatalogEntries,
  normalizeIntegrationsCatalog,
  type CatalogEntry,
} from "./integrationsCatalog";

const payload = {
  schema_version: "2026-06.integrations.v1",
  target_public_entries: 350,
  target_native_managed: 70,
  honest_badges: ["native", "partner", "zapier", "planned"],
  categories: [
    { key: "ecommerce", label: "Ecommerce" },
    { key: "crm", label: "CRM" },
    { key: "shipping", label: "Shipping" },
  ],
  items: [
    {
      slug: "shopify",
      name: "Shopify",
      category: "ecommerce",
      badge: "native",
      runtime_status: "available",
      summary: "Managed Shopify commerce foundation.",
      capabilities: ["commerce", "orders"],
      sources: ["commerce"],
      setup_path: "/commerce",
      native: true,
      phase: "1",
    },
    {
      slug: "zendesk",
      name: "Zendesk",
      category: "customer_service",
      badge: "planned",
      runtime_status: "planned",
      summary: "Release-held support-provider catalog entry.",
      capabilities: [],
      sources: ["support_integration"],
      native: false,
    },
    {
      slug: "pipedrive",
      name: "Pipedrive",
      category: "crm",
      badge: "native",
      runtime_status: "partial",
      summary: "Managed Pipedrive CRM foundation.",
      capabilities: ["profiles"],
      sources: ["crm"],
      native: true,
    },
    {
      slug: "some-bridge",
      name: "Some Bridge",
      category: "ecommerce",
      badge: "zapier",
      runtime_status: "delegated",
      summary: "Bridge route.",
      capabilities: ["events"],
      sources: ["bridge"],
      native: false,
    },
    // Junk rows the normalizer must drop.
    { slug: "", name: "No slug" },
    { slug: "shopify", name: "Duplicate Shopify" },
    { name: "Nameless" },
  ],
  counts: {
    total: 614,
    "runtime:available": 41,
    "badge:native": 186,
  },
};

const catalog = normalizeIntegrationsCatalog(payload);

function entry(over: Partial<CatalogEntry>): CatalogEntry {
  return {
    slug: "x",
    name: "X",
    category: "crm",
    badge: "native",
    runtimeStatus: "available",
    summary: "",
    capabilities: [],
    sources: [],
    setupPath: "",
    phase: "",
    native: true,
    ...over,
  };
}

describe("normalizeIntegrationsCatalog", () => {
  it("keeps only rows with a slug and a name, deduplicated", () => {
    expect(catalog.entries.map((e) => e.slug)).toEqual([
      "shopify",
      "zendesk",
      "pipedrive",
      "some-bridge",
    ]);
  });

  it("carries the server's two axes verbatim", () => {
    const shopify = catalog.entries[0]!;
    expect(shopify.badge).toBe("native");
    expect(shopify.runtimeStatus).toBe("available");
    expect(shopify.capabilities).toEqual(["commerce", "orders"]);
    expect(shopify.setupPath).toBe("/commerce");
  });

  it("carries the server's badge and category vocabulary and counts", () => {
    expect(catalog.badges).toEqual(["native", "partner", "zapier", "planned"]);
    expect(catalog.categories).toContainEqual({
      key: "ecommerce",
      label: "Ecommerce",
    });
    expect(catalog.counts.total).toBe(614);
  });

  it("survives a junk payload without throwing", () => {
    expect(normalizeIntegrationsCatalog(null).entries).toEqual([]);
    expect(normalizeIntegrationsCatalog({ items: "nope" }).entries).toEqual([]);
    expect(normalizeIntegrationsCatalog({ counts: [] }).counts).toEqual({});
    expect(
      normalizeIntegrationsCatalog({ counts: { total: "614" } }).counts.total,
    ).toBeUndefined();
  });
});

describe("catalogEntryConnectable", () => {
  it("is true for available only", () => {
    expect(catalogEntryConnectable(entry({ runtimeStatus: "available" }))).toBe(
      true,
    );
  });

  it("is false for every other status the server can send", () => {
    for (const status of ["partial", "delegated", "planned", "", "weird"]) {
      expect(
        catalogEntryConnectable(entry({ runtimeStatus: status })),
      ).toBe(false);
    }
  });
});

describe("labels", () => {
  it("maps the server vocabulary to reader words", () => {
    expect(catalogTierLabel("api_sdk")).toBe("API & SDK");
    expect(catalogTierLabel("migration_only")).toBe("Migration only");
    expect(catalogStatusLabel("delegated")).toBe("Delegated");
  });

  it("renders an unknown token verbatim rather than inventing one", () => {
    expect(catalogTierLabel("brand_new_tier")).toBe("brand_new_tier");
    expect(catalogStatusLabel("brand_new_status")).toBe("brand_new_status");
    expect(catalogTierLabel("")).toBe("Unclassified");
    expect(catalogStatusLabel("")).toBe("Unknown");
  });

  it("only paints available green", () => {
    expect(catalogStatusTone("available")).toBe("success");
    expect(catalogStatusTone("partial")).toBe("warning");
    expect(catalogStatusTone("delegated")).toBe("info");
    expect(catalogStatusTone("planned")).toBe("neutral");
  });
});

describe("filterCatalogEntries", () => {
  const all = { search: "", category: "", tier: "" };

  it("returns everything with no filters", () => {
    expect(filterCatalogEntries(catalog.entries, all)).toHaveLength(4);
  });

  it("matches on name case-insensitively", () => {
    expect(
      filterCatalogEntries(catalog.entries, { ...all, search: "SHOPI" }).map(
        (e) => e.slug,
      ),
    ).toEqual(["shopify"]);
  });

  it("matches the server's other fields: category, badge, status, capability, source", () => {
    const bySearch = (q: string) =>
      filterCatalogEntries(catalog.entries, { ...all, search: q }).map(
        (e) => e.slug,
      );
    expect(bySearch("crm")).toEqual(["pipedrive"]);
    expect(bySearch("zapier")).toEqual(["some-bridge"]);
    expect(bySearch("delegated")).toEqual(["some-bridge"]);
    expect(bySearch("orders")).toEqual(["shopify"]);
    expect(bySearch("support_integration")).toEqual(["zendesk"]);
  });

  it("intersects category and tier with the search", () => {
    expect(
      filterCatalogEntries(catalog.entries, {
        ...all,
        category: "ecommerce",
      }).map((e) => e.slug),
    ).toEqual(["shopify", "some-bridge"]);
    expect(
      filterCatalogEntries(catalog.entries, { ...all, tier: "native" }).map(
        (e) => e.slug,
      ),
    ).toEqual(["shopify", "pipedrive"]);
    expect(
      filterCatalogEntries(catalog.entries, {
        search: "bridge",
        category: "ecommerce",
        tier: "native",
      }),
    ).toEqual([]);
  });

  it("bounds the search term", () => {
    const long = "a".repeat(300);
    expect(catalogSearchTerm(long)).toHaveLength(256);
    expect(catalogSearchTerm("  Shopify  ")).toBe("shopify");
  });
});

describe("filter options", () => {
  it("offers only categories that actually have entries, in server order", () => {
    expect(catalogCategoryOptions(catalog)).toEqual([
      { value: "ecommerce", label: "Ecommerce", count: 2 },
      { value: "crm", label: "CRM", count: 1 },
    ]);
  });

  it("offers tiers from honest_badges plus any badge only a row carries", () => {
    expect(catalogTierOptions(catalog)).toEqual([
      { value: "native", label: "Native", count: 2 },
      { value: "zapier", label: "Zapier", count: 1 },
      { value: "planned", label: "Planned", count: 1 },
    ]);
  });

  it("still offers a badge the server left out of honest_badges", () => {
    const odd = normalizeIntegrationsCatalog({
      honest_badges: ["native"],
      items: [
        { slug: "a", name: "A", badge: "native" },
        { slug: "b", name: "B", badge: "webhook" },
      ],
    });
    expect(catalogTierOptions(odd).map((o) => o.value)).toEqual([
      "native",
      "webhook",
    ]);
  });
});

describe("catalogAvailabilityLine", () => {
  it("uses the server's counts, never the rows we received", () => {
    // 614 and 41 are the SERVER's numbers; only 4 rows are in `entries`.
    expect(catalogAvailabilityLine(catalog)).toContain("41 of 614");
  });

  it("says nothing at all when the server did not report the counts", () => {
    expect(
      catalogAvailabilityLine({ ...catalog, counts: { total: 614 } }),
    ).toBeNull();
    expect(
      catalogAvailabilityLine({ ...catalog, counts: {} }),
    ).toBeNull();
  });
});

describe("catalogResultSentence", () => {
  it("counts plainly when nothing is filtered", () => {
    expect(catalogResultSentence(614, 614, false)).toBe("614 catalog entries.");
  });

  it("says how much of the whole is showing when filtered", () => {
    expect(catalogResultSentence(614, 3, true)).toBe(
      "3 of 614 entries match the active filters.",
    );
  });
});

describe("paging", () => {
  it("caps the first render well below the catalog size", () => {
    expect(CATALOG_PAGE_SIZE).toBeLessThanOrEqual(50);
    const many = Array.from({ length: 614 }, (_, i) =>
      entry({ slug: `s${i}`, name: `N${i}` }),
    );
    expect(many.slice(0, CATALOG_PAGE_SIZE)).toHaveLength(CATALOG_PAGE_SIZE);
  });
});
