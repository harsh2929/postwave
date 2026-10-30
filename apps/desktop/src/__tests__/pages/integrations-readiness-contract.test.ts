import { describe, expect, it } from "vitest";

import {
  parseIntegrationsCatalog,
  parseIntegrationsReadiness,
} from "../../pages/integrations-readiness-contract";

const catalog = {
  schema_version: "1",
  target_public_entries: 1,
  target_native_managed: 1,
  honest_badges: ["native"],
  categories: [{ key: "ecommerce", label: "Ecommerce" }],
  capabilities: ["profiles"],
  items: [
    {
      slug: "shop",
      name: "Shop",
      category: "ecommerce",
      badge: "native",
      runtime_status: "available",
      summary: "A verified test connector.",
      capabilities: ["profiles"],
      native: true,
      sources: ["commerce"],
    },
  ],
  counts: { total: 1 },
};

describe("integrations catalog runtime contract", () => {
  it("accepts complete catalog rows", () => {
    expect(parseIntegrationsCatalog(catalog)).toEqual(catalog);
  });

  it("rejects rows that would crash string/category helpers", () => {
    expect(
      parseIntegrationsCatalog({ items: [{ name: "Partial" }] }),
    ).toBeNull();
    expect(
      parseIntegrationsCatalog({
        ...catalog,
        items: [{ ...catalog.items[0], category: undefined }],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsCatalog({
        ...catalog,
        items: [{ ...catalog.items[0], capabilities: "sync" }],
      }),
    ).toBeNull();
  });

  it("rejects oversized catalogs and duplicate catalog identities", () => {
    expect(
      parseIntegrationsCatalog({
        ...catalog,
        categories: [...catalog.categories, catalog.categories[0]],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsCatalog({
        ...catalog,
        items: [...catalog.items, catalog.items[0]],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsCatalog({
        ...catalog,
        items: Array.from({ length: 2_001 }, (_, index) => ({
          ...catalog.items[0],
          slug: `shop-${index}`,
        })),
      }),
    ).toBeNull();
    expect(
      parseIntegrationsCatalog({
        ...catalog,
        items: [
          {
            ...catalog.items[0],
            summary: "x".repeat(16_385),
          },
        ],
      }),
    ).toBeNull();
  });
});

const readiness = {
  schema_version: "1",
  ready: false,
  marketable_public_claim: false,
  public_claim: "Review readiness blockers before publishing a claim.",
  public_entries: 80,
  target_public_entries: 80,
  native_managed: 55,
  target_native_managed: 60,
  native_verified: 50,
  target_native_verified: 60,
  native_partial: 3,
  native_delegated: 2,
  bridge_ready: 12,
  available_recipes: 20,
  public_parity: true,
  native_parity: false,
  native_verification_parity: false,
  checks: [
    {
      key: "native-parity",
      label: "Native parity",
      state: "fail",
      severity: "blocker",
      count: 5,
      message: "Five native connectors remain.",
    },
  ],
  issues: [
    {
      key: "connector-gap",
      severity: "blocker",
      slug: "example",
      message: "Connector is not verified.",
      remediation: "Complete live verification.",
    },
  ],
  issue_counts: { "severity:blocker": 1 },
  recommendations: ["Complete live verification."],
};

describe("integrations readiness runtime contract", () => {
  it("accepts a complete readiness report", () => {
    expect(parseIntegrationsReadiness(readiness)).toEqual(readiness);
  });

  it("rejects partial successful responses and missing nested records", () => {
    expect(parseIntegrationsReadiness({ message: "ok" })).toBeNull();
    expect(
      parseIntegrationsReadiness({ ...readiness, issue_counts: undefined }),
    ).toBeNull();
    expect(
      parseIntegrationsReadiness({ ...readiness, checks: [{}] }),
    ).toBeNull();
  });

  it("rejects invalid counters and optional issue fields", () => {
    expect(
      parseIntegrationsReadiness({ ...readiness, native_verified: Number.NaN }),
    ).toBeNull();
    expect(
      parseIntegrationsReadiness({
        ...readiness,
        issues: [{ ...readiness.issues[0], slug: 42 }],
      }),
    ).toBeNull();
  });

  it("rejects oversized reports and duplicate readiness identities", () => {
    expect(
      parseIntegrationsReadiness({
        ...readiness,
        checks: [...readiness.checks, readiness.checks[0]],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsReadiness({
        ...readiness,
        issues: [...readiness.issues, readiness.issues[0]],
      }),
    ).toBeNull();
    expect(
      parseIntegrationsReadiness({
        ...readiness,
        recommendations: Array.from(
          { length: 257 },
          (_, index) => `Recommendation ${index}`,
        ),
      }),
    ).toBeNull();
    expect(
      parseIntegrationsReadiness({
        ...readiness,
        public_claim: "x".repeat(16_385),
      }),
    ).toBeNull();
  });
});
